/**
 * Admin boundary of Money Flow Sentinel: authorization, input validation and audit, over services/sentinel.
 *
 * Every parameter is validated to a scalar of a known shape before it reaches a query, so a crafted query string cannot
 * become a MongoDB operator. Severities, balances and statuses are never accepted from a client as facts: the only
 * things a client can state are a filter and a review decision, and a decision is checked against the current records.
 *
 * There is deliberately no import of a wallet, payment, refund or provisioning module here.
 */
import SentinelFinding, { FINDING_CLASSIFICATIONS, FINDING_REVIEWS, FINDING_SEVERITIES } from "../../models/SentinelFinding.js";
import { AdminServiceError, assertAdminUser } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { filterDate as date, filterMatching as matching, filterOneOf as oneOf, filterText as text, invalidFilter as invalid, parsePagination, requireReason, requireTelegramId } from "./validation.js";
import { FINDING_CATALOG, readSentinelConfig } from "../sentinel/constants.js";
import { explainFinding } from "../sentinel/explain.js";
import { REVIEW_TRANSITIONS, recordReview } from "../sentinel/findingsStore.js";
import { runGuardedTick } from "../sentinel/reconciler.js";
import { RANGES, getFinding, getFlow, getLiveEvents, getOverview, getSyncStatus, getTransaction, listFindings, listTransactions, revalidateFinding } from "../sentinel/queries.js";

const PROVIDERS = ["all", "hooshpay", "nowpayments", "bank", "trx", "wallet"];
const STATES = ["pending", "confirmed", "credited", "reserved", "review", "fulfilled", "refunded", "reversed", "failed"];
const STAGES = ["initiated", "confirmed", "credited", "reserved", "provisioning", "awaiting_provider", "fulfilled", "refund_requested", "refunded", "reversed", "failed"];
const CATEGORIES = ["payment", "wallet", "order", "refund", "transition", "stuck"];
const REFERENCE = /^[A-Za-z0-9_.:-]{1,128}$/;
const KEY = /^(hooshpay|nowpayments|bank|trx|wallet):[A-Za-z0-9_.-]{1,128}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const PAY_CURRENCY = /^[a-z0-9]{2,16}$/;
const MAX_AMOUNT = 100_000_000_000;

function amount(value, code) {
  const parsed = text(value, code);
  if (parsed == null) return null;
  if (!/^\d{1,12}$/.test(parsed) || Number(parsed) > MAX_AMOUNT) throw invalid(code);
  return Number(parsed);
}

function userFilter(value) {
  const parsed = text(value, "invalid_user_filter");
  return parsed == null ? null : requireTelegramId(parsed);
}

function amountRange(query) {
  const minAmount = amount(query.minAmount, "invalid_min_amount");
  const maxAmount = amount(query.maxAmount, "invalid_max_amount");
  if (minAmount != null && maxAmount != null && minAmount > maxAmount) throw invalid("invalid_amount_range");
  return { minAmount, maxAmount };
}

function requireObjectId(value) {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw invalid("invalid_finding_id", "Finding not found.");
  return value;
}

export async function getSentinelOverview({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  return getOverview({ range: oneOf(query.range, Object.keys(RANGES), "invalid_range", "7d") });
}

export async function getSentinelFlow({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  return getFlow({
    range: oneOf(query.range, Object.keys(RANGES), "invalid_range", "24h"),
    provider: oneOf(query.provider, PROVIDERS, "invalid_provider", "all"),
  });
}

export async function getSentinelLive({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const since = date(query.since, "invalid_since");
  const now = new Date();
  // The window is bounded so a stale cursor cannot ask for the whole history.
  const oldest = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  const { pageSize } = parsePagination({ pageSize: query.limit ?? 100 });
  return getLiveEvents({
    since: since && since < oldest ? oldest : since,
    limit: pageSize,
    provider: oneOf(query.provider, PROVIDERS, "invalid_provider", "all"),
    stage: oneOf(query.stage, STAGES, "invalid_stage"),
    userId: userFilter(query.userId),
    ...amountRange(query),
    now,
  });
}

export async function listSentinelTransactions({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { pageSize } = parsePagination(query);
  return listTransactions({
    pageSize,
    before: matching(query.before, OBJECT_ID, "invalid_cursor"),
    from: date(query.from, "invalid_from"),
    to: date(query.to, "invalid_to"),
    provider: oneOf(query.provider, PROVIDERS, "invalid_provider", "all"),
    state: oneOf(query.state, STATES, "invalid_state"),
    reference: matching(query.reference, REFERENCE, "invalid_reference"),
    payCurrency: matching(query.payCurrency, PAY_CURRENCY, "invalid_pay_currency"),
    severity: oneOf(query.severity, FINDING_SEVERITIES, "invalid_severity"),
    userId: userFilter(query.userId),
    ...amountRange(query),
  });
}

export async function getSentinelTransaction({ actorId, key } = {}) {
  assertAdminUser(actorId);
  if (typeof key !== "string" || !KEY.test(key)) throw invalid("invalid_transaction_key", "Transaction not found.");
  const transaction = await getTransaction({ key });
  if (!transaction) throw new AdminServiceError("Transaction not found.", { status: 404, code: "transaction_not_found" });
  return transaction;
}

export async function listSentinelFindings({ actorId, query = {} } = {}) {
  assertAdminUser(actorId);
  const { page, pageSize } = parsePagination(query);
  return listFindings({
    page,
    pageSize,
    classification: oneOf(query.classification, FINDING_CLASSIFICATIONS, "invalid_classification"),
    severity: oneOf(query.severity, FINDING_SEVERITIES, "invalid_severity"),
    category: oneOf(query.category, CATEGORIES, "invalid_category"),
    review: oneOf(query.review, FINDING_REVIEWS, "invalid_review"),
    state: oneOf(query.state, ["open", "cleared", "all"], "invalid_state", "open"),
    code: oneOf(query.code, Object.keys(FINDING_CATALOG), "invalid_code"),
    userId: userFilter(query.userId),
  });
}

export async function getSentinelFinding({ actorId, id } = {}) {
  assertAdminUser(actorId);
  const finding = await getFinding({ id: requireObjectId(id) });
  if (!finding) throw new AdminServiceError("Finding not found.", { status: 404, code: "finding_not_found" });
  return finding;
}

/**
 * Record a human decision about a finding. Changes SentinelFinding.review and nothing else: no balance, order or invoice.
 *   - "resolved" is refused while the records still reproduce the problem, so a note cannot make a discrepancy disappear;
 *   - "remediation_proposed" must name an option the server still offers for the current records. A proposal is a
 *     decision on record; the correction itself happens in the audited tool that option names.
 */
export async function updateSentinelFindingReview({ actorId, operationId, id, review, reason, optionId, ipAddress } = {}) {
  assertAdminUser(actorId);
  const findingId = requireObjectId(id);
  if (typeof review !== "string" || review === "new" || !FINDING_REVIEWS.includes(review)) throw invalid("invalid_review", "Choose a valid review status.");
  const safeReason = requireReason(reason, { min: 10, max: 400 });
  const safeOption = optionId == null || optionId === "" ? null : matching(optionId, /^[a-z_]{1,40}$/, "invalid_option");
  const row = await SentinelFinding.findById(findingId).lean().maxTimeMS(8_000);
  if (!row) throw new AdminServiceError("Finding not found.", { status: 404, code: "finding_not_found" });

  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "SENTINEL_FINDING_REVIEWED",
    targetType: "sentinel_finding",
    targetId: findingId,
    targetUserId: row.userId,
    ipAddress,
    metadata: { code: row.code, from: row.review, to: review, optionId: safeOption, reason: safeReason },
    execute: async () => {
      if (!(REVIEW_TRANSITIONS[row.review] || []).includes(review)) {
        throw new AdminServiceError("This finding cannot move to that status.", { status: 409, code: "review_transition_refused" });
      }
      const { match } = await revalidateFinding(row);
      if (review === "resolved" && match) {
        throw new AdminServiceError("The records still reproduce this problem, so it cannot be resolved yet.", { status: 409, code: "finding_still_reproduces" });
      }
      if (review === "remediation_proposed") {
        const offered = explainFinding(row).options.map((option) => option.id);
        if (!match) throw new AdminServiceError("The records no longer show this problem; there is nothing to propose.", { status: 409, code: "finding_no_longer_reproduces" });
        if (!safeOption || !offered.includes(safeOption)) throw invalid("invalid_option", "Choose one of the offered options.");
      }
      const updated = await recordReview({ id: findingId, from: row.review, to: review, actor: String(actorId), reason: safeReason, optionId: safeOption, operationId });
      if (!updated) throw new AdminServiceError("Another admin changed this finding first. Reload and try again.", { status: 409, code: "review_conflict" });
      return { ok: true, id: findingId, review: updated.review, stillReproduces: Boolean(match), auditSummary: { from: row.review, to: updated.review, stillReproduces: Boolean(match) } };
    },
  });
  return result;
}

/** Run detection now, for everyone in the usual bounded way or for one customer. Reads money, writes findings. */
export async function runSentinelReconciliation({ actorId, operationId, userId, ipAddress } = {}) {
  assertAdminUser(actorId);
  const config = readSentinelConfig();
  if (!config.enabled) throw new AdminServiceError("Sentinel is switched off on this server.", { status: 409, code: "sentinel_disabled" });
  const target = userFilter(userId ?? null);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "SENTINEL_RECONCILE_RUN",
    targetType: target ? "user" : "sentinel",
    targetId: target || "all",
    targetUserId: target,
    ipAddress,
    metadata: { scope: target ? "user" : "tick" },
    execute: async () => {
      const summary = await runGuardedTick({ config, trigger: "admin", budgetMs: 20_000, ...(target ? { userIds: [target] } : {}) });
      if (summary.error) throw new AdminServiceError("The check could not finish. Nothing was changed; try again shortly.", { status: 503, code: "sentinel_run_failed" });
      return {
        ok: true,
        skipped: summary.skipped ?? null,
        evaluated: summary.evaluated ?? 0,
        created: summary.created ?? 0,
        cleared: summary.cleared ?? 0,
        auditSummary: { skipped: summary.skipped ?? null, evaluated: summary.evaluated ?? 0, created: summary.created ?? 0, cleared: summary.cleared ?? 0 },
      };
    },
  });
  return result;
}

export async function getSentinelSync({ actorId } = {}) {
  assertAdminUser(actorId);
  return getSyncStatus();
}
