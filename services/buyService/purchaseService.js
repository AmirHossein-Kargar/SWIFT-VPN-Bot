import { randomUUID } from "node:crypto";
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { getCustomerPlanById } from "../plans.js";
import { createVpnService } from "../../api/wizardApi.js";
import {
  commitProvisionedPurchase,
  refundPurchaseReservation,
  reserveBalance,
} from "./purchaseLedger.js";

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

function validHttpsUrl(value) {
  if (typeof value !== "string" || value.length < 9 || value.length > 4096 || !/^https:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return value;
  } catch {
    return null;
  }
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
  const username = result?.username;
  const hash = typeof result?.hash === "string" && HASH_PATTERN.test(result.hash) ? result.hash : null;
  const serviceLink = validHttpsUrl(result?.sub_link);
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

  const links = Array.isArray(result.tak_links) ? result.tak_links : [];
  const singleLink = links.length ? validSingleLink(links[0]) : "";
  return { username, hash, serviceLink, singleLink };
}

function customerServiceInfo(purchase) {
  if (purchase?.status !== "completed") return null;
  const hash = typeof purchase.serviceHash === "string" && HASH_PATTERN.test(purchase.serviceHash)
    ? purchase.serviceHash
    : null;
  const serviceLink = validHttpsUrl(purchase.serviceLink);
  return {
    username: purchase.serviceUsername,
    subscriptionUrl: hash
      ? `https://iranisystem.com/bot/sub/?hash=${encodeURIComponent(hash)}`
      : serviceLink,
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
  const expiresAt = new Date(provisionedAt.getTime() + plan.days * 24 * 60 * 60 * 1000);
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
 * request data; price, traffic, and duration always come from customerPlans.
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
  const plan = getCustomerPlanById(planId);
  if (!plan) throw new PurchaseServiceError("Requested customer plan is not available", "INVALID_PLAN");
  if (![plan.days, plan.gig, plan.price].every((value) => Number.isSafeInteger(value) && value > 0)) {
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

  let providerService;
  try {
    const apiResponse = await createService(plan.gig, plan.days, 0);
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
