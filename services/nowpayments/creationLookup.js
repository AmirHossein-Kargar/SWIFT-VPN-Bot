import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import { applyNowPaymentsUpdate } from "./applyStatus.js";
import { notifyNowPaymentsCredit } from "./notify.js";
import { readNowPaymentsConfig } from "./money.js";
import { createNowPaymentsClient } from "./nowpaymentsClient.js";

/**
 * Provider-side evidence for an order stuck in `creation_unknown`.
 *
 * The official reference has no "get invoice" endpoint. The only authenticated lookup is
 * GET /v1/payment/ (JWT + API key), filterable by `invoiceId` or by date, whose items carry
 * `invoice_id`, `order_id`, `price_*`, `pay_*` and `payment_status`. So this can PROVE that a
 * payment exists for the order, and then hands it to the normal verifier (applyNowPaymentsUpdate:
 * order, invoice, amount, currency, crypto amount, idempotent claim, ledger key). It can NEVER
 * prove that an unpaid invoice does not exist, so "nothing found" is not a reason to release the
 * create-lock; that stays an explicit, audited admin decision.
 *
 * Which fields correlate a payment with the order (documented contract, GET /v1/payment/):
 *   - `invoice_id` is documented ("the invoice ID from which the payment was created") and
 *     `invoiceId` is a documented filter: this is the reliable key, and it is the invoice id the
 *     provider itself returned when the invoice was created.
 *   - `order_id` is in the response schema but every documented sample has it null, so it is NOT
 *     assumed to be returned. It is only trusted when present and equal to our unguessable uuid.
 * A payment tied to our invoice whose `order_id` is absent therefore never auto-settles (the verifier
 * requires the order id) and never lets the lock go: it is `lookup_unconfirmed`, held for a human.
 * With no recorded invoice id the only key left is `order_id`, so an empty result proves nothing
 * (`conclusive: false`): absence can then never be treated as verified.
 *
 * Outcomes (none of them credits by itself):
 *   payment_applied      exactly one provider payment matched invoice AND order; the normal verifier ran
 *   no_payment_found     all pages read, nothing for this order (`conclusive` says whether invoiceId was the key)
 *   lookup_unavailable   not configured (no JWT credentials), auth/HTTP/timeout failure, or malformed body
 *   lookup_ambiguous     more pages than we read, paging that does not advance, or several payments
 *   lookup_mismatch      a payment carries our invoice id under another order id (or the reverse)
 *   lookup_unconfirmed   a payment carries our invoice id but the provider did not return an order_id
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const RECHECK_MS = 10 * 60_000;
const WINDOW_LEAD_MS = 5 * 60_000;
const BATCH = 10;

function idText(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
}

function paymentItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  return null;
}

function failure(code) {
  return { outcome: "lookup_unavailable", credited: false, code };
}

export async function lookupCreationUnknown({
  invoice,
  client,
  invoiceModel = NowPaymentsInvoice,
  apply = applyNowPaymentsUpdate,
  now = new Date(),
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES,
} = {}) {
  if (!invoice?.orderId || !client || typeof client.listPayments !== "function") return failure("lookup_not_configured");
  const invoiceId = idText(invoice.invoiceId);
  const collected = [];
  const seenPaymentIds = new Set();
  let truncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    let response;
    try {
      response = await client.listPayments({
        limit: pageSize,
        page,
        sortBy: "created_at",
        orderBy: "asc",
        ...(invoiceId
          ? { invoiceId }
          : {
              dateFrom: new Date(new Date(invoice.createdAt || now).getTime() - WINDOW_LEAD_MS).toISOString(),
              dateTo: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
            }),
      });
    } catch (error) {
      return failure(typeof error?.code === "string" ? error.code.slice(0, 60) : "lookup_error");
    }
    const items = paymentItems(response?.data);
    if (!items) return failure("lookup_malformed");
    // A provider that ignores `page` would hand back the same rows forever: never read that as "complete".
    const ids = items.map((item) => idText(item?.payment_id)).filter(Boolean);
    if (page > 0 && ids.length > 0 && ids.every((id) => seenPaymentIds.has(id))) return { outcome: "lookup_ambiguous", credited: false, code: "pagination_not_advancing" };
    ids.forEach((id) => seenPaymentIds.add(id));
    collected.push(...items);
    if (items.length < pageSize) break;
    if (page === maxPages - 1) truncated = true;
  }

  const related = [];
  const unconfirmed = [];
  for (const item of collected) {
    if (!item || typeof item !== "object") continue;
    const itemOrder = item.order_id == null || item.order_id === "" ? null : String(item.order_id);
    const itemInvoice = idText(item.invoice_id);
    if (invoiceId != null) {
      if (itemInvoice !== invoiceId && itemOrder !== invoice.orderId) continue; // unrelated payment
      if (itemInvoice === invoiceId && itemOrder === invoice.orderId) related.push(item);
      else if (itemInvoice === invoiceId && itemOrder == null) unconfirmed.push(item);
      else return { outcome: "lookup_mismatch", credited: false, code: "order_invoice_disagree" };
    } else {
      if (itemOrder !== invoice.orderId) continue;
      if (itemInvoice == null) unconfirmed.push(item); // cannot bind an invoice id: the verifier would refuse it anyway
      else related.push(item);
    }
  }

  if (unconfirmed.length > 0) {
    return { outcome: "lookup_unconfirmed", credited: false, code: "order_id_not_returned", paymentRef: idText(unconfirmed[0].payment_id) };
  }
  if (related.some((item) => !idText(item.payment_id))) return { outcome: "lookup_mismatch", credited: false, code: "missing_payment_id" };
  const paymentIds = [...new Set(related.map((item) => idText(item.payment_id)))];
  if (paymentIds.length > 1) return { outcome: "lookup_ambiguous", credited: false, code: "multiple_payments" };
  if (paymentIds.length === 0) {
    if (truncated) return { outcome: "lookup_ambiguous", credited: false, code: "result_truncated" };
    // Only the documented invoiceId filter makes "nothing found" mean "no payment for this invoice".
    return { outcome: "no_payment_found", credited: false, conclusive: invoiceId != null };
  }

  const applied = await apply({ payload: related[related.length - 1], invoiceModel });
  return { ...applied, outcome: "payment_applied", appliedOutcome: applied?.outcome };
}

/**
 * Cron step: look up every due `creation_unknown` order that has no payment bound yet.
 * Needs the JWT credentials (NOWPAYMENTS_EMAIL / NOWPAYMENTS_PASSWORD); without them it does
 * nothing and the orders stay locked and visible in the admin recovery queue.
 */
export async function recoverCreationUnknownOrders({
  invoiceModel = NowPaymentsInvoice,
  env = process.env,
  request = null,
  client: injectedClient = null,
  apply = applyNowPaymentsUpdate,
  notify = notifyNowPaymentsCredit,
  bot = null,
  now = new Date(),
  limit = BATCH,
} = {}) {
  const summary = { checked: 0, applied: 0, credited: 0, unavailable: 0, ambiguous: 0, mismatched: 0, unconfirmed: 0, notFound: 0, skipped: null };
  let client = injectedClient;
  if (!client) {
    const config = readNowPaymentsConfig(env);
    if (!config?.hasCustodyAuth) return { ...summary, skipped: "lookup_not_configured" };
    client = createNowPaymentsClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      email: config.email,
      password: config.password,
      request,
    });
  }

  const query = invoiceModel.find({
    status: "creation_unknown",
    balanceCredited: false,
    paymentId: { $in: [null, ""] },
    $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }],
  });
  const due = typeof query?.limit === "function" ? await query.limit(limit).lean() : await query;

  for (const invoice of due || []) {
    summary.checked += 1;
    let result;
    try {
      result = await lookupCreationUnknown({ invoice, client, invoiceModel, apply, now });
    } catch (error) {
      result = failure(typeof error?.code === "string" ? error.code.slice(0, 60) : "lookup_error");
    }
    const stamp = {
      lastRetryAt: now,
      nextRetryAt: new Date(now.getTime() + RECHECK_MS),
      lastErrorCode: result.outcome === "payment_applied" ? null : String(result.outcome === "no_payment_found" ? (result.conclusive === false ? "no_payment_found_unverifiable" : "no_payment_found") : (result.code || result.outcome)).slice(0, 80),
      updatedAt: now,
    };
    if (result.outcome === "payment_applied") summary.applied += 1;
    if (result.credited) summary.credited += 1;
    if (result.outcome === "lookup_unavailable") summary.unavailable += 1;
    if (result.outcome === "no_payment_found") summary.notFound += 1;
    if (result.outcome === "lookup_ambiguous") summary.ambiguous += 1;
    if (result.outcome === "lookup_mismatch") summary.mismatched += 1;
    if (result.outcome === "lookup_unconfirmed") summary.unconfirmed += 1;

    // Bookkeeping only while the order is still unresolved; never touches money or status.
    const flag = ["lookup_ambiguous", "lookup_mismatch", "lookup_unconfirmed"].includes(result.outcome)
      ? { recoveryStatus: "required", recoveryReason: `provider_lookup_${result.outcome.replace("lookup_", "")}:${result.code}${result.paymentRef ? `:pay=${result.paymentRef}` : ""}`.slice(0, 200) }
      : {};
    await invoiceModel.updateOne(
      { orderId: invoice.orderId, status: "creation_unknown", balanceCredited: false },
      { $set: { ...stamp, ...flag }, $inc: { retryCount: 1 } },
    );

    if (result.credited || result.notificationPending) {
      try { await notify(result.orderId || invoice.orderId, bot); } catch { /* durable outbox retries next cycle */ }
    }
  }
  return summary;
}
