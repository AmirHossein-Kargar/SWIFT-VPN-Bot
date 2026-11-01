import { randomUUID } from "node:crypto";
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { getSellablePlanById, isProductReferencable } from "../plans.js";
import { createVpnService } from "../../api/wizardApi.js";
import { subscriptionLink, validSubscriptionLink } from "../subscriptionLink.js";
import { isValidCatalogTraffic } from "../../utils/serviceTerms.js";
import {
  commitProvisionedPurchase,
  refundPurchaseReservation,
  reserveBalance,
} from "./purchaseLedger.js";
import { withTelemetryContext } from "../reliability/telemetry.js";

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const HASH_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export class PurchaseServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PurchaseServiceError";
    this.code = code;
  }
}

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "customer-purchase", level, message, ...meta })
  );
}

function normalizeTelegramId(userId) {
  const telegramId = String(userId ?? "").trim();
  if (!/^\d{1,32}$/.test(telegramId)) {
    throw new PurchaseServiceError("A valid Telegram user ID is required", "INVALID_USER_ID");
  }
  return telegramId;
}

function normalizePurchaseId(value) {
  const purchaseId = value == null ? randomUUID() : String(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(purchaseId)) {
    throw new PurchaseServiceError("A valid purchase identifier is required", "INVALID_PURCHASE_ID");
  }
  return purchaseId;
}

function safeErrorCode(error, fallback = "PROVIDER_ERROR") {
  const code = typeof error?.code === "string" && SAFE_ERROR_CODE_PATTERN.test(error.code)
    ? error.code
    : fallback;
  return code.toUpperCase().slice(0, 80);
}

function validSingleLink(value) {
  if (typeof value !== "string" || value.length > 4096) return "";
  return /^(?:https|vless|vmess|trojan|ss):\/\//i.test(value) ? value : "";
}

/**
 * Validate and whitelist the fields needed by the application. Provider fields
 * such as internal balance/cost are never copied to a purchase or returned.
 */
function normalizeProvisioningResponse(response) {
  const result = response?.result;
  const service = result?.service && typeof result.service === "object" ? result.service : null;
  const username = result?.username;
  const hash = typeof result?.hash === "string" && HASH_PATTERN.test(result.hash) ? result.hash : null;
  const serviceLink = validSubscriptionLink(result?.sub_link) ?? validSubscriptionLink(service?.sub_link);
  if (response?.ok !== true || !result || typeof result !== "object" || Array.isArray(result)
      || typeof username !== "string" || !USERNAME_PATTERN.test(username)
      || (!hash && !serviceLink)) {
    const error = new Error("WizardXray returned an invalid service response");
    error.name = "InvalidProviderResponseError";
    error.code = "INVALID_PROVIDER_RESPONSE";
    // A create response with invalid shape can still mean the provider created
    // something. Do not replay it or auto-refund an ambiguous external mutation.
    error.ambiguous = true;
    throw error;
  }

  const links = Array.isArray(result.tak_links) ? result.tak_links : Array.isArray(service?.links) ? service.links : [];
  const singleLink = links.length ? validSingleLink(links[0]) : "";
  const expirySeconds = Number(service?.expire ?? result.expiryTime);
  return { username, hash, serviceLink, singleLink, expiresAt: Number.isFinite(expirySeconds) && expirySeconds > 0 ? new Date(expirySeconds * 1000) : null };
}

function customerServiceInfo(purchase) {
  if (purchase?.status !== "completed") return null;
  return {
    username: purchase.serviceUsername,
    subscriptionUrl: subscriptionLink({ link: purchase.serviceLink, hash: purchase.serviceHash }),
    singleLink: validSingleLink(purchase.singleLink),
    expiresAt: purchase.expiresAt || null,
  };
}

function publicResult(purchase, plan, { replayed = false, failure = null } = {}) {
  return {
    purchaseId: purchase.purchaseId,
    status: purchase.status,
    plan: { ...plan },
    service: customerServiceInfo(purchase),
    replayed,
    failure,
  };
}

function failureFor(purchase) {
  if (purchase.status === "failed") {
    if (purchase.errorCode === "INSUFFICIENT_BALANCE") return "insufficient_balance";
    if (purchase.errorCode === "USER_NOT_FOUND") return "user_not_found";
    return "purchase_failed";
  }
  if (purchase.status === "awaiting_provider") return "awaiting_provider_funds";
  if (purchase.status === "refunded") return "provider_rejected_refunded";
  if (purchase.status === "refund_pending") return "refund_pending";
  if (["manual_review", "uncertain"].includes(purchase.status)) return "provider_outcome_unknown";
  if (purchase.status === "provisioned") return "fulfillment_pending";
  if (["reserving", "reserved", "provisioning"].includes(purchase.status)) return "processing";
  return null;
}

async function findPurchase(purchaseModel, purchaseId) {
  return purchaseModel.findOne({ purchaseId }).lean();
}

async function existingPurchaseResult(purchaseModel, purchaseId, telegramId, plan) {
  const existing = await findPurchase(purchaseModel, purchaseId);
  if (!existing) return null;
  if (String(existing.telegramId) !== telegramId || String(existing.planId) !== plan.id) {
    throw new PurchaseServiceError("Purchase identifier is already associated with another request", "PURCHASE_ID_CONFLICT");
  }
  return publicResult(existing, plan, { replayed: true, failure: failureFor(existing) });
}

/** Only an explicit, non-ambiguous panel refusal with the insufficient-balance category qualifies. */
function isProviderFundsShortage(error) {
  return error?.code === "provider_insufficient_balance" && error.ambiguous !== true;
}

const EVENT_LIMIT = 50;

/**
 * provisioning -> awaiting_provider, persisting the admin-alert outbox flag in the same atomic update. The customer
 * notice is queued only for the first park: an admin approval that finds the provider still short changes nothing the
 * customer was told, so it must not message them again.
 */
async function parkForProviderFunds(purchaseModel, purchaseId, { notifyCustomer }) {
  return purchaseModel.findOneAndUpdate(
    { purchaseId, status: "provisioning" },
    {
      $set: {
        status: "awaiting_provider",
        awaitingProviderSince: new Date(),
        errorCode: "PROVIDER_INSUFFICIENT_BALANCE",
        recoveryStatus: "none",
        recoveryReason: null,
        adminAlertPending: true,
        adminAlertNextAt: null,
        adminAlertClaimedAt: null,
        adminAlertAttempts: 0,
        ...(notifyCustomer ? { customerNoticePending: true } : {}),
      },
      $unset: { recoveryClaimedAt: 1 },
      $push: { events: { $each: [{ at: new Date(), type: "provider_funds_short", from: "provisioning", to: "awaiting_provider" }], $slice: -EVENT_LIMIT } },
    },
    { new: true }
  );
}

async function persistReservationState(purchaseModel, purchaseId, telegramId, amount, now) {
  try {
    const reserved = await purchaseModel.findOneAndUpdate(
      { purchaseId, status: "reserving" },
      {
        $set: {
          status: "reserved",
          walletDebitStatus: "reserved",
          walletDebitedAt: now,
          reservedAt: now,
        },
      },
      { new: true }
    );
    if (reserved) return reserved;
  } catch {
    // Resolve the result below. The user's atomic reservation key is the source
    // of truth if Mongo applied the update but this process lost its response.
  }
  const current = await purchaseModel.findOne({ purchaseId, telegramId }).lean();
  return current?.status === "reserved" ? current : null;
}

async function markRecoveryRequired(purchaseModel, purchaseId, reason) {
  await purchaseModel.updateOne(
    { purchaseId, status: { $in: ["reserving", "reserved", "provisioning", "provisioned", "refund_pending"] } },
    { $set: { recoveryStatus: "required", recoveryReason: reason } }
  ).catch(() => {});
}

async function markAmbiguousProviderResult(purchaseModel, purchaseId, errorCode) {
  let updated = null;
  try {
    updated = await purchaseModel.findOneAndUpdate(
      { purchaseId, status: "provisioning" },
      {
        $set: {
          status: "manual_review",
          errorCode,
          recoveryStatus: "required",
          recoveryReason: errorCode,
        },
      },
      { new: true }
    );
  } catch {
    // The recoverer will inspect a stale provisioning status without replaying it.
  }
  return updated || await findPurchase(purchaseModel, purchaseId);
}

async function recordProvisionedService(purchaseModel, purchaseId, providerService, plan) {
  const provisionedAt = new Date();
  // The provider's own date, because it is the one that will cut the service off. Local arithmetic is the fallback.
  const expiresAt = providerService.expiresAt ?? new Date(provisionedAt.getTime() + plan.days * 24 * 60 * 60 * 1000);
  const serviceFields = {
    status: "provisioned",
    walletDebitStatus: "reserved",
    serviceUsername: providerService.username,
    serviceHash: providerService.hash,
    serviceLink: providerService.serviceLink,
    singleLink: providerService.singleLink,
    provisionedAt,
    expiresAt,
    errorCode: null,
    recoveryStatus: "none",
    recoveryReason: null,
  };

  let updated = null;
  for (let attempt = 0; attempt < 2 && !updated; attempt++) {
    try {
      updated = await purchaseModel.findOneAndUpdate(
        { purchaseId, status: { $in: ["provisioning", "manual_review"] } },
        { $set: serviceFields },
        { new: true }
      );
    } catch {
      // This is a database-only retry. The non-idempotent provider request is
      // never reissued, and setting the same response fields is safe.
    }
  }
  if (updated) return updated;

  const current = await findPurchase(purchaseModel, purchaseId);
  if (["provisioned", "completed"].includes(current?.status)) return current;
  return null;
}

/**
 * Business-layer customer purchase entry point. Only planId and userId are
 * request data; price, traffic, and duration always come from the server-side
 * product catalog, re-validated here so a disabled or archived plan cannot be bought.
 * Callers must reuse purchaseId when retrying the same user action. When not
 * supplied, a one-off ID is generated for a new purchase intent.
 */
export async function purchasePlan(
  userId,
  planId,
  {
    purchaseId: requestedPurchaseId,
    userModel = User,
    purchaseModel = WalletPurchase,
    createService = createVpnService,
  } = {}
) {
  const telegramId = normalizeTelegramId(userId);
  // The real models mean production: the catalog database is then mandatory for authorization (no stale fallback).
  const requireDatabase = purchaseModel === WalletPurchase;
  let plan;
  try {
    plan = await getSellablePlanById(planId, { requireDatabase });
  } catch {
    throw new PurchaseServiceError("Product catalog is temporarily unavailable", "CATALOG_UNAVAILABLE");
  }
  if (!plan) throw new PurchaseServiceError("Requested customer plan is not available", "INVALID_PLAN");
  if (![plan.days, plan.price].every((value) => Number.isSafeInteger(value) && value > 0) || !isValidCatalogTraffic(plan.gig)) {
    throw new PurchaseServiceError("Customer plan configuration is invalid", "INVALID_PLAN_CONFIGURATION");
  }
  if (typeof createService !== "function") throw new TypeError("createService must be a function");
  const purchaseId = normalizePurchaseId(requestedPurchaseId);

  let purchase;
  try {
    purchase = await purchaseModel.create({
      purchaseId,
      telegramId,
      planId: plan.id,
      planName: plan.name,
      gig: plan.gig,
      days: plan.days,
      amount: plan.price,
      status: "reserving",
      walletDebitStatus: "not_debited",
      refundStatus: "none",
    });
  } catch (error) {
    // A unique purchaseId arbitrates duplicate requests. Also check after a
    // transient create error, because Mongo may have committed before a lost
    // response reached this process.
    const replay = await existingPurchaseResult(purchaseModel, purchaseId, telegramId, plan).catch((lookupError) => {
      if (lookupError instanceof PurchaseServiceError) throw lookupError;
      return null;
    });
    if (replay) return replay;
    if (error?.code === 11000) {
      throw new PurchaseServiceError("Purchase identifier could not be claimed", "PURCHASE_ID_CONFLICT");
    }
    throw error;
  }

  // Handshake with permanent product deletion: the order record exists now, so confirm the product was not deleted
  // (or being deleted) in the meantime. Nothing has been debited yet, so the order is simply withdrawn.
  let referencable;
  try {
    referencable = await isProductReferencable(plan.id, { requireDatabase });
  } catch {
    referencable = false;
  }
  if (!referencable) {
    await purchaseModel.deleteOne({ purchaseId, status: "reserving", walletDebitStatus: "not_debited" })
      .catch(() => purchaseModel.updateOne({ purchaseId, status: "reserving" }, { $set: { status: "failed", errorCode: "PLAN_UNAVAILABLE" } }).catch(() => {}));
    throw new PurchaseServiceError("Requested customer plan is not available", "INVALID_PLAN");
  }

  const now = new Date();
  let reservation;
  try {
    reservation = await reserveBalance(telegramId, plan.price, purchaseId, { userModel });
  } catch (error) {
    await markRecoveryRequired(purchaseModel, purchaseId, "RESERVATION_RESULT_UNKNOWN");
    log("error", "Wallet reservation result is unknown; purchase recovery required", {
      purchaseId,
      userId: telegramId,
      errorType: error?.name || "DatabaseError",
      code: safeErrorCode(error, "RESERVATION_RESULT_UNKNOWN"),
    });
    const current = await findPurchase(purchaseModel, purchaseId).catch(() => purchase);
    return publicResult(current || purchase, plan, { failure: "processing" });
  }

  if (!reservation.reserved) {
    const errorCode = reservation.exists ? "INSUFFICIENT_BALANCE" : "USER_NOT_FOUND";
    let failed;
    try {
      failed = await purchaseModel.findOneAndUpdate(
        { purchaseId, status: "reserving" },
        {
          $set: {
            status: "failed",
            errorCode,
            walletDebitStatus: "not_debited",
          },
        },
        { new: true }
      );
    } catch {
      failed = null;
    }
    const current = failed || await findPurchase(purchaseModel, purchaseId).catch(() => null) || purchase;
    log("info", "Customer wallet could not reserve purchase amount", { purchaseId, userId: telegramId, reason: errorCode });
    return publicResult(current, plan, { failure: failureFor(current) });
  }

  let reserved = await persistReservationState(purchaseModel, purchaseId, telegramId, plan.price, now).catch(() => null);
  if (!reserved) {
    await markRecoveryRequired(purchaseModel, purchaseId, "RESERVATION_LEDGER_PENDING");
    const current = await findPurchase(purchaseModel, purchaseId).catch(() => null) || purchase;
    log("error", "Wallet reserved but purchase ledger update is pending", { purchaseId, userId: telegramId });
    return publicResult(current, plan, { failure: "processing" });
  }

  let provisioning;
  try {
    provisioning = await purchaseModel.findOneAndUpdate(
      { purchaseId, status: "reserved" },
      {
        $set: {
          status: "provisioning",
          provisioningStartedAt: new Date(),
          recoveryStatus: "none",
          recoveryReason: null,
        },
      },
      { new: true }
    );
  } catch {
    provisioning = null;
  }
  if (!provisioning) {
    const current = await findPurchase(purchaseModel, purchaseId).catch(() => null);
    if (current?.status !== "provisioning") {
      await markRecoveryRequired(purchaseModel, purchaseId, "PROVISIONING_CLAIM_PENDING");
      return publicResult(current || reserved, plan, { failure: "processing" });
    }
    provisioning = current;
  }

  return runProviderCreation({ purchaseModel, userModel, createService, provisioning, plan, purchaseId, telegramId });
}

/**
 * Provider half of a purchase. The caller must already own the order in the
 * `provisioning` state (either the customer flow or an admin claim of an
 * `awaiting_provider` order); this is the only place that issues the
 * non-idempotent WizardXray create request.
 */
export async function runProviderCreation({ purchaseModel, userModel, createService, provisioning, plan, purchaseId, telegramId }) {
  let providerService;
  try {
    const apiResponse = await withTelemetryContext({ orderKey: `wallet:${purchaseId}` }, () => createService(plan.gig, plan.days, 0));
    providerService = normalizeProvisioningResponse(apiResponse);
  } catch (error) {
    const errorCode = safeErrorCode(error, error?.ambiguous ? "PANEL_RESULT_UNKNOWN" : "PROVIDER_REJECTED");
    if (error?.ambiguous === true) {
      const uncertain = await markAmbiguousProviderResult(purchaseModel, purchaseId, errorCode).catch(() => null);
      log("warn", "WizardXray create outcome is ambiguous; reservation retained and request will not be replayed", {
        purchaseId,
        userId: telegramId,
        errorType: error?.name || "WizardApiError",
        code: errorCode,
      });
      return publicResult(uncertain || provisioning, plan, { failure: "provider_outcome_unknown" });
    }

    if (isProviderFundsShortage(error)) {
      // A proven, structured "provider wallet has insufficient funds" refusal means no service was created. The
      // customer's debit is kept as the reservation and the order waits for an admin to fund the provider wallet.
      const parked = await parkForProviderFunds(purchaseModel, purchaseId, {
        notifyCustomer: !provisioning.fulfillmentClaimedBy,
      }).catch(() => null);
      if (parked) {
        log("warn", "WizardXray wallet is short of funds; purchase reserved for admin fulfillment", { purchaseId, userId: telegramId });
        return publicResult(parked, plan, { failure: "awaiting_provider_funds" });
      }
      await markRecoveryRequired(purchaseModel, purchaseId, "AWAITING_PROVIDER_PARK_PENDING");
      const current = await findPurchase(purchaseModel, purchaseId).catch(() => null);
      return publicResult(current || provisioning, plan, { failure: "processing" });
    }

    try {
      const refund = await refundPurchaseReservation(
        { ...provisioning.toObject?.(), purchaseId, telegramId, amount: plan.price, errorCode },
        { allowProvisioning: true, reason: errorCode, errorCode, userModel, purchaseModel }
      );
      const refunded = refund.purchase || await findPurchase(purchaseModel, purchaseId);
      log("warn", "WizardXray rejected purchase; customer wallet reservation refunded", {
        purchaseId,
        userId: telegramId,
        errorType: error?.name || "WizardApiError",
        code: errorCode,
      });
      return publicResult(refunded, plan, { failure: "provider_rejected_refunded" });
    } catch (refundError) {
      await markRecoveryRequired(purchaseModel, purchaseId, "REFUND_PENDING");
      const current = await findPurchase(purchaseModel, purchaseId).catch(() => null);
      log("error", "Provider rejection refund requires financial recovery", {
        purchaseId,
        userId: telegramId,
        errorType: refundError?.name || "RefundError",
        code: safeErrorCode(refundError, "REFUND_PENDING"),
      });
      return publicResult(current || provisioning, plan, { failure: "refund_pending" });
    }
  }

  let provisioned = await recordProvisionedService(purchaseModel, purchaseId, providerService, plan).catch(() => null);
  if (!provisioned) {
    await markRecoveryRequired(purchaseModel, purchaseId, "PROVISIONED_RESULT_NEEDS_RECOVERY");
    const current = await findPurchase(purchaseModel, purchaseId).catch(() => null);
    log("error", "WizardXray created a service but its result needs database recovery", {
      purchaseId,
      userId: telegramId,
    });
    return publicResult(current || provisioning, plan, { failure: "fulfillment_pending" });
  }

  if (provisioned.status === "completed") {
    return publicResult(provisioned, plan);
  }

  try {
    const committed = await commitProvisionedPurchase(provisioned, undefined, { userModel, purchaseModel });
    log("info", "Customer wallet purchase fulfilled", { purchaseId, userId: telegramId, planId: plan.id });
    return publicResult(committed.purchase, plan);
  } catch (error) {
    await markRecoveryRequired(purchaseModel, purchaseId, "PROVISIONED_SERVICE_COMMIT_PENDING");
    const current = await findPurchase(purchaseModel, purchaseId).catch(() => null);
    log("error", "Provisioned purchase needs user/ledger commit recovery", {
      purchaseId,
      userId: telegramId,
      errorType: error?.name || "DatabaseError",
    });
    return publicResult(current || provisioned, plan, { failure: "fulfillment_pending" });
  }
}

export const purchaseService = Object.freeze({ purchasePlan });
