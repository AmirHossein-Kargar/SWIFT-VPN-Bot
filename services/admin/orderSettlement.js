/**
 * Settling an order whose `create` has an unknown outcome.
 *
 * Such an order is `manual_review` with the customer's debit held, and it stays there until a person decides, because the provider
 * has no idempotency key and repeating `create` could buy a second service. This is that decision, in one of two forms:
 *
 *   created      A service with these terms exists at the provider. It is attached to the order and delivered. The debit that was
 *                already taken pays for it: nothing is charged, and the provider is not asked to create anything.
 *   not_created  Nothing can be found. The held debit is refunded, once, through the normal refund path.
 *
 * Neither calls a provider method that changes anything. The rules exist because an admin's click is not evidence:
 *   - an order younger than SETTLE_MIN_AGE_MS is refused: `create` may still answer, and the provider's list lags by minutes;
 *   - a service is linked only if the provider's live `info` shows it with the sold terms, created around the attempt, and no other
 *     order or customer has it, so one service cannot pay for two orders;
 *   - a refund needs the provider's whole list to have been read with no candidate in it. If the list cannot be read, nothing moves.
 * Both can race a second admin: the `manual_review` filter lets exactly one win, and the refund path is keyed per order.
 */
import User from "../../models/User.js";
import WalletPurchase from "../../models/WalletPurchase.js";
import { getServiceInfo, UNLIMITED_GIG } from "../../api/wizardApi.js";
import botInstance from "../../config/botInstance.js";
import { commitProvisionedPurchase, refundPurchaseReservation } from "../buyService/purchaseLedger.js";
import { acquireRedisLease, releaseRedisLease } from "../redisLease.js";
import { AdminServiceError, assertAdminUser } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { requireReason, requireServiceUsername } from "./validation.js";
import { findProviderCandidates } from "./vpns.js";

export const SETTLE_MIN_AGE_MS = 15 * 60_000;
const CREATED_EARLY_MS = 2 * 60_000;
const CREATED_LATE_MS = 15 * 60_000;
const EVENT_LIMIT = 50;
const OUTCOMES = new Set(["created", "not_created"]);

const refuse = (message, code, status = 409) => new AdminServiceError(message, { status, code });
const event = (type, actor, to) => ({ $push: { events: { $each: [{ at: new Date(), type, actor: String(actor), from: "manual_review", to }], $slice: -EVENT_LIMIT } } });

function requirePurchaseId(value) {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw refuse("شناسه سفارش نامعتبر است.", "invalid_purchase_id", 400);
  return id;
}

async function loadHeldOrder(purchaseId, now) {
  const order = await WalletPurchase.findOne({ purchaseId }).lean();
  if (!order) throw refuse("سفارش یافت نشد.", "purchase_not_found", 404);
  if (order.status !== "manual_review") throw refuse("این سفارش در وضعیت بررسی دستی نیست.", "order_not_held");
  const startedAt = new Date(order.provisioningStartedAt || order.createdAt).getTime();
  if (now.getTime() - startedAt < SETTLE_MIN_AGE_MS) throw refuse("این سفارش هنوز تازه است؛ پاسخ پنل و فهرست سرویس‌ها ممکن است برسد. کمی بعد دوباره بررسی کنید.", "order_too_recent");
  // The debit has to be a live reservation, or there is nothing to finalize or refund.
  const held = order.walletDebitStatus === "reserved" && await User.exists({
    telegramId: String(order.telegramId),
    appliedPurchaseReservations: purchaseId,
    refundedPurchaseIds: { $ne: purchaseId },
  });
  if (!held) throw refuse("برداشت این سفارش تأیید نشد؛ تسویه انجام نشد.", "reservation_not_verified");
  return { order, startedAt };
}

/** The service the admin named, proved from the provider's own live answer. Everything here is a reason to touch nothing. */
async function verifiedService(order, startedAt, username) {
  const [otherOrder, otherOwner] = await Promise.all([
    WalletPurchase.exists({ serviceUsername: username }),
    User.exists({ "services.username": username }),
  ]);
  if (otherOrder || otherOwner) throw refuse("این سرویس قبلاً به سفارش یا کاربر دیگری وصل شده است.", "service_already_linked");

  let service;
  try {
    service = await getServiceInfo(username);
  } catch (error) {
    if (error?.reason === "service_not_found") throw refuse("این سرویس در WizardXray پیدا نشد.", "wizard_service_not_found", 404);
    throw refuse("WizardXray پاسخ نداد؛ تسویه انجام نشد.", "wizard_unavailable", 503);
  }
  if (!service.live) throw refuse("WizardXray فقط نسخهٔ ذخیره‌شده را برگرداند؛ تسویه انجام نشد.", "wizard_stale");
  if (service.test) throw refuse("سرویس تست را نمی‌توان به سفارش پولی وصل کرد.", "service_terms_mismatch");
  if (!service.subLink) throw refuse("این سرویس لینک اشتراک معتبری ندارد.", "service_terms_mismatch");

  const soldUnlimited = order.gig === UNLIMITED_GIG;
  if (service.unlimited !== soldUnlimited || (!soldUnlimited && service.dataLimitGb !== order.gig)) {
    throw refuse("مشخصات این سرویس با سفارش یکسان نیست.", "service_terms_mismatch");
  }
  const createdAt = service.createdAt ? service.createdAt * 1000 : NaN;
  if (!(createdAt >= startedAt - CREATED_EARLY_MS && createdAt <= startedAt + CREATED_LATE_MS)) {
    throw refuse("زمان ساخت این سرویس با تلاش این سفارش همخوانی ندارد.", "service_outside_window");
  }
  return { service, createdAt: new Date(createdAt) };
}

async function linkService({ order, startedAt, username, actorId, bot, leases }) {
  const lease = await leases.acquire(`admin:settle:${username}`, 120);
  if (!lease) throw refuse("عملیات دیگری روی این سرویس در حال انجام است.", "settlement_in_progress");
  try {
    const { service, createdAt } = await verifiedService(order, startedAt, username);
    const claimed = await WalletPurchase.findOneAndUpdate(
      { purchaseId: order.purchaseId, status: "manual_review", serviceUsername: null },
      {
        $set: {
          status: "provisioned",
          walletDebitStatus: "reserved",
          serviceUsername: username,
          serviceLink: service.subLink,
          singleLink: service.links[0] ?? "",
          provisionedAt: createdAt,
          expiresAt: service.expiresAt,
          errorCode: null,
          recoveryStatus: "none",
          recoveryReason: null,
        },
        ...event("admin_linked_service", actorId, "provisioned"),
      },
      { new: true },
    );
    if (!claimed) throw refuse("این سفارش هم‌زمان تسویه شد.", "order_not_held");
    // If this fails the order is `provisioned`, and the recovery cycle finishes the same commit exactly once.
    const committed = await commitProvisionedPurchase(claimed, bot).catch(() => null);
    return { ok: true, outcome: "created", status: committed ? "completed" : "provisioned", notified: committed?.notified ?? false, auditSummary: { outcome: "created", serviceUsername: username } };
  } finally {
    await leases.release(lease).catch(() => {});
  }
}

async function refundHeldOrder({ order, purchaseId, actorId, bot }) {
  const check = await findProviderCandidates({ actorId, purchaseId });
  if (!check.complete) throw refuse("فهرست کامل WizardXray خوانده نشد؛ بازپرداخت انجام نشد.", "provider_list_incomplete");
  if (check.candidates.length) throw refuse("سرویس مشابهی در WizardXray هست؛ پیش از بازپرداخت آن را بررسی کنید.", "provider_candidates_exist");

  const refund = await refundPurchaseReservation(order, { allowManualReview: true, reason: "ADMIN_CONFIRMED_NOT_CREATED", errorCode: "ADMIN_CONFIRMED_NOT_CREATED" });
  await WalletPurchase.updateOne({ purchaseId }, event("admin_refunded_unknown", actorId, "refund_pending")).catch(() => {});
  try {
    await bot?.sendMessage?.(String(order.telegramId), "❌ سرویس این سفارش ساخته نشد و مبلغ آن به کیف پول شما بازگشت.");
  } catch { /* the refund is recorded; a blocked chat changes nothing */ }
  return { ok: true, outcome: "not_created", status: refund.purchase?.status ?? "refunded", scanned: check.scanned, auditSummary: { outcome: "not_created", scanned: check.scanned, amount: order.amount } };
}

/** See the header. Audited before anything happens; a repeated operationId replays the stored answer. */
export async function settleUnknownOrder({ actorId, operationId, purchaseId, outcome, serviceUsername, reason, ipAddress, now = new Date(), bot = botInstance.bot, leases = { acquire: acquireRedisLease, release: releaseRedisLease } } = {}) {
  assertAdminUser(actorId);
  const id = requirePurchaseId(purchaseId);
  if (!OUTCOMES.has(outcome)) throw refuse("نتیجهٔ تسویه نامعتبر است.", "invalid_settlement", 400);
  const safeReason = requireReason(reason, { min: 10, max: 240 });
  const username = outcome === "created" ? requireServiceUsername(serviceUsername) : null;
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "ORDER_UNKNOWN_SETTLED",
    targetType: "order",
    targetId: id,
    ipAddress,
    metadata: { outcome, reason: safeReason, ...(username ? { serviceUsername: username } : {}) },
    execute: async () => {
      const { order, startedAt } = await loadHeldOrder(id, now);
      if (outcome === "created") return linkService({ order, startedAt, username, actorId, bot, leases });
      return refundHeldOrder({ order, purchaseId: id, actorId, bot });
    },
  });
  return result;
}
