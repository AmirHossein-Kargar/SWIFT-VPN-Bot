import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import { observeJob } from "../reliability/telemetry.js";
import { applyNowPaymentsUpdate } from "./applyStatus.js";
import { notifyNowPaymentsCredit } from "./notify.js";
import { readNowPaymentsConfig } from "./money.js";
import { createNowPaymentsRequest } from "./nowpaymentsClient.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";
import { recoverCreationUnknownOrders } from "./creationLookup.js";

const RECOVERABLE = ["creation_unknown", "pending", "waiting", "confirming", "confirmed", "sending", "partially_paid", "finished"];

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "nowpayments-recovery", level, message, ...meta }),
  );
}

async function rows(model, filter) {
  const query = model.find(filter);
  if (typeof query?.limit === "function") return query.limit(25).lean();
  return query;
}

export async function reconcileNowPaymentsPayment({
  invoice,
  invoiceModel = NowPaymentsInvoice,
  request,
  env = process.env,
  apply = applyNowPaymentsUpdate,
} = {}) {
  if (!invoice || !/^[A-Za-z0-9_-]{1,64}$/.test(String(invoice.paymentId || ""))) {
    return { outcome: "unresolved", credited: false };
  }
  const config = readNowPaymentsConfig(env);
  if (!config) return { outcome: "not_configured", credited: false };
  const call = request || createNowPaymentsRequest({ apiKey: config.apiKey, baseURL: config.baseURL });
  const response = await call({ method: "GET", path: `/payment/${encodeURIComponent(invoice.paymentId)}` });
  if (!response || response.status < 200 || response.status >= 300 || !response.data || typeof response.data !== "object") {
    return { outcome: "provider_unavailable", credited: false };
  }
  return apply({ payload: response.data, invoiceModel });
}

/**
 * Reconcile durable NOWPayments records through authenticated GET /payment/:id.
 * A timed-out create without a payment_id remains explicit manual recovery: the
 * bot neither retries POST /invoice nor guesses failed/successful.
 */
export async function recoverNowPaymentsInvoices({
  invoiceModel = NowPaymentsInvoice,
  request,
  env = process.env,
  now = new Date(),
  apply = applyNowPaymentsUpdate,
  notify = notifyNowPaymentsCredit,
  bot = null,
} = {}) {
  const cutoff = new Date(now.getTime() - 2 * 60_000);

  // No provider request was attempted: this draft is definitively local-only.
  const neverAttempted = await rows(invoiceModel, {
    status: "creating",
    apiAttemptedAt: null,
    createdAt: { $lt: cutoff },
  });
  for (const invoice of neverAttempted || []) {
    await invoiceModel.updateOne(
      { orderId: invoice.orderId, status: "creating", apiAttemptedAt: null },
      {
        $set: { status: "creation_failed", recoveryStatus: "none", recoveryReason: null, updatedAt: now },
        $unset: { openCreateKey: 1, nextRetryAt: 1 },
      },
    );
  }

  // The process may have died after sending POST /invoice. Preserve and block
  // it as unknown; retrying creation could create a second remote invoice.
  const attempted = await rows(invoiceModel, {
    status: "creating",
    apiAttemptedAt: { $ne: null },
    createdAt: { $lt: cutoff },
  });
  for (const invoice of attempted || []) {
    await invoiceModel.updateOne(
      { orderId: invoice.orderId, status: "creating", apiAttemptedAt: { $ne: null } },
      {
        $set: {
          status: "creation_unknown",
          recoveryStatus: "required",
          recoveryReason: "process_stopped_after_provider_request",
          nextRetryAt: new Date(now.getTime() + 2 * 60_000),
          updatedAt: now,
        },
      },
    );
  }

  const unresolvedRows = await rows(invoiceModel, {
    status: "creation_unknown",
    paymentId: { $in: [null, ""] },
  });
  const unresolved = (unresolvedRows || []).length;

  const notifications = await rows(invoiceModel, {
    status: "finished",
    balanceCredited: true,
    notificationPending: true,
  });
  for (const invoice of notifications || []) {
    try { await notify(invoice.orderId, bot); } catch { /* durable outbox retries next cycle */ }
  }

  const config = readNowPaymentsConfig(env);
  if (!config) return { recovered: 0, unresolved, errors: 0, skipped: "not_configured" };
  const call = request || createNowPaymentsRequest({ apiKey: config.apiKey, baseURL: config.baseURL });

  // Orders whose invoice may exist remotely but was never recorded: ask the provider (authenticated
  // payment list) whether a payment exists for them. Needs the JWT credentials; never releases the lock.
  let creationLookup = null;
  if (config.hasCustodyAuth) {
    try {
      creationLookup = await recoverCreationUnknownOrders({ invoiceModel, env, request, apply, notify, bot, now });
    } catch (error) {
      log("warn", "creation_unknown lookup failed", { errorType: error?.name || "Error" });
    }
  }

  const pending = await rows(invoiceModel, {
    paymentId: { $nin: [null, ""] },
    balanceCredited: false,
    status: { $in: RECOVERABLE },
  });
  let recovered = 0;
  let errors = 0;
  for (const invoice of pending || []) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(invoice.paymentId || ""))) continue;
    try {
      const result = await reconcileNowPaymentsPayment({
        invoice,
        invoiceModel,
        request: call,
        env,
        apply,
      });
      if (result.outcome === "provider_unavailable") {
        errors += 1;
        continue;
      }
      if (result.credited) {
        recovered += 1;
        try { await notify(result.orderId || invoice.orderId, bot); } catch { /* durable outbox retries next cycle */ }
      }
      if (["invalid_payload", "invalid_status", "unknown_order", "amount_mismatch", "invoice_mismatch", "payment_id_mismatch", "order_mismatch", "missing_provider_id", "provider_id_conflict"].includes(result.outcome)) {
        errors += 1;
        await invoiceModel.updateOne(
          { orderId: invoice.orderId },
          { $set: { recoveryStatus: "required", recoveryReason: `provider_lookup_${result.outcome}`, updatedAt: now } },
        );
      }
    } catch (error) {
      errors += 1;
      log("warn", "Payment status reconciliation failed", {
        orderId: invoice.orderId,
        errorType: error?.name || "Error",
        code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
      });
    }
  }

  return { recovered, unresolved, errors, ...(creationLookup ? { creationLookup } : {}) };
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
    if (!lease) { observeJob("nowpayments-recovery", { ok: true, skipped: "lease" }); return; }
    let bot = null;
    try {
      const module = await import("../../config/botInstance.js");
      bot = module.default?.bot || null;
    } catch { /* notification remains pending */ }
    await recoverNowPaymentsInvoices({ bot });
    observeJob("nowpayments-recovery", { ok: true });
  } catch (error) {
    observeJob("nowpayments-recovery", { ok: false });
    log("warn", "Recovery cycle skipped", { errorType: error?.name || "Error" });
  } finally {
    if (lease) {
      try { await releaseRedisLease(lease, { timeoutMs: 2_000 }); } catch { /* lease expires */ }
    }
    active = false;
  }
}
