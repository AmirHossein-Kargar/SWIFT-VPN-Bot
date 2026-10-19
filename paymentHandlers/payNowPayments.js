import { setSession } from "../config/sessionStore.js";
import { formatTopUpAmount, parseTopUpAmount, resolveTopUpLimits } from "../utils/validationAmount.js";
import NowPaymentsInvoice from "../models/NowPaymentsInvoice.js";
import { currencyGroupLabel, networkLabel, paginateGroups } from "../services/nowpayments/labels.js";
import { createNowPaymentsTopUp, resetNowPaymentsCreateLocksForTests } from "../services/nowpayments/createInvoice.js";
import { fetchNowPaymentsCatalog, validateCatalogSelection } from "../services/nowpayments/catalog.js";
import { formatTrxAmount, quoteSnapshotIsFresh, quoteTronTopUp, resetTronQuoteCacheForTests } from "../services/pricing/tronQuote.js";
import { logQuoteFailure } from "../services/pricing/quoteLog.js";

const BACK = [[{ text: "🔙 بازگشت", callback_data: "back_to_topup" }]];
const BACK_TO_CURRENCY = [{ text: "🔙 بازگشت", callback_data: "np_select_currency" }];
const CANCEL = [{ text: "❌ لغو عملیات", callback_data: "np_cancel" }];
const ASSET_BUTTON = [{ text: "🪙 تغییر رمزارز / شبکه", callback_data: "np_select_currency" }];
// Steps in which a currency / network / confirm button is still meaningful.
// Anything else is a stale keyboard and must not drive the flow.
const FLOW_STEPS = new Set([
  "waiting_for_nowpayments_currency",
  "waiting_for_nowpayments_network",
  "waiting_for_nowpayments_amount",
  "nowpayments_confirm",
]);
const ORDER_ID_PATTERN = /^NP-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const ticker = String(asset.ticker || "TRX").toUpperCase();
  const network = String(asset.network || ticker).toUpperCase();
  const assetLine = ticker !== network
    ? `<b>${ticker}</b> · شبکه <b>${network}</b>`
    : `<b>${ticker}</b>`;
  const { min, max } = resolveTopUpLimits();
  return "🪙 <b>مبلغ شارژ را وارد کنید</b>\n\n"
    + `رمزارز انتخابی: ${assetLine}\n\n`
    + "مبلغ موردنظر خود را به تومان وارد کنید.\n"
    + "مثال: <code>50000</code> یا <code>200000</code>\n\n"
    + `▫️ حداقل: <code>${formatTopUpAmount(min)}</code> تومان\n`
    + `▫️ حداکثر: <code>${formatTopUpAmount(max)}</code> تومان`;
}

function amountKeyboard() {
  return [ASSET_BUTTON, CANCEL];
}

function confirmKeyboard() {
  return [
    [{ text: "✅ تأیید و ایجاد فاکتور پرداخت", callback_data: "np_create" }],
    [{ text: "🔙 بازگشت", callback_data: "np_back_amount" }, ...CANCEL],
  ];
}

export function nowPaymentsConfirmMessage(quote) {
  const ticker = String(quote?.ticker || quote?.payCurrency || "TRX").toUpperCase();
  const network = String(quote?.network || ticker).toUpperCase();
  const precision = quote?.currencyPrecision ?? 6;
  const estimatedVal = quote?.estimatedAmount ?? quote?.estimatedTrx;
  const tomanPerCoin = quote?.tomanPerCrypto ?? quote?.tomanPerTrx;
  const amountText = formatTopUpAmount(quote.amountToman);
  const amount = `💰 <b>مبلغ شارژ:</b> <code>${amountText}</code> تومان`;
  const networkLine = ticker !== network
    ? `🌐 <b>رمزارز و شبکه:</b> <code>${ticker} (${network})</code>\n`
    : "";
  const closing = "مبلغ پرداختی تقریبی است و ممکن است با مبلغ نهایی صفحه پرداخت تفاوت داشته باشد. "
    + `موجودی کیف پول فقط پس از تأیید معتبر پرداخت، به مبلغ <code>${amountText}</code> تومان شارژ خواهد شد.`;

  if (!Number.isFinite(estimatedVal) || !Number.isFinite(tomanPerCoin)) {
    return "🪙 <b>تأیید افزایش موجودی</b>\n\n"
      + `${amount}\n`
      + networkLine
      + "\nبرآورد لحظه‌ای مبلغ رمزارز در دسترس نیست؛ مبلغ نهایی در صفحه پرداخت نمایش داده می‌شود.\n"
      + `موجودی کیف پول فقط پس از تأیید معتبر پرداخت، به مبلغ <code>${amountText}</code> تومان شارژ خواهد شد.`;
  }
  const time = quoteTime(quote.quoteAt);
  return "🪙 <b>تأیید افزایش موجودی</b>\n\n"
    + `${amount}\n`
    + networkLine
    + `📊 <b>قیمت هر ${ticker}:</b> <code>${formatTopUpAmount(Math.round(tomanPerCoin))}</code> تومان\n`
    + `🪙 <b>برآورد پرداخت:</b> <code>${formatTrxAmount(estimatedVal, precision)}</code> ${ticker}\n`
    + `🕒 قیمت آنلاین${time ? ` · <code>${time}</code>` : ""}\n\n`
    + closing;
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
  const warning = cleanTicker !== cleanNetwork
    ? `\n⚠️ فقط از طریق شبکه <b>${cleanNetwork}</b> پرداخت کنید؛ ارسال از شبکه دیگر ممکن است باعث از دست رفتن وجه شود.\n`
    : "";
  return "✅ <b>فاکتور پرداخت ایجاد شد</b>\n\n"
    + `💰 <b>مبلغ شارژ:</b> <code>${formatTopUpAmount(amountToman)}</code> تومان\n`
    + `${payable}\n${warning}\n`
    + "موجودی فقط پس از تأیید معتبر پرداخت اضافه می‌شود.";
}

async function edit(bot, chatId, messageId, text, keyboard) {
  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function ack(bot, query, text) {
  if (!query?.id) return;
  try {
    await bot.answerCallbackQuery(query.id, text ? { text } : undefined);
  } catch { /* already answered */ }
}

function isOwner(query, session, chatId) {
  const ownerId = Number(session?.ownerId ?? chatId);
  return query?.from?.id == null || Number(query.from.id) === ownerId;
}

function flowIsActive(session) {
  return session?.paymentType === "nowpayments" && FLOW_STEPS.has(session?.step);
}

async function showExpiredKeyboard(bot, chatId, messageId) {
  try {
    await edit(
      bot,
      chatId,
      messageId,
      "⚠️ این صفحه منقضی شده است.\n\nلطفاً روند افزایش موجودی را دوباره شروع کنید.",
      BACK,
    );
  } catch { /* ignore */ }
}

/**
 * Entry point of "پرداخت با کریپتو": always starts at currency selection and
 * drops any previous amount / asset / quote so nothing stale is reused.
 */
export async function payNowPayments(bot, query, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  const fresh = {
    step: "waiting_for_nowpayments_currency",
    messageId,
    paymentType: "nowpayments",
    ownerId: query?.from?.id ?? chatId,
    nowpaymentsAsset: null,
    nowpaymentsAmount: null,
    nowpaymentsQuote: null,
    nowpaymentsPendingTicker: null,
    nowpaymentsPage: 0,
  };
  await setSession(chatId, fresh);
  await handleNowPaymentsCurrencyMenu(bot, query, fresh, { ...deps, page: 0 });
}

export async function handleNowPaymentsCurrencyMenu(bot, query, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  await ack(bot, query);
  if (!isOwner(query, session, chatId)) return;
  if (!flowIsActive(session)) {
    await showExpiredKeyboard(bot, chatId, messageId);
    return;
  }
  try {
    const catalog = deps.catalog || await (deps.fetchCatalog || fetchNowPaymentsCatalog)({
      env: deps.env || process.env,
      request: deps.request,
    });
    const view = paginateGroups(catalog.groups, deps.page ?? 0);
    const rows = [];
    for (let i = 0; i < view.items.length; i += 2) {
      rows.push(view.items.slice(i, i + 2).map((group) => ({
        text: currencyGroupLabel(group),
        callback_data: `np_asset:${group.ticker}`,
      })));
    }
    if (view.pages > 1) {
      const nav = [];
      if (view.page > 0) nav.push({ text: "◀️ قبلی", callback_data: `np_page:${view.page - 1}` });
      nav.push({ text: `${view.page + 1}/${view.pages}`, callback_data: "np_noop" });
      if (view.page < view.pages - 1) nav.push({ text: "بعدی ▶️", callback_data: `np_page:${view.page + 1}` });
      rows.push(nav);
    }
    rows.push([{ text: "🔙 بازگشت", callback_data: "back_to_topup" }, ...CANCEL]);
    await setSession(chatId, {
      ...session,
      step: "waiting_for_nowpayments_currency",
      messageId,
      paymentType: "nowpayments",
      ownerId: session?.ownerId ?? query?.from?.id ?? chatId,
      nowpaymentsAsset: null,
      nowpaymentsAmount: null,
      nowpaymentsQuote: null,
      nowpaymentsPendingTicker: null,
      nowpaymentsPage: view.page,
    });
    await edit(
      bot,
      chatId,
      messageId,
      "🪙 <b>پرداخت با کریپتو</b>\n\nلطفاً رمزارز موردنظر خود را انتخاب کنید.\n"
        + "برای رمزارزهایی که چند شبکه دارند، در مرحله بعد شبکه را انتخاب می‌کنید.",
      rows,
    );
  } catch (error) {
    const code = error?.code || "currency_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.currency_unavailable, BACK);
    } catch { /* ignore */ }
  }
}

export async function handleNowPaymentsPage(bot, query, pageInput, session, deps = {}) {
  const page = /^\d{1,3}$/.test(String(pageInput)) ? Number(pageInput) : 0;
  await handleNowPaymentsCurrencyMenu(bot, query, session, { ...deps, page });
}

export async function handleNowPaymentsSelectAsset(bot, query, tickerInput, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  await ack(bot, query);
  if (!isOwner(query, session, chatId)) return;
  if (!flowIsActive(session)) {
    await showExpiredKeyboard(bot, chatId, messageId);
    return;
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
        text: networkLabel(group.ticker, net.network),
        callback_data: `np_net:${net.payCurrency}`,
      }]));
      netRows.push([...BACK_TO_CURRENCY, ...CANCEL]);
      await edit(
        bot,
        chatId,
        messageId,
        `🌐 <b>انتخاب شبکه برای ${group.ticker}</b>\n\n`
          + "لطفاً شبکه‌ای را انتخاب کنید که کیف پول مبدأ شما از آن پشتیبانی می‌کند.\n"
          + "⚠️ ارسال وجه از شبکه اشتباه باعث از دست رفتن آن می‌شود.",
        netRows,
      );
      return;
    }
    await handleNowPaymentsSelectNetwork(bot, query, group.networks[0].payCurrency, session, {
      ...deps,
      catalog,
      skipAck: true,
    });
  } catch (error) {
    const code = error?.code || "currency_unavailable";
    try {
      await edit(bot, chatId, messageId, FAILURE_TEXT[code] || FAILURE_TEXT.currency_unavailable, [ASSET_BUTTON, ...BACK]);
    } catch { /* ignore */ }
  }
}

export async function handleNowPaymentsSelectNetwork(bot, query, payCurrencyInput, session, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  if (!deps.skipAck) await ack(bot, query);
  if (!isOwner(query, session, chatId)) return;
  if (!flowIsActive(session)) {
    await showExpiredKeyboard(bot, chatId, messageId);
    return;
  }
  try {
    const catalog = deps.catalog || await (deps.fetchCatalog || fetchNowPaymentsCatalog)({
      env: deps.env || process.env,
      request: deps.request,
    });
    const asset = validateCatalogSelection(catalog, { payCurrency: payCurrencyInput });
    // A network button is only valid for the ticker the user just picked.
    if (session?.nowpaymentsPendingTicker && asset.ticker !== session.nowpaymentsPendingTicker) {
      throw Object.assign(new Error("invalid_network_selection"), { code: "invalid_network_selection" });
    }
    const selectedAsset = {
      payCurrency: asset.code,
      ticker: asset.ticker,
      network: asset.network,
      name: asset.name,
      currencyPrecision: asset.networkPrecision ?? 6,
      minAmount: asset.minAmount ?? null,
    };

    const { min, max } = resolveTopUpLimits();
    const existingAmount = session?.nowpaymentsAmount;
    if (Number.isSafeInteger(existingAmount) && existingAmount >= min && existingAmount <= max) {
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
        nowpaymentsPendingTicker: null,
        nowpaymentsAmount: existingAmount,
        nowpaymentsQuote: quote,
      });
      await edit(bot, chatId, messageId, nowPaymentsConfirmMessage(quote), confirmKeyboard());
      return;
    }

    await setSession(chatId, {
      ...session,
      step: "waiting_for_nowpayments_amount",
      messageId,
      paymentType: "nowpayments",
      ownerId: session?.ownerId ?? chatId,
      nowpaymentsAsset: selectedAsset,
      nowpaymentsPendingTicker: null,
      nowpaymentsQuote: null,
    });
    await edit(bot, chatId, messageId, nowPaymentsAmountPrompt(selectedAsset), amountKeyboard());
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

/** Confirmation -> amount prompt (keeps the selected currency). */
export async function handleNowPaymentsBackToAmount(bot, query, session) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  await ack(bot, query);
  if (!isOwner(query, session, chatId)) return;
  if (!flowIsActive(session) || !session?.nowpaymentsAsset) {
    await showExpiredKeyboard(bot, chatId, messageId);
    return;
  }
  await setSession(chatId, {
    ...session,
    step: "waiting_for_nowpayments_amount",
    messageId,
    nowpaymentsAmount: null,
    nowpaymentsQuote: null,
  });
  try {
    await edit(bot, chatId, messageId, nowPaymentsAmountPrompt(session.nowpaymentsAsset), amountKeyboard());
  } catch { /* ignore */ }
}

/** Cancels the pre-invoice part of the flow. Created invoices are never touched. */
export async function handleNowPaymentsCancel(bot, query, session) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = session?.messageId ?? query?.message?.message_id;
  await ack(bot, query);
  if (!isOwner(query, session, chatId)) return;
  if (session?.step === "creating_nowpayments_invoice") return;
  await setSession(chatId, { step: null });
  try {
    await edit(bot, chatId, messageId, "❌ عملیات لغو شد.\n\nهیچ فاکتوری ایجاد نشد و مبلغی از شما کسر نشده است.", [
      [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
    ]);
  } catch { /* ignore */ }
}

const STATUS_TEXT = {
  creating: "⏳ فاکتور در حال ایجاد است.",
  creation_unknown: "⚠️ نتیجه ایجاد فاکتور هنوز مشخص نیست. موجودی شما شارژ نشده است؛ لطفاً با پشتیبانی تماس بگیرید.",
  creation_failed: "❌ ایجاد فاکتور ناموفق بود. موجودی شما شارژ نشده است.",
  pending: "⏳ فاکتور ایجاد شده و منتظر پرداخت است.",
  waiting: "⏳ منتظر پرداخت شما هستیم.",
  confirming: "🔄 پرداخت دریافت شد و در انتظار تأیید شبکه است.",
  confirmed: "🔄 پرداخت تأیید شبکه شد و در حال نهایی‌سازی است.",
  sending: "🔄 پرداخت در حال نهایی‌سازی است.",
  partially_paid: "⚠️ مبلغ پرداختی کمتر از مبلغ فاکتور است. پرداخت برای بررسی به پشتیبانی ارجاع شد.",
  failed: "❌ پرداخت ناموفق بود. موجودی شما شارژ نشده است.",
  expired: "⌛️ فاکتور منقضی شده است. اگر مبلغی پرداخت کرده‌اید با پشتیبانی تماس بگیرید.",
  refunded: "↩️ مبلغ پرداخت بازگشت داده شد.",
};

export function nowPaymentsStatusMessage(invoice) {
  const amount = `💰 <b>مبلغ شارژ:</b> <code>${formatTopUpAmount(invoice.amountToman)}</code> تومان`;
  let line;
  if (invoice.balanceCredited && invoice.status === "finished") {
    line = "✅ پرداخت تأیید شد و کیف پول شما شارژ شد.";
  } else if (invoice.status === "finished") {
    line = "🔄 پرداخت تأیید شد؛ شارژ کیف پول در حال نهایی‌سازی است.";
  } else {
    line = STATUS_TEXT[invoice.status] || "⏳ وضعیت پرداخت در حال بررسی است.";
  }
  const review = invoice.recoveryStatus === "required" && invoice.status !== "partially_paid"
    ? "\n\n⚠️ این پرداخت برای بررسی به پشتیبانی ارجاع شده است."
    : "";
  return `🔍 <b>وضعیت پرداخت</b>\n\n${amount}\n${line}${review}`;
}

/** Read-only status lookup of the caller's own invoice; never creates anything. */
export async function handleNowPaymentsStatus(bot, query, orderIdInput, deps = {}) {
  const chatId = query?.message?.chat?.id ?? query?.from?.id;
  const messageId = query?.message?.message_id;
  const orderId = String(orderIdInput || "");
  if (!ORDER_ID_PATTERN.test(orderId)) {
    await ack(bot, query, "⚠️ شناسه فاکتور نامعتبر است.");
    return;
  }
  const model = deps.invoiceModel || NowPaymentsInvoice;
  let invoice;
  try {
    const found = model.findOne({ orderId, userId: Number(query?.from?.id ?? chatId) });
    invoice = typeof found?.lean === "function" ? await found.lean() : await found;
  } catch {
    await ack(bot, query, "⚠️ خطای موقت؛ لطفاً دوباره تلاش کنید.");
    return;
  }
  if (!invoice) {
    await ack(bot, query, "⚠️ فاکتور یافت نشد.");
    return;
  }
  await ack(bot, query);
  const keyboard = [];
  if (invoice.invoiceUrl && !["finished", "failed", "expired", "refunded", "creation_failed"].includes(invoice.status)) {
    keyboard.push([{ text: "🔗 پرداخت فاکتور", url: invoice.invoiceUrl }]);
  }
  keyboard.push([{ text: "🔄 بررسی دوباره", callback_data: `np_status:${orderId}` }]);
  keyboard.push([{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }]);
  try {
    await edit(bot, chatId, messageId, nowPaymentsStatusMessage(invoice), keyboard);
  } catch { /* message unchanged or gone */ }
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

  // The amount is only meaningful after a currency was chosen server-side.
  const chosenAsset = session?.nowpaymentsAsset;
  if (!chosenAsset?.payCurrency || session?.paymentType !== "nowpayments") {
    try {
      await edit(bot, chatId, messageId, "🪙 ابتدا رمزارز موردنظر را انتخاب کنید.", [
        [{ text: "🪙 انتخاب رمزارز", callback_data: "pay_nowpayments" }],
        ...BACK,
      ]);
    } catch { /* ignore */ }
    return;
  }
  const limits = resolveTopUpLimits();
  const validation = parseTopUpAmount(text, limits.min, limits.max);
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

  const selectedAsset = chosenAsset;
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
    await edit(bot, chatId, messageId, nowPaymentsConfirmMessage(quote), confirmKeyboard());
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
        [{ text: "🔗 پرداخت فاکتور", url: invoice.invoiceUrl }],
        [{ text: "🔍 بررسی وضعیت پرداخت", callback_data: `np_status:${invoice.orderId}` }],
        [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }],
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
