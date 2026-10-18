import { setSession } from "../config/sessionStore.js";
import { formatTopUpAmount, parseTopUpAmount, TOPUP_MAX_TOMAN, TOPUP_MIN_TOMAN } from "../utils/validationAmount.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../services/nowpayments/createInvoice.js";
import { formatTrxAmount, quoteSnapshotIsFresh, quoteTronTopUp, resetTronQuoteCacheForTests } from "../services/pricing/tronQuote.js";
import { logQuoteFailure } from "../services/pricing/quoteLog.js";

const BACK = [[{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }]];
const confirmLocks = new Set();
const recentCreates = new Map();

const FAILURE_TEXT = {
  not_configured: "❌ پرداخت با ترون موقتاً در دسترس نیست.\n\nلطفاً بعداً دوباره تلاش کنید یا روش دیگری را انتخاب کنید.",
  rate_unavailable: "❌ دریافت نرخ تبدیل تومان ممکن نیست.\n\nفاکتور ساخته نشد. لطفاً کمی بعد دوباره تلاش کنید.",
  invalid_rate: "❌ نرخ تبدیل تومان معتبر نیست.\n\nفاکتور ساخته نشد.",
  currency_unavailable: "❌ پرداخت با ترون موقتاً در دسترس نیست.",
  provider_rejected: "❌ ایجاد فاکتور پرداخت ناموفق بود.\n\nلطفاً دوباره تلاش کنید یا روش دیگری را انتخاب کنید.",
  ambiguous: "❌ نتیجه ایجاد فاکتور نامشخص است.\n\nموجودی شما شارژ نشده است. لطفاً تا بررسی پشتیبانی، دوباره فاکتور نسازید.",
  malformed_response: "❌ پاسخ درگاه پرداخت نامعتبر بود و لینک پرداخت تحویل داده نشد.\n\nموجودی شما شارژ نشده است.",
  in_flight: "⏳ یک فاکتور ترون هنوز تعیین‌تکلیف نشده است.\n\nتا مشخص شدن نتیجه، فاکتور جدیدی ساخته نمی‌شود.",
};

function quoteTime(quoteAt) {
  const date = new Date(quoteAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" });
}

export function nowPaymentsAmountPrompt() {
  return "₮ <b>پرداخت با ترون – NOWPayments</b>\n\n"
    + "🔹 <b>لطفاً مبلغ مورد نظر را به تومان وارد کنید.</b>\n"
    + "مثال: <code>50000</code> یا <code>200000</code>\n\n"
    + "🔻 <b>محدودیت مبلغ:</b>\n"
    + `▫️ حداقل: <code>${formatTopUpAmount(TOPUP_MIN_TOMAN)} تومان</code>\n`
    + `▫️ حداکثر: <code>${formatTopUpAmount(TOPUP_MAX_TOMAN)} تومان</code>`;
}

export function nowPaymentsConfirmMessage(quote) {
  const amount = `💰 <b>مبلغ شارژ:</b> <code>${formatTopUpAmount(quote.amountToman)}</code> تومان`;
  if (!Number.isFinite(quote?.estimatedTrx) || !Number.isFinite(quote?.tomanPerTrx)) {
    return "₮ <b>تأیید افزایش موجودی</b>\n\n"
      + `${amount}\n\n`
      + "مبلغ نهایی ترون در صفحه پرداخت نمایش داده می‌شود.\n"
      + "موجودی فقط پس از تأیید پرداخت، به همین مبلغ تومان شارژ می‌شود.";
  }
  const time = quoteTime(quote.quoteAt);
  return "₮ <b>تأیید افزایش موجودی</b>\n\n"
    + `${amount}\n`
    + `📊 <b>قیمت هر TRX:</b> <code>${formatTopUpAmount(Math.round(quote.tomanPerTrx))}</code> تومان\n`
    + `🪙 <b>برآورد پرداخت:</b> <code>${formatTrxAmount(quote.estimatedTrx)}</code> TRX\n`
    + `🕒 قیمت آنلاین${time ? ` · ${time}` : ""}\n\n`
    + "مبلغ ترون برآوردی است و با مبلغ صفحه پرداخت یکی نیست. موجودی فقط پس از تأیید پرداخت، به همین مبلغ تومان شارژ می‌شود.";
}

export function nowPaymentsInvoiceMessage({ amountToman, payAmount, estimatedTrx }) {
  const actual = formatTrxAmount(payAmount);
  const estimate = formatTrxAmount(estimatedTrx);
  const payable = actual
    ? `🪙 <b>مبلغ قابل پرداخت:</b> <code>${actual}</code> TRX`
    : estimate
      ? `🪙 <b>برآورد پرداخت:</b> <code>${estimate}</code> TRX`
      : "🪙 مبلغ ترون در صفحه پرداخت نمایش داده می‌شود.";
  return "✅ <b>فاکتور پرداخت ایجاد شد</b>\n\n"
    + `💰 <b>مبلغ شارژ:</b> <code>${formatTopUpAmount(amountToman)}</code> تومان\n`
    + `${payable}\n\n`
    + "موجودی پس از تأیید پرداخت اضافه می‌شود.";
}

async function edit(bot, chatId, messageId, text, keyboard) {
  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function payNowPayments(bot, query, session) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  if (query?.id) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* already answered */ }
  }
  try {
    await edit(bot, chatId, messageId, nowPaymentsAmountPrompt(), BACK);
  } catch (error) {
    console.error("[payNowPayments] prompt error:", error?.name || "TelegramError");
  }
  await setSession(chatId, {
    ...session,
    step: "waiting_for_nowpayments_amount",
    messageId,
    paymentType: "nowpayments",
    ownerId: query?.from?.id ?? chatId,
  });
}

export async function handleNowPaymentsAmount(bot, msg, session, deps = {}) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const messageId = session?.messageId;
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  if (session?.step === "creating_nowpayments_invoice") {
    try {
      await edit(bot, chatId, messageId, "⏳ <b>فاکتور در حال ایجاد است...</b>\n\nلطفاً چند لحظه صبر کنید.", []);
    } catch { /* ignore */ }
    return;
  }

  const validation = parseTopUpAmount(text, TOPUP_MIN_TOMAN, TOPUP_MAX_TOMAN);
  if (!validation.valid) {
    try {
      await edit(bot, chatId, messageId, validation.message, BACK);
    } catch (error) {
      console.error("[handleNowPaymentsAmount] validation prompt error:", error?.name || "TelegramError");
    }
    return;
  }

  const quoteFor = deps.quoteTronTopUp || quoteTronTopUp;
  let quote;
  try {
    quote = await quoteFor({ amountToman: validation.amount, env: process.env, now: new Date() });
  } catch (error) {
    logQuoteFailure("topup_quote", error);
    const code = error?.code || "rate_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.rate_unavailable, BACK);
    } catch { /* ignore */ }
    return;
  }

  await setSession(chatId, {
    ...session,
    step: "nowpayments_confirm",
    messageId,
    paymentType: "nowpayments",
    ownerId: session?.ownerId ?? chatId,
    nowpaymentsAmount: validation.amount,
    nowpaymentsQuote: quote,
  });
  try {
    await edit(bot, chatId, messageId, nowPaymentsConfirmMessage(quote), [
      [{ text: "✅ ایجاد فاکتور پرداخت", callback_data: "np_create" }],
      ...BACK,
    ]);
  } catch (error) {
    console.error("[handleNowPaymentsAmount] confirmation error:", error?.name || "TelegramError");
  }
}

export async function confirmNowPaymentsTopUp(bot, query, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  if (query?.id) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* already answered */ }
  }
  const ownerId = Number(session?.ownerId ?? chatId);
  if (query?.from?.id != null && Number(query.from.id) !== ownerId) return;
  if (session?.step === "creating_nowpayments_invoice" || confirmLocks.has(String(chatId))) return;

  const amount = session?.nowpaymentsAmount;
  const snapshot = session?.nowpaymentsQuote;
  if (session?.step !== "nowpayments_confirm" || !snapshot || !quoteSnapshotIsFresh({ ...snapshot, amountToman: amount })) {
    try {
      await edit(bot, chatId, messageId, "❌ نرخ لحظه‌ای منقضی شده است.\n\nلطفاً مبلغ را دوباره وارد کنید.", BACK);
    } catch { /* ignore */ }
    await setSession(chatId, {
      ...session,
      step: "waiting_for_nowpayments_amount",
      messageId,
      paymentType: "nowpayments",
    });
    return;
  }

  const createKey = `${chatId}:${amount}:${snapshot.confirmedAt}`;
  if (recentCreates.has(createKey) && Date.now() - recentCreates.get(createKey) < 60_000) return;
  recentCreates.set(createKey, Date.now());
  confirmLocks.add(String(chatId));
  await setSession(chatId, {
    ...session,
    step: "creating_nowpayments_invoice",
    messageId,
    paymentType: "nowpayments",
  });
  try {
    await edit(bot, chatId, messageId, "⏳ <b>در حال ایجاد فاکتور پرداخت...</b>\n\nلطفاً چند لحظه صبر کنید.", []);
  } catch { /* ignore */ }

  const create = deps.createNowPaymentsTopUp || createNowPaymentsTopUp;
  let invoice;
  try {
    invoice = await create({
      userId: chatId,
      amountToman: amount,
      resolveRate: async () => ({ tomanPerFiat: snapshot.tomanPerUsdt, source: "gheymat", quoteAt: snapshot.quoteAt }),
    });
  } catch (error) {
    logQuoteFailure("nowpayments_invoice", error);
    const code = error?.code || "provider_rejected";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.provider_rejected, BACK);
    } catch { /* ignore */ }
    if (code !== "ambiguous" && code !== "in_flight") recentCreates.delete(createKey);
    await setSession(chatId, {
      ...session,
      step: code === "ambiguous" || code === "in_flight" ? "nowpayments_review" : "waiting_for_nowpayments_amount",
      messageId,
      paymentType: "nowpayments",
    });
    return;
  } finally {
    confirmLocks.delete(String(chatId));
  }

  await setSession(chatId, {
    ...session,
    step: "waiting_for_nowpayments_payment",
    paymentType: "nowpayments",
    paymentId: invoice.orderId,
    messageId,
    ownerId,
  });
  try {
    await edit(
      bot,
      chatId,
      messageId,
      nowPaymentsInvoiceMessage({
        amountToman: amount,
        payAmount: invoice.payAmount,
        estimatedTrx: snapshot.estimatedTrx,
      }),
      [
        [{ text: "₮ پرداخت فاکتور", url: invoice.invoiceUrl }],
        [{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }],
      ],
    );
  } catch (error) {
    console.error("[confirmNowPaymentsTopUp] invoice message error:", error?.name || "TelegramError");
  }
}

export function resetNowPaymentsConfirmLocksForTests() {
  confirmLocks.clear();
  recentCreates.clear();
  resetNowPaymentsCreateLocksForTests();
  resetTronQuoteCacheForTests();
}
