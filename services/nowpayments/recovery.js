import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import { applyNowPaymentsUpdate } from "./applyStatus.js";
import { readNowPaymentsConfig } from "./money.js";
import { createNowPaymentsRequest } from "./nowpaymentsClient.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";

const RECOVERABLE = ["pending", "waiting", "confirming", "confirmed", "sending", "finished"];

async function rows(model, filter) {
  const query = model.find(filter);
  if (typeof query?.limit === "function") return query.limit(25).lean();
  return query;
}

export async function recoverNowPaymentsInvoices({
  invoiceModel = NowPaymentsInvoice,
  request,
  env = process.env,
  now = new Date(),
  apply = applyNowPaymentsUpdate,
} = {}) {
  const cutoff = new Date(now.getTime() - 2 * 60_000);
  const stale = await rows(invoiceModel, { status: "creating", apiAttemptedAt: null, createdAt: { $lt: cutoff } });
  for (const invoice of stale || []) {
    await invoiceModel.updateOne({ orderId: invoice.orderId, status: "creating", apiAttemptedAt: null }, {
      $set: { status: "creation_failed", updatedAt: now },
      $unset: { openCreateKey: 1 },
    });
  }

  const config = readNowPaymentsConfig(env);
  if (!config) return { recovered: 0, skipped: "not_configured" };
  const call = request || createNowPaymentsRequest({ apiKey: config.apiKey, baseURL: config.baseURL });
  const pending = await rows(invoiceModel, {
    paymentId: { $nin: [null, ""] },
    balanceCredited: false,
    status: { $in: RECOVERABLE },
  });
  let recovered = 0;
  for (const invoice of pending || []) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(invoice.paymentId || ""))) continue;
    const response = await call({ method: "GET", path: `/payment/${encodeURIComponent(invoice.paymentId)}` });
    if (!response || response.status < 200 || response.status >= 300 || !response.data || typeof response.data !== "object") continue;
    const payload = { ...response.data, order_id: response.data.order_id || invoice.orderId };
    const result = await apply({ payload, invoiceModel });
    if (result.credited) recovered += 1;
  }
  return { recovered };
}

let timer = null;
let active = false;

export function startNowPaymentsRecoveryCron() {
  if (timer) return;
  timer = setInterval(() => { void runSafely(); }, 2 * 60_000);
  timer.unref?.();
  void runSafely();
}

export function stopNowPaymentsRecoveryCron() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function runSafely() {
  if (active) return;
  active = true;
  let lease = null;
  try {
    lease = await acquireRedisLease("nowpayments:recovery", 180, { timeoutMs: 2_000 });
    if (!lease) return;
    await recoverNowPaymentsInvoices();
  } catch (error) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      service: "nowpayments-recovery",
      level: "warn",
      message: "Recovery cycle skipped",
      errorType: error?.name || "Error",
    }));
  } finally {
    if (lease) {
      try { await releaseRedisLease(lease, { timeoutMs: 2_000 }); } catch { /* lease expires */ }
    }
    active = false;
  }
}
