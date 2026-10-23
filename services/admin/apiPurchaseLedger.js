/**
 * Durable ledger for admin-initiated WizardXray ("API") purchases.
 *
 * The provider's /create call has no idempotency key and no lookup by request, so after a crash or an
 * ambiguous response nobody can know from the code alone whether a service was created. That uncertainty is
 * therefore recorded durably (an AdminAuditLog row written BEFORE the provider is contacted) and stays
 * "unresolved" until an authorized admin explicitly attests the real outcome, which is itself audited.
 *
 *   - NO age-based expiry: a row is unresolved until a SUCCESSFULLY PERSISTED, VALID resolution row exists, however old
 *     the purchase is. A resolution row that is started, failed, interrupted or malformed never counts.
 *   - The unique operationId makes the claim atomic across processes. A resolution is ONE insert that is already
 *     `succeeded` (there is no intermediate state that can be left half-written), so it either exists durably or not at
 *     all, and at most one can ever exist per purchase.
 *   - Nothing here ever contacts the provider or retries a purchase.
 */
import { randomBytes } from "node:crypto";
import AdminAuditLog from "../../models/AdminAuditLog.js";
import { sanitizeAuditValue } from "./audit.js";
import { AdminServiceError, assertAdminUser } from "./authorization.js";

export const API_PURCHASE_ACTION = "API_SERVICE_PURCHASE";
export const API_PURCHASE_RESOLVED_ACTION = "API_SERVICE_PURCHASE_RESOLVED";
/** errorCode of a purchase whose provider outcome could not be determined. */
export const API_PURCHASE_UNKNOWN_CODE = "API_PURCHASE_OUTCOME_UNKNOWN";
export const API_PURCHASE_OUTCOMES = Object.freeze({ created: "service_created", none: "no_service" });
/** errorCode of a purchase the provider definitely rejected (see isDefiniteProviderFailure). */
export const API_PURCHASE_REJECTED_CODE = "API_PURCHASE_REJECTED";
/** errorCode of a purchase stopped before the provider was contacted. */
export const API_PURCHASE_NOT_CLAIMED_CODE = "API_PURCHASE_NOT_CLAIMED";
/**
 * The ONLY failed outcomes proven to mean "nothing was created". Anything else - a started row, an interrupted
 * row, or a failed row with any other code (including arbitrary database or network error codes written when a
 * ledger update failed after the provider call) - may hide a paid service and stays unresolved.
 */
export const API_PURCHASE_DEFINITE_CODES = Object.freeze([API_PURCHASE_REJECTED_CODE, API_PURCHASE_NOT_CLAIMED_CODE]);

const PURCHASE_ID = /^[0-9a-f]{20}$/;
const SCAN_LIMIT = 50;

/** 20 hex chars: short enough that the audit sanitizer never redacts it as a token. */
export function newPurchaseId() {
  return randomBytes(10).toString("hex");
}

export function isPurchaseId(value) {
  return typeof value === "string" && PURCHASE_ID.test(value);
}

/** A purchase row whose outcome is proven: it succeeded, or failed with a code that proves nothing was created. */
export function isSettledPurchaseRow(row) {
  return row?.status === "succeeded"
    || (row?.status === "failed" && API_PURCHASE_DEFINITE_CODES.includes(row.errorCode));
}

/** Everything else is unsettled, whatever its status or error code. */
export function isUnsettledPurchaseRow(row) {
  return row?.action === API_PURCHASE_ACTION && !isSettledPurchaseRow(row);
}

export const purchaseOperationId = (purchaseId) => `APIBUY-${purchaseId}`;
export const resolveOperationId = (purchaseId) => `APIRES-${purchaseId}`;

/**
 * A reconciliation that really happened: a persisted `succeeded` row of the resolve action, under the purchase's own
 * resolve operationId, with a recognised outcome. Anything else (started, failed, interrupted, wrong key, missing or
 * unknown outcome) is NOT a resolution.
 */
export function isValidResolutionRow(row) {
  return row?.action === API_PURCHASE_RESOLVED_ACTION
    && row.status === "succeeded"
    && isPurchaseId(row.targetId)
    && row.operationId === resolveOperationId(row.targetId)
    && Object.values(API_PURCHASE_OUTCOMES).includes(row.metadata?.outcome);
}

/**
 * Purchases whose outcome is not proven, and not yet resolved by an admin. Oldest first. This is an allowlist:
 * only `succeeded` and `failed` with a definite code (API_PURCHASE_DEFINITE_CODES) are settled, so every other
 * status or error code blocks. A purchase counts as resolved only when a VALID, `succeeded` resolution row exists
 * (isValidResolutionRow). Throws if the ledger cannot be read, so callers fail closed.
 */
export async function findUnresolvedApiPurchases({ auditModel = AdminAuditLog } = {}) {
  const [open, failedOther] = await Promise.all([
    auditModel.find({ action: API_PURCHASE_ACTION, status: { $nin: ["succeeded", "failed"] } }).sort({ createdAt: 1 }).limit(SCAN_LIMIT).lean(),
    auditModel.find({ action: API_PURCHASE_ACTION, status: "failed", errorCode: { $nin: API_PURCHASE_DEFINITE_CODES } }).sort({ createdAt: 1 }).limit(SCAN_LIMIT).lean(),
  ]);
  const candidates = [...open, ...failedOther].filter((row) => isUnsettledPurchaseRow(row) && isPurchaseId(row?.targetId));
  if (!candidates.length) return [];
  const ids = [...new Set(candidates.map((row) => row.targetId))];
  const resolutions = await auditModel
    .find({ action: API_PURCHASE_RESOLVED_ACTION, status: "succeeded", targetId: { $in: ids } })
    .select("targetId operationId action status metadata")
    .lean();
  const done = new Set(resolutions.filter(isValidResolutionRow).map((row) => row.targetId));
  return candidates
    .filter((row) => !done.has(row.targetId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((row) => ({ purchaseId: row.targetId, status: row.status, createdAt: row.createdAt }));
}

/** Reconciliation state could not be written or verified: the purchase stays blocked and recovery is needed. */
function unverified(cause) {
  const error = new AdminServiceError("The reconciliation could not be recorded or verified; the purchase stays blocked. Try again.", { status: 503, code: "resolution_unverified" });
  if (cause) error.cause = cause;
  return error;
}

async function guarded(operation) {
  try { return await operation(); } catch (cause) { throw unverified(cause); }
}

/** Rows an earlier (two-phase) attempt may have left behind. They are not resolutions and may be taken over. */
const RECOVERABLE_STATUSES = Object.freeze(["started", "failed", "interrupted"]);

/**
 * Explicit, audited recovery. The admin states what they verified on the provider's panel; the attestation is a
 * separate audit event (actor, timestamp, outcome) that never touches the original purchase row. It never contacts the
 * provider and never infers an outcome.
 *
 * Atomicity: the resolution is a single insert whose unique operationId is the claim, written already `succeeded`.
 *   - Concurrent admins / processes: exactly one insert wins; every other caller reads back and reports the stored
 *     outcome, so two different outcomes can never both be recorded.
 *   - A row under that key that is not a valid resolution (an interrupted or failed earlier attempt) is recovered with
 *     ONE conditional update keyed on its exact current status; only one recoverer can win it, the others re-read.
 *   - A succeeded row that is malformed is never rewritten: that needs manual recovery and fails closed.
 *   - The result is re-read from the database; if it cannot be verified, the call fails and the purchase stays blocked.
 */
export async function resolveApiPurchase({ actorId, purchaseId, outcome, ipAddress = null, auditModel = AdminAuditLog, now = () => new Date() } = {}) {
  const actor = assertAdminUser(actorId);
  if (!isPurchaseId(purchaseId)) throw new AdminServiceError("Invalid purchase reference.", { status: 400, code: "invalid_purchase_reference" });
  if (!Object.values(API_PURCHASE_OUTCOMES).includes(outcome)) {
    throw new AdminServiceError("Invalid outcome.", { status: 400, code: "invalid_outcome" });
  }
  const purchase = await guarded(() => auditModel.findOne({ operationId: purchaseOperationId(purchaseId) }));
  if (!isUnsettledPurchaseRow(purchase)) {
    throw new AdminServiceError("This purchase is not awaiting reconciliation.", { status: 409, code: "purchase_not_unresolved" });
  }

  const operationId = resolveOperationId(purchaseId);
  const at = now();
  const event = {
    actorTelegramId: String(actor),
    ipAddress: ipAddress ? String(ipAddress).slice(0, 64) : null,
    status: "succeeded",
    errorCode: null,
    completedAt: at,
    result: sanitizeAuditValue({ outcome }),
  };

  let recoveredFrom = null;
  try {
    await auditModel.create({
      operationId,
      action: API_PURCHASE_RESOLVED_ACTION,
      targetType: "api_purchase",
      targetId: purchaseId,
      metadata: sanitizeAuditValue({ outcome, originalStatus: purchase.status }),
      createdAt: at,
      ...event,
    });
  } catch (error) {
    if (error?.code !== 11000) throw unverified(error);
    const existing = await guarded(() => auditModel.findOne({ operationId }));
    if (!existing) throw unverified();
    if (!isValidResolutionRow(existing)) {
      // Not a resolution. Only a non-succeeded leftover of an interrupted attempt may be recovered, atomically.
      if (!RECOVERABLE_STATUSES.includes(existing.status) || existing.action !== API_PURCHASE_RESOLVED_ACTION || existing.targetId !== purchaseId) {
        throw unverified();
      }
      const taken = await guarded(() => auditModel.updateOne(
        { _id: existing._id, action: API_PURCHASE_RESOLVED_ACTION, status: existing.status },
        {
          $set: {
            ...event,
            metadata: sanitizeAuditValue({
              outcome,
              originalStatus: purchase.status,
              recovered: true,
              recoveredFrom: existing.status,
              previousActor: existing.actorTelegramId ?? null,
              previousOutcome: existing.metadata?.outcome ?? null,
            }),
          },
        },
      ));
      if (taken?.modifiedCount === 1) recoveredFrom = existing.status;
    }
  }

  // Report what the database really holds, never merely what was asked or attempted.
  const stored = await guarded(() => auditModel.findOne({ operationId }));
  if (!isValidResolutionRow(stored) || stored.targetId !== purchaseId) throw unverified();
  const persisted = stored.metadata.outcome;
  return { purchaseId, outcome: persisted, requestedOutcome: outcome, matchesRequest: persisted === outcome, recovered: recoveredFrom !== null };
}
