import { setSession } from "../config/sessionStore.js";
import { formatTopUpAmount, parseTopUpAmount, TOPUP_MAX_TOMAN, TOPUP_MIN_TOMAN } from "../utils/validationAmount.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../services/nowpayments/createInvoice.js";
import { fetchNowPaymentsCatalog, validateCatalogSelection } from "../services/nowpayments/catalog.js";
import { formatTrxAmount, quoteSnapshotIsFresh, quoteTronTopUp, resetTronQuoteCacheForTests } from "../services/pricing/tronQuote.js";
import { logQuoteFailure } from "../services/pricing/quoteLog.js";

const BACK = [[{ text: "🔙 بازگشت به روش‌های پرداخت", callback_data: "back_to_topup" }]];
const ASSET_BUTTON = [{ text: "🪙 انتخاب رمزارز / شبکه دیگر", callback_data: "np_select_currency" }];
const confirmLocks = new Set();
const recentCreates = new Map();

const FAILURE_TEXT = {
  not_configured: "❌ پرداخت با رمزارز موقتاً در دسترس نیست.\n\nلطفاً بعداً دوباره تلاش کنید یا روش دیگری را انتخاب کنید.",
  rate_unavailable: "❌ دریافت نرخ تبدیل تومان ممکن نیست.\n\nفاکتور ساخته نشد. لطفاً کمی بعد دوباره تلاش کنید.",
  invalid_rate: "❌ نرخ تبدیل تومان معتبر نیست.\n\nفاکتور ساخته نشد.",
  currency_unavailable: "❌ رمزارز یا شبکه انتخاب‌شده موقتاً در دسترس نیست.",
  invalid_currency_selection: "❌ رمزارز انتخاب‌شده در درگاه فعال نیست.",
  invalid_network_selection: "❌ شبکه انتخاب‌شده برای این رمزارز معتبر نیست.",
  network_selection_required: "⚠️ برای این رمزارز چند شبکه فعال وجود دارد؛ لطفاً شبکه را انتخاب کنید.",
  below_min_amount: "⚠️ مبلغ انتخاب‌شده کمتر از حداقل مجاز شبکه درگاه NOWPayments برای این رمزارز است.\n\nلطفاً مبلغ بیشتری وارد کنید یا شبکه دیگری انتخاب نمایید.",
  estimate_unavailable: "❌ دریافت برآورد لحظه‌ای رمزارز از درگاه ممکن نشد.\n\nلطفاً دوباره تلاش کنید.",
  provider_rejected: "❌ ایجاد فاکتور پرداخت ناموفق بود.\n\nلطفاً دوباره تلاش کنید یا روش دیگری را انتخاب کنید.",
  ambiguous: "❌ نتیجه ایجاد فاکتور نامشخص است.\n\nموجودی شما شارژ نشده است. لطفاً تا بررسی پشتیبانی، دوباره فاکتور نسازید.",
  malformed_response: "❌ پاسخ درگاه پرداخت نامعتبر بود و لینک پرداخت تحویل داده نشد.\n\nموجودی شما شارژ نشده است.",
  in_flight: "⏳ یک فاکتور رمزارزی هنوز تعیین‌تکلیف نشده است.\n\nتا مشخص شدن نتیجه، فاکتور جدیدی ساخته نمی‌شود.",
};

function quoteTime(quoteAt) {
  const date = new Date(quoteAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" });
}

function defaultSelectedAsset() {
  return {
    payCurrency: "trx",
    ticker: "TRX",
    network: "TRX",
    name: "TRON (TRX)",
    currencyPrecision: 6,
    minAmount: null,
  };
}

export function nowPaymentsAmountPrompt(selectedAsset = null) {
  const asset = selectedAsset || defaultSelectedAsset();
  const isDefaultTrx = String(asset.payCurrency || "trx").toLowerCase() === "trx";
  const header = isDefaultTrx
    ? "🪙 <b>پرداخت با ترون – NOWPayments</b>\n\n"
    : `🪙 <b>پرداخت با رمزارز (${asset.ticker} · شبکه ${asset.network}) – NOWPayments</b>\n\n`;
  return header
    + "🔹 <b>لطفاً مبلغ مورد نظر را به تومان وارد کنید.</b>\n"
    + "مثال: <code>50000</code> یا <code>200000</code>\n\n"
    + "🔻 <b>محدودیت مبلغ:</b>\n"
    + `▫️ حداقل: <code>${formatTopUpAmount(TOPUP_MIN_TOMAN)} تومان</code>\n`
    + `▫️ حداکثر: <code>${formatTopUpAmount(TOPUP_MAX_TOMAN)} تومان</code>`;
}

export function nowPaymentsConfirmMessage(quote) {
  const ticker = String(quote?.ticker || quote?.payCurrency || "TRX").toUpperCase();
  const network = String(quote?.network || ticker).toUpperCase();
  const precision = quote?.currencyPrecision ?? 6;
  const estimatedVal = quote?.estimatedAmount ?? quote?.estimatedTrx;
  const tomanPerCoin = quote?.tomanPerCrypto ?? quote?.tomanPerTrx;
  const amount = `💰 <b>مبلغ شارژ:</b> <code>${formatTopUpAmount(quote.amountToman)}</code> تومان`;
  const networkLine = ticker !== network
    ? `🌐 <b>رمزارز و شبکه:</b> <code>${ticker} (${network})</code>\n`
    : "";

  if (!Number.isFinite(estimatedVal) || !Number.isFinite(tomanPerCoin)) {
    return "🪙 <b>تأیید افزایش موجودی</b>\n\n"
      + `${amount}\n`
      + networkLine
      + "\nمبلغ نهایی در صفحه پرداخت نمایش داده می‌شود.\n"
      + "موجودی فقط پس از تأیید پرداخت، به همین مبلغ تومان شارژ می‌شود.";
  }
  const time = quoteTime(quote.quoteAt);
  return "🪙 <b>تأیید افزایش موجودی</b>\n\n"
    + `${amount}\n`
    + networkLine
    + `📊 <b>قیمت هر ${ticker}:</b> <code>${formatTopUpAmount(Math.round(tomanPerCoin))}</code> تومان\n`
    + `🪙 <b>برآورد پرداخت:</b> <code>${formatTrxAmount(estimatedVal, precision)}</code> ${ticker}\n`
    + `🕒 قیمت آنلاین${time ? ` · ${time}` : ""}\n\n`
    + "مبلغ برآوردی است و با مبلغ صفحه پرداخت یکی نیست. موجودی فقط پس از تأیید پرداخت، به همین مبلغ تومان شارژ می‌شود.";
}

export function nowPaymentsInvoiceMessage({ amountToman, payAmount, estimatedTrx, estimatedAmount, ticker = "TRX", network = "TRX", currencyPrecision = 6 }) {
  const cleanTicker = String(ticker || "TRX").toUpperCase();
  const cleanNetwork = String(network || cleanTicker).toUpperCase();
  const actual = formatTrxAmount(payAmount, currencyPrecision);
  const estimate = formatTrxAmount(estimatedAmount ?? estimatedTrx, currencyPrecision);
  const netSuffix = cleanTicker !== cleanNetwork ? ` (${cleanNetwork})` : "";
  const payable = actual
    ? `🪙 <b>مبلغ قابل پرداخت:</b> <code>${actual}</code> ${cleanTicker}${netSuffix}`
    : estimate
      ? `🪙 <b>برآورد پرداخت:</b> <code>${estimate}</code> ${cleanTicker}${netSuffix}`
      : "🪙 مبلغ نهایی در صفحه پرداخت نمایش داده می‌شود.";
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
  const selectedAsset = session?.nowpaymentsAsset || defaultSelectedAsset();
  if (query?.id) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* already answered */ }
  }
  try {
    await edit(bot, chatId, messageId, nowPaymentsAmountPrompt(selectedAsset), [
      ASSET_BUTTON,
      ...BACK,
    ]);
  } catch (error) {
    console.error("[payNowPayments] prompt error:", error?.name || "TelegramError");
  }
  await setSession(chatId, {
    ...session,
    step: "waiting_for_nowpayments_amount",
    messageId,
    paymentType: "nowpayments",
    ownerId: query?.from?.id ?? chatId,
    nowpaymentsAsset: selectedAsset,
    nowpaymentsQuote: null,
  });
}

export async function handleNowPaymentsCurrencyMenu(bot, query, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  if (query?.id) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* already answered */ }
  }
  try {
    const catalog = deps.catalog || await (deps.fetchCatalog || fetchNowPaymentsCatalog)({
      env: deps.env || process.env,
      request: deps.request,
    });
    const groups = catalog.groups.slice(0, 18);
    const rows = [];
    for (let i = 0; i < groups.length; i += 2) {
      rows.push(
        groups.slice(i, i + 2).map((group) => ({
          text: group.requiresNetworkSelection
            ? `🪙 ${group.ticker} (${group.networks.length} شبکه)`
            : `🪙 ${group.ticker} (${group.networks[0]?.network || group.ticker})`,
          callback_data: `np_asset:${group.ticker}`,
        })),
      );
    }
    rows.push(...BACK);
    await edit(
      bot,
      chatId,
      messageId,
      "🪙 <b>انتخاب رمزارز پرداخت (NOWPayments)</b>\n\nلطفاً رمزارز مورد نظر خود را از فهرست دارایی‌های فعال انتخاب کنید:",
      rows,
    );
  } catch (error) {
    const code = error?.code || "currency_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.currency_unavailable, BACK);
    } catch { /* ignore */ }
  }
}

export async function handleNowPaymentsSelectAsset(bot, query, tickerInput, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  if (query?.id) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* already answered */ }
  }
  const cleanTicker = String(tickerInput || "").trim().toUpperCase();
  try {
    const catalog = deps.catalog || await (deps.fetchCatalog || fetchNowPaymentsCatalog)({
      env: deps.env || process.env,
      request: deps.request,
    });
    const group = catalog.groups.find((item) => item.ticker === cleanTicker);
    if (!group || !group.networks.length) {
      throw Object.assign(new Error("currency_unavailable"), { code: "currency_unavailable" });
    }
    if (group.requiresNetworkSelection) {
      await setSession(chatId, {
        ...session,
        step: "waiting_for_nowpayments_network",
        messageId,
        paymentType: "nowpayments",
        nowpaymentsPendingTicker: group.ticker,
        nowpaymentsQuote: null,
      });
      const netRows = group.networks.map((net) => ([{
        text: `🌐 شبکه ${net.network} (${net.payCurrency.toUpperCase()})`,
        callback_data: `np_net:${net.payCurrency}`,
      }]));
      netRows.push([{ text: "🔙 بازگشت به انتخاب رمزارز", callback_data: "np_select_currency" }]);
      await edit(
        bot,
        chatId,
        messageId,
        `🌐 <b>انتخاب شبکه برای ${group.ticker}</b>\n\nلطفاً شبکه انتقال مورد نظر را انتخاب کنید:`,
        netRows,
      );
      return;
    }
    await handleNowPaymentsSelectNetwork(bot, query, group.networks[0].payCurrency, session, {
      ...deps,
      catalog,
    });
  } catch (error) {
    const code = error?.code || "currency_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.currency_unavailable, BACK);
    } catch { /* ignore */ }
  }
}

export async function handleNowPaymentsSelectNetwork(bot, query, payCurrencyInput, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  if (query?.id) {
    try { await bot.answerCallbackQuery(query.id); } catch { /* already answered */ }
  }
  try {
    const catalog = deps.catalog || await (deps.fetchCatalog || fetchNowPaymentsCatalog)({
      env: deps.env || process.env,
      request: deps.request,
    });
    const asset = validateCatalogSelection(catalog, { payCurrency: payCurrencyInput });
    const selectedAsset = {
      payCurrency: asset.code,
      ticker: asset.ticker,
      network: asset.network,
      name: asset.name,
      currencyPrecision: asset.networkPrecision ?? 6,
      minAmount: asset.minAmount ?? null,
    };

    const existingAmount = session?.nowpaymentsAmount;
    if (Number.isSafeInteger(existingAmount) && existingAmount >= TOPUP_MIN_TOMAN && existingAmount <= TOPUP_MAX_TOMAN) {
      const quoteFor = deps.quoteTronTopUp || quoteTronTopUp;
      const quote = await quoteFor({
        amountToman: existingAmount,
        payCurrency: selectedAsset.payCurrency,
        ticker: selectedAsset.ticker,
        network: selectedAsset.network,
        currencyPrecision: selectedAsset.currencyPrecision,
        catalogMinAmount: selectedAsset.minAmount,
        env: deps.env || process.env,
        now: new Date(),
      });
      await setSession(chatId, {
        ...session,
        step: "nowpayments_confirm",
        messageId,
        paymentType: "nowpayments",
        ownerId: session?.ownerId ?? chatId,
        nowpaymentsAsset: selectedAsset,
        nowpaymentsAmount: existingAmount,
        nowpaymentsQuote: quote,
      });
      await edit(bot, chatId, messageId, nowPaymentsConfirmMessage(quote), [
        [{ text: "✅ ایجاد فاکتور پرداخت", callback_data: "np_create" }],
        ASSET_BUTTON,
        ...BACK,
      ]);
      return;
    }

    await setSession(chatId, {
      ...session,
      step: "waiting_for_nowpayments_amount",
      messageId,
      paymentType: "nowpayments",
      ownerId: session?.ownerId ?? chatId,
      nowpaymentsAsset: selectedAsset,
      nowpaymentsQuote: null,
    });
    await edit(bot, chatId, messageId, nowPaymentsAmountPrompt(selectedAsset), [
      ASSET_BUTTON,
      ...BACK,
    ]);
  } catch (error) {
    const code = error?.code || "currency_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.currency_unavailable, [
        ASSET_BUTTON,
        ...BACK,
      ]);
    } catch { /* ignore */ }
  }
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
      await edit(bot, chatId, messageId, validation.message, [
        ASSET_BUTTON,
        ...BACK,
      ]);
    } catch (error) {
      console.error("[handleNowPaymentsAmount] validation prompt error:", error?.name || "TelegramError");
    }
    return;
  }

  const selectedAsset = session?.nowpaymentsAsset || defaultSelectedAsset();
  const quoteFor = deps.quoteTronTopUp || quoteTronTopUp;
  let quote;
  try {
    quote = await quoteFor({
      amountToman: validation.amount,
      payCurrency: selectedAsset.payCurrency,
      ticker: selectedAsset.ticker,
      network: selectedAsset.network,
      currencyPrecision: selectedAsset.currencyPrecision,
      catalogMinAmount: selectedAsset.minAmount,
      env: process.env,
      now: new Date(),
    });
  } catch (error) {
    logQuoteFailure("topup_quote", error);
    const code = error?.code || "rate_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.rate_unavailable, [
        ASSET_BUTTON,
        ...BACK,
      ]);
    } catch { /* ignore */ }
    return;
  }

  await setSession(chatId, {
    ...session,
    step: "nowpayments_confirm",
    messageId,
    paymentType: "nowpayments",
    ownerId: session?.ownerId ?? chatId,
    nowpaymentsAsset: selectedAsset,
    nowpaymentsAmount: validation.amount,
    nowpaymentsQuote: quote,
  });
  try {
    await edit(bot, chatId, messageId, nowPaymentsConfirmMessage(quote), [
      [{ text: "✅ ایجاد فاکتور پرداخت", callback_data: "np_create" }],
      ASSET_BUTTON,
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
  const selectedAsset = session?.nowpaymentsAsset || defaultSelectedAsset();
  const assetMatchesSnapshot = !snapshot?.payCurrency
    || String(snapshot.payCurrency).toLowerCase() === String(selectedAsset.payCurrency || "trx").toLowerCase();

  if (
    session?.step !== "nowpayments_confirm"
    || !snapshot
    || !assetMatchesSnapshot
    || !quoteSnapshotIsFresh({ ...snapshot, amountToman: amount })
  ) {
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

  const createKey = `${chatId}:${amount}:${snapshot.confirmedAt}:${selectedAsset.payCurrency}`;
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
      payCurrency: snapshot.payCurrency || selectedAsset.payCurrency,
      ticker: snapshot.ticker || selectedAsset.ticker,
      network: snapshot.network || selectedAsset.network,
      currencyPrecision: snapshot.currencyPrecision ?? selectedAsset.currencyPrecision,
      quote: snapshot,
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
        estimatedAmount: snapshot.estimatedAmount,
        ticker: invoice.ticker || snapshot.ticker || selectedAsset.ticker,
        network: invoice.network || snapshot.network || selectedAsset.network,
        currencyPrecision: snapshot.currencyPrecision ?? selectedAsset.currencyPrecision,
      }),
      [
        [{ text: "🪙 پرداخت فاکتور", url: invoice.invoiceUrl }],
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
