import { escapeErrorMessage } from "../../utils/escapeHtml.js";
import { createVpnService, StatusApi, WizardApiError, WIZARD_REJECTION_CODES } from "../../api/wizardApi.js";
import { getSession, setSession } from "../../config/sessionStore.js";
import { isAdmin } from "../../utils/auth.js";
import { adminOwnerFields, canContinueAdminStep, isActiveForeignAdminPrompt, API_PURCHASE_IN_PROGRESS } from "../../utils/adminStepSession.js";
import { runAuditedAction } from "../../services/admin/audit.js";
import { AdminServiceError } from "../../services/admin/authorization.js";
import {
  API_PURCHASE_ACTION,
  API_PURCHASE_NOT_CLAIMED_CODE,
  API_PURCHASE_OUTCOMES,
  API_PURCHASE_REJECTED_CODE,
  API_PURCHASE_UNKNOWN_CODE,
  findUnresolvedApiPurchases,
  isPurchaseId,
  newPurchaseId,
  purchaseOperationId,
  resolveApiPurchase,
} from "../../services/admin/apiPurchaseLedger.js";

const apiServicePurchase = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;

  // بررسی دسترسی ادمین (fail-closed via utils/auth.js)
  if (!isAdmin(chatId, userId)) {
    await bot.answerCallbackQuery(query.id, {
      text: "⛔️ شما دسترسی انجام این عملیات را ندارید",
      show_alert: true,
    });
    return;
  }

  // A purchase is running in this process for this chat: do not replace its state.
  if (isApiPurchaseInFlight(chatId)) {
    await bot.answerCallbackQuery(query.id, { text: "⏳ خرید در حال انجام است.", show_alert: true });
    return;
  }

  // An earlier purchase whose outcome is unsettled blocks a new one until an admin reconciles it (no expiry).
  let unresolved;
  try {
    unresolved = await findUnresolvedApiPurchases({ auditModel: injectedDeps.auditModel });
  } catch {
    await bot.answerCallbackQuery(query.id, { text: "⚠️ بررسی خریدهای قبلی ممکن نشد؛ دوباره تلاش کنید.", show_alert: true });
    return;
  }
  if (unresolved.length) {
    await showUnresolvedNotice(bot, query, { chatId, messageId, unresolved });
    return;
  }

  try {
    // دریافت قیمت‌های API
    const statusData = await StatusApi();
    if (!statusData.ok) {
      await bot.answerCallbackQuery(query.id, {
        text: "❌ خطا در دریافت قیمت‌های API",
        show_alert: true,
      });
      return;
    }

    const { per_gb, per_day } = statusData.result;

    const message =
      `🛒 <b>خرید سرویس از API</b>\n\n` +
      `💰 <b>قیمت‌های فعلی:</b>\n` +
      `• هر گیگ: <code>${per_gb.toLocaleString()}</code> تومان\n` +
      `• هر روز: <code>${per_day.toLocaleString()}</code> تومان\n\n` +
      `📝 <b>لطفاً مشخصات سرویس را وارد کنید:</b>\n\n` +
      `برای شروع، تعداد گیگ مورد نیاز را ارسال کنید (مثال: 10)`;

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "❌ لغو", callback_data: "admin_cancel_api_purchase" },
            { text: "🏠 بازگشت", callback_data: "admin_panel" },
          ],
        ],
      },
    });

    // تنظیم session برای دریافت گیگ
    await setSession(chatId, {
      step: "waiting_for_api_gig",
      per_gb,
      per_day,
      messageId,
      ...adminOwnerFields(userId),
    });

    await bot.answerCallbackQuery(query.id, {
      text: "✅ لطفاً تعداد گیگ را وارد کنید",
    });
  } catch (error) {
    console.error("Error in apiServicePurchase:", error);
    await bot.answerCallbackQuery(query.id, {
      text: "❌ خطا در شروع فرآیند خرید",
      show_alert: true,
    });
  }
};

// Handler برای دریافت تعداد گیگ
const handleApiGigInput = async (bot, msg, session) => {
  const chatId = msg.chat.id;
  // Only the admin who opened this purchase may continue it (fail closed, no side effects).
  if (!canContinueAdminStep({ session, chatId, userId: msg.from?.id })) return;
  const gigText = msg.text?.trim();
  const messageId = session.messageId;

  if (!gigText || isNaN(gigText) || parseInt(gigText) <= 0) {
    await bot.sendMessage(
      chatId,
      "❌ لطفاً یک عدد معتبر برای گیگ وارد کنید (مثال: 10)"
    );
    return;
  }

  const gig = parseInt(gigText);
  const per_gb = session.per_gb;
  const per_day = session.per_day;

  const gigPrice = gig * per_gb;

  const message =
    `📊 <b>مشخصات سرویس:</b>\n\n` +
    `💾 حجم: <code>${gig}</code> گیگ\n` +
    `💰 قیمت حجم: <code>${gigPrice.toLocaleString()}</code> تومان\n\n` +
    `📝 حالا تعداد روز مورد نیاز را وارد کنید (مثال: 30)`;

  try {
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "❌ لغو", callback_data: "admin_cancel_api_purchase" },
            { text: "🏠 بازگشت", callback_data: "admin_panel" },
          ],
        ],
      },
    });

    // به‌روزرسانی session
    await setSession(chatId, {
      step: "waiting_for_api_days",
      per_gb,
      per_day,
      gig,
      gigPrice,
      messageId,
      adminUserId: session.adminUserId,
    });

    // حذف پیام کاربر
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  } catch (error) {
    console.error("Error in handleApiGigInput:", error);
    await bot.sendMessage(chatId, "❌ خطا در پردازش اطلاعات");
  }
};

// Handler برای دریافت تعداد روز
const handleApiDaysInput = async (bot, msg, session) => {
  const chatId = msg.chat.id;
  if (!canContinueAdminStep({ session, chatId, userId: msg.from?.id })) return;
  const daysText = msg.text?.trim();
  const messageId = session.messageId;

  if (!daysText || isNaN(daysText) || parseInt(daysText) <= 0) {
    await bot.sendMessage(
      chatId,
      "❌ لطفاً یک عدد معتبر برای روز وارد کنید (مثال: 30)"
    );
    return;
  }

  const days = parseInt(daysText);
  const { per_gb, per_day, gig, gigPrice } = session;

  const daysPrice = days * per_day;
  const totalPrice = gigPrice + daysPrice;

  const message =
    `📋 <b>خلاصه سفارش:</b>\n\n` +
    `💾 حجم: <code>${gig}</code> گیگ\n` +
    `📅 مدت: <code>${days}</code> روز\n\n` +
    `💰 <b>محاسبه قیمت:</b>\n` +
    `• قیمت حجم: <code>${gigPrice.toLocaleString()}</code> تومان\n` +
    `• قیمت زمان: <code>${daysPrice.toLocaleString()}</code> تومان\n` +
    `• <b>مجموع: <code>${totalPrice.toLocaleString()}</code> تومان</b>\n\n` +
    `✅ آیا می‌خواهید این سرویس را ایجاد کنید؟`;

  try {
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ ایجاد سرویس",
              callback_data: "admin_create_api_service",
            },
            { text: "❌ لغو", callback_data: "admin_cancel_api_purchase" },
          ],
          [{ text: "🏠 بازگشت", callback_data: "admin_panel" }],
        ],
      },
    });

    // به‌روزرسانی session
    await setSession(chatId, {
      step: "waiting_for_api_confirmation",
      per_gb,
      per_day,
      gig,
      days,
      totalPrice,
      messageId,
      adminUserId: session.adminUserId,
      purchaseId: newPurchaseId(),
    });

    // حذف پیام کاربر
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  } catch (error) {
    console.error("Error in handleApiDaysInput:", error);
    await bot.sendMessage(chatId, "❌ خطا در پردازش اطلاعات");
  }
};

// Handler برای ایجاد سرویس
//
// The provider's /create call has no idempotency key and cannot be queried by request, so one confirmation must
// reach it at most once and an unknown outcome must never be guessed away:
//   1. an in-process lock per chat (check-and-add is synchronous, hence atomic) rejects concurrent taps;
//   2. the stored session is re-read under that lock and must be this owner's unconsumed confirmation;
//   3. any earlier purchase whose outcome is unsettled (durable ledger: a crashed or ambiguous attempt that no
//      admin has reconciled) blocks the purchase, however old it is. Age is never treated as proof of failure;
//   4. the ledger row (unique operationId = atomic claim across processes) is written BEFORE the provider is
//      contacted, then the confirmation is consumed in the session, then the provider is called once.
// Ambiguous outcomes (timeout, network error, 5xx, 408, malformed response) are never retried: the row stays
// unresolved until an admin attests the real outcome through the audited resolve buttons.
const CONFIRMATION_STEP = "waiting_for_api_confirmation";
const purchasesInFlight = new Set();
let injectedDeps = {};

/** Test seam: inject an audit model so the ledger runs without MongoDB. */
export function setApiPurchaseDepsForTests(deps = {}) {
  injectedDeps = deps || {};
}

export function resetApiPurchaseLocksForTests() {
  purchasesInFlight.clear();
  injectedDeps = {};
}

/** True while THIS process has a provider purchase running for the chat. Cannot go stale across a crash. */
export function isApiPurchaseInFlight(chatId) {
  return purchasesInFlight.has(String(chatId));
}

/**
 * True only for failures established to mean "the provider created nothing". The verdict comes from the shared client
 * (api/wizardApi.js), never from a bare HTTP status, so the two cannot disagree:
 *  - a TypeError: argument validation in createVpnService runs before any request is built; or
 *  - a WizardApiError carrying one of WIZARD_REJECTION_CODES with `ambiguous === false`, which the client sets only for
 *    an explicit, self-consistent panel refusal (ok:false, 2xx or 4xx transport, no server-side body http_code).
 * Everything else stays ambiguous and needs reconciliation: 3xx, 408, 5xx, timeouts and network errors, truncated or
 * malformed bodies, unproven or contradictory refusals, configuration errors and any unknown error.
 */
export function isDefiniteProviderFailure(error) {
  if (error instanceof TypeError) return true;
  return error instanceof WizardApiError && error.ambiguous === false && WIZARD_REJECTION_CODES.includes(error.code);
}

async function quietly(operation) {
  try { return await operation(); } catch { return undefined; }
}

function logPurchaseError(label, error) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "admin-api-purchase",
    level: "error",
    message: label,
    errorType: error?.name || "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
    status: Number.isInteger(error?.status) ? error.status : undefined,
  }));
}

function failureKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔄 تلاش مجدد", callback_data: "admin_api_service_purchase" },
        { text: "🏠 بازگشت", callback_data: "admin_panel" },
      ],
    ],
  };
}

function reconcileKeyboard(purchaseId) {
  return {
    inline_keyboard: [
      [{ text: "✅ سرویس ساخته شده بود", callback_data: `apires:c:${purchaseId}` }],
      [{ text: "❌ سرویس ساخته نشده بود", callback_data: `apires:n:${purchaseId}` }],
      [{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }],
    ],
  };
}

const RECONCILE_HELP =
  `لطفاً فهرست سرویس‌های پنل ارائه‌دهنده را بررسی کنید (پنل وب ← سرویس‌ها ← پنل ارائه‌دهنده) ` +
  `و نتیجهٔ واقعی را ثبت کنید. تا ثبت این نتیجه، هیچ خرید API جدیدی انجام نمی‌شود.`;

/** Edits the confirmation message into the "unsettled purchase" notice with the audited resolve buttons. */
async function showUnresolvedNotice(bot, query, { chatId, messageId, unresolved }) {
  const first = unresolved[0];
  await quietly(() => bot.editMessageText(
    `⛔️ <b>یک خرید API قبلی هنوز بلاتکلیف است</b>\n\n` +
    `شناسه: <code>${first.purchaseId}</code>${unresolved.length > 1 ? ` (و ${unresolved.length - 1} مورد دیگر)` : ""}\n\n` +
    `نتیجهٔ ساخت سرویس برای آن مشخص نشد و به‌طور خودکار تکرار نمی‌شود.\n${RECONCILE_HELP}`,
    { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: reconcileKeyboard(first.purchaseId) }
  ));
  await quietly(() => bot.answerCallbackQuery(query.id, { text: "⛔️ ابتدا خرید بلاتکلیف قبلی را بررسی و ثبت کنید.", show_alert: true }));
}

async function deliverCreatedService(bot, chatId, result) {
  const username = result.username || "نامشخص";
  const hash = result.hash;
  const smartLink = hash ? `https://iranisystem.com/bot/sub/?hash=${hash}` : "";
  const singleLink =
    Array.isArray(result.tak_links) && result.tak_links.length > 0
      ? result.tak_links[0]
      : "";
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(
    smartLink
  )}&size=200x200&margin=20`;

  let finalMessage =
    `✅ <b>سرویس شما با موفقیت ساخته شد!</b>\n\n` +
    `🆔 <b>آیدی سرویس:</b> <code>${username}</code>\n\n` +
    `🔗 <b>لینک اتصال (Subscription):</b>\n` +
    `<code>${smartLink}</code>\n\n`;
  if (singleLink) {
    finalMessage +=
      `👈 <b>لینک تکی از لوکیشن پیشنهادی:</b>\n` +
      `<code>${singleLink}</code>\n\n`;
  }
  finalMessage +=
    `📌 برای کپی لینک، روی آن لمس طولانی کنید یا راست‌ کلیک کنید.\n\n` +
    `⚠️ این سرویس از نوع Subscription است. برای اتصال، از راهنمای زیر استفاده کنید.`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "📱 راهنمای اتصال", callback_data: "admin_show_connection_guide" },
        { text: "🔄 تغییر لینک", callback_data: `admin_change_link_${username}` },
      ],
      [
        { text: "❌ حذف سرویس", callback_data: `admin_delete_service_${username}` },
        { text: "🏠 بازگشت", callback_data: "admin_panel" },
      ],
    ],
  };

  // The service already exists and is paid for: a delivery problem must never read as a failed purchase.
  try {
    await bot.sendPhoto(chatId, qrUrl, { caption: finalMessage, parse_mode: "HTML", reply_markup });
    return true;
  } catch (photoError) {
    logPurchaseError("QR delivery failed after a successful purchase", photoError);
  }
  try {
    await bot.sendMessage(chatId, finalMessage, { parse_mode: "HTML", reply_markup });
    return true;
  } catch (messageError) {
    logPurchaseError("Service delivery failed after a successful purchase", messageError);
    return false;
  }
}

const createApiService = async (bot, query, session) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from?.id;
  const mayConfirm = (candidate) =>
    candidate?.step === CONFIRMATION_STEP
    && isPurchaseId(candidate.purchaseId)
    && canContinueAdminStep({ session: candidate, chatId, userId });

  // The service is bought with the figures the initiating admin entered; no one else may confirm them.
  if (!mayConfirm(session)) return;

  const lockKey = String(chatId);
  if (purchasesInFlight.has(lockKey)) {
    await quietly(() => bot.answerCallbackQuery(query.id, { text: "⏳ خرید در حال انجام است." }));
    return;
  }
  purchasesInFlight.add(lockKey);
  try {
    // The passed session may be stale; only the stored one decides, and it must be the same confirmation.
    const stored = await getSession(chatId);
    if (!mayConfirm(stored) || stored.purchaseId !== session.purchaseId) return;
    const gig = Number(stored.gig);
    const days = Number(stored.days);
    if (!Number.isFinite(gig) || gig <= 0 || !Number.isSafeInteger(days) || days < 1) return;
    const purchaseId = stored.purchaseId;

    // An unsettled earlier purchase blocks this one. If the ledger cannot be read, nothing is bought.
    let unresolved;
    try {
      unresolved = await findUnresolvedApiPurchases({ auditModel: injectedDeps.auditModel });
    } catch (error) {
      logPurchaseError("Could not read the API purchase ledger", error);
      await quietly(() => bot.answerCallbackQuery(query.id, { text: "⚠️ بررسی خریدهای قبلی ممکن نشد؛ هیچ خریدی انجام نشد.", show_alert: true }));
      return;
    }
    if (unresolved.length) {
      await showUnresolvedNotice(bot, query, { chatId, messageId, unresolved });
      return;
    }

    const run = { kind: null, result: null, error: null };
    let audited = null;
    let ledgerError = null;
    try {
      audited = await runAuditedAction({
        actorTelegramId: userId,
        operationId: purchaseOperationId(purchaseId),
        action: API_PURCHASE_ACTION,
        targetType: "api_purchase",
        targetId: purchaseId,
        metadata: { gig, days },
        auditModel: injectedDeps.auditModel,
        execute: async () => {
          // Consume the confirmation and prove the write landed (the session store swallows write errors).
          // The provider has not been contacted yet, so failing here buys nothing.
          await setSession(chatId, {
            step: null,
            adminUserId: stored.adminUserId,
            apiPurchase: { state: API_PURCHASE_IN_PROGRESS, at: Date.now(), gig, days, purchaseId },
          });
          const claimed = await getSession(chatId);
          if (claimed?.step || claimed?.apiPurchase?.state !== API_PURCHASE_IN_PROGRESS) {
            throw new AdminServiceError("The purchase state could not be recorded.", { status: 503, code: API_PURCHASE_NOT_CLAIMED_CODE });
          }

          await quietly(() => bot.editMessageText("⏳ در حال ساخت سرویس از API...", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "HTML",
          }));

          let response;
          try {
            response = await createVpnService(gig, days, 0);
          } catch (error) {
            logPurchaseError("Provider service creation failed", error);
            run.error = error;
            if (isDefiniteProviderFailure(error)) {
              run.kind = "definite"; // rejected before anything could be created
              throw new AdminServiceError("The provider rejected the request.", { status: 502, code: API_PURCHASE_REJECTED_CODE });
            }
            run.kind = "uncertain";
            throw new AdminServiceError("The provider outcome is unknown.", { status: 502, code: API_PURCHASE_UNKNOWN_CODE });
          }
          if (!(response && response.ok === true && response.result)) {
            run.kind = "uncertain";
            throw new AdminServiceError("The provider outcome is unknown.", { status: 502, code: API_PURCHASE_UNKNOWN_CODE });
          }
          run.kind = "created";
          run.result = response.result;
          return { ok: true, auditSummary: { username: response.result.username } };
        },
      });
    } catch (error) {
      ledgerError = error;
    }

    if (audited?.replayed && !run.kind) return; // another process already handled this exact confirmation

    if (run.kind === "created") {
      if (ledgerError) logPurchaseError("Ledger update failed after a successful purchase", ledgerError);
      // Created. Close the marker first so nothing below can leave a purchase "running".
      await setSession(chatId, { step: null });
      await deliverCreatedService(bot, chatId, run.result);
      await quietly(() => bot.answerCallbackQuery(query.id, { text: "✅ سرویس با موفقیت ایجاد شد" }));
      return;
    }

    if (run.kind === "definite") {
      // Rejected before anything could be created: safe to start over.
      await setSession(chatId, { step: null });
      await quietly(() => bot.editMessageText(
        `❌ خطا در ایجاد سرویس:\n\n<code>${escapeErrorMessage(run.error)}</code>`,
        { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: failureKeyboard() }
      ));
      await quietly(() => bot.answerCallbackQuery(query.id, { text: "❌ خطا در ایجاد سرویس", show_alert: true }));
      return;
    }

    if (run.kind === "uncertain") {
      await reportUncertainPurchase(bot, query, { chatId, messageId, stored, gig, days, purchaseId });
      return;
    }

    // The provider was never contacted.
    const code = ledgerError?.code;
    if (code === "idempotency_conflict" || code === "action_in_progress") {
      await quietly(() => bot.answerCallbackQuery(query.id, { text: "⏳ این تأیید قبلاً ثبت شده است." }));
      return;
    }
    if (code === API_PURCHASE_NOT_CLAIMED_CODE) {
      await quietly(() => bot.answerCallbackQuery(query.id, { text: "⚠️ ثبت وضعیت خرید ممکن نشد؛ هیچ خریدی انجام نشد.", show_alert: true }));
      return;
    }
    logPurchaseError("API purchase was not started", ledgerError);
    await quietly(() => bot.answerCallbackQuery(query.id, { text: "⚠️ ثبت گزارش عملیات ممکن نشد؛ هیچ خریدی انجام نشد.", show_alert: true }));
  } finally {
    purchasesInFlight.delete(lockKey);
  }
};

/** The provider may or may not have created the service: never retry; the ledger row stays unresolved. */
async function reportUncertainPurchase(bot, query, { chatId, messageId, stored, gig, days, purchaseId }) {
  await setSession(chatId, {
    step: null,
    adminUserId: stored.adminUserId,
    apiPurchase: { state: "uncertain", at: Date.now(), gig, days, purchaseId },
  });
  await quietly(() => bot.editMessageText(
    `⚠️ <b>نتیجهٔ ساخت سرویس نامشخص است</b>\n\n` +
    `شناسه: <code>${purchaseId}</code>\n` +
    `پاسخ پنل ارائه‌دهنده دریافت یا تأیید نشد؛ ممکن است سرویس ساخته شده باشد. ` +
    `درخواست به‌طور خودکار تکرار نمی‌شود.\n\n${RECONCILE_HELP}`,
    { chat_id: chatId, message_id: messageId, parse_mode: "HTML", reply_markup: reconcileKeyboard(purchaseId) }
  ));
  await quietly(() => bot.answerCallbackQuery(query.id, { text: "⚠️ نتیجهٔ خرید نامشخص است؛ پنل را بررسی و نتیجه را ثبت کنید.", show_alert: true }));
}

/** apires:<c|n>:<purchaseId> — an admin attests what the provider panel actually shows (audited). */
const resolveApiPurchaseCallback = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from?.id;
  const match = /^apires:([cn]):([0-9a-f]{20})$/.exec(String(query.data || ""));
  if (!match) return;
  if (!isAdmin(chatId, userId)) {
    await quietly(() => bot.answerCallbackQuery(query.id, { text: "⛔️ دسترسی غیرمجاز", show_alert: true }));
    return;
  }
  if (isApiPurchaseInFlight(chatId)) {
    await quietly(() => bot.answerCallbackQuery(query.id, { text: "⏳ خرید در حال انجام است.", show_alert: true }));
    return;
  }
  const [, flag, purchaseId] = match;
  let resolution;
  try {
    resolution = await resolveApiPurchase({
      actorId: userId,
      purchaseId,
      outcome: flag === "c" ? API_PURCHASE_OUTCOMES.created : API_PURCHASE_OUTCOMES.none,
      auditModel: injectedDeps.auditModel,
    });
  } catch (error) {
    const known = error instanceof AdminServiceError;
    await quietly(() => bot.answerCallbackQuery(query.id, {
      text: known && error.code === "purchase_not_unresolved"
        ? "ℹ️ این خرید دیگر بلاتکلیف نیست."
        : known && error.code === "resolution_unverified"
          ? "⚠️ ثبت یا تأیید نتیجه ممکن نشد؛ خرید جدید تا ثبت موفق مسدود می‌ماند. کمی بعد دوباره تلاش کنید."
          : "⚠️ ثبت نتیجه ممکن نشد؛ دوباره تلاش کنید.",
      show_alert: true,
    }));
    return;
  }

  // Drop the informational "uncertain" marker if it still belongs to this purchase; never touch another prompt.
  const current = await quietly(() => getSession(chatId));
  if (!current?.step && current?.apiPurchase?.state === "uncertain" && current.apiPurchase.purchaseId === purchaseId) {
    await quietly(() => setSession(chatId, { step: null }));
  }
  const remaining = await quietly(() => findUnresolvedApiPurchases({ auditModel: injectedDeps.auditModel })) || [];
  await quietly(() => bot.editMessageText(
    `✅ <b>نتیجه ثبت شد</b>\n\nشناسه: <code>${purchaseId}</code>\n` +
    // Always the outcome the ledger stored, even when this tap asked for the opposite one.
    (resolution.outcome === API_PURCHASE_OUTCOMES.created ? `ثبت شد که سرویس ساخته شده بود (آن را در پنل ارائه‌دهنده بیابید).` : `ثبت شد که سرویسی ساخته نشده بود.`) +
    (resolution.matchesRequest ? "" : `\n\nℹ️ این خرید قبلاً با نتیجهٔ دیگری ثبت شده بود؛ نتیجهٔ ثبت‌شده در بالا نمایش داده شده است و تغییر نکرد.`) +
    (resolution.recovered ? `\n\n♻️ یک ثبت ناتمام قبلی برای این خرید اکنون تکمیل شد.` : "") +
    (remaining.length ? `\n\n⛔️ هنوز ${remaining.length} خرید بلاتکلیف دیگر وجود دارد.` : `\n\nمی‌توانید خرید جدیدی را از ابتدا آغاز کنید.`),
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "HTML",
      reply_markup: remaining.length
        ? reconcileKeyboard(remaining[0].purchaseId)
        : { inline_keyboard: [[{ text: "🏠 بازگشت", callback_data: "admin_back_to_panel" }]] },
    }
  ));
  await quietly(() => bot.answerCallbackQuery(query.id, { text: resolution.matchesRequest ? "✅ ثبت شد" : "ℹ️ نتیجهٔ قبلاً ثبت شده بود و تغییر نکرد." }));
};

// Handler برای لغو خرید
const cancelApiPurchase = async (bot, query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  const current = await getSession(chatId);
  // A running purchase cannot be cancelled from here; another admin's prompt is not ours to erase.
  if (isApiPurchaseInFlight(chatId)) {
    await quietly(() => bot.answerCallbackQuery(query.id, { text: "⏳ خرید در حال انجام است و لغو نمی‌شود.", show_alert: true }));
    return;
  }
  if (isActiveForeignAdminPrompt({ session: current, chatId, userId: query.from?.id })) return;

  try {
    await bot.editMessageText("❌ خرید سرویس لغو شد", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 بازگشت", callback_data: "admin_panel" }],
        ],
      },
    });

    // پاک کردن session
    await setSession(chatId, { step: null });

    await bot.answerCallbackQuery(query.id, {
      text: "❌ خرید لغو شد",
    });
  } catch (error) {
    console.error("Error in cancelApiPurchase:", error);
  }
};

export {
  apiServicePurchase,
  handleApiGigInput,
  handleApiDaysInput,
  createApiService,
  cancelApiPurchase,
  resolveApiPurchaseCallback,
};
