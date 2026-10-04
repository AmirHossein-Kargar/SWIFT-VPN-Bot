/**
 * SWIFT Telegram Admin Panel (Persian)
 * ------------------------------------
 * Inline-keyboard admin UI running on the SAME admin services as the web
 * dashboard (services/admin/*). Callback data uses short "adm:" prefixes —
 * Telegram caps callback_data at 64 bytes, so long IDs are kept in the chat
 * session and referenced by index.
 *
 * Authorization: private chats require the clicker to be in ADMINS (or the
 * database-backed admin registry); group chats additionally require the
 * configured GROUP_ID (utils/auth.js policy).
 */
import { randomUUID } from "node:crypto";
import { getSession, setSession, clearSession } from "../../config/sessionStore.js";
import { isAdmin, isAdminUser } from "../../utils/auth.js";
import { AdminServiceError } from "../../services/admin/authorization.js";
import { getDashboardMetrics } from "../../services/admin/dashboard.js";
import { listUsers, getUserDetail, changeUserBalance, setUserBlocked } from "../../services/admin/users.js";
import { listVpns, getVpnDetail, performVpnAction } from "../../services/admin/vpns.js";
import { listPayments, getPaymentDetail, retryPayment, resolvePaymentRecovery } from "../../services/admin/payments.js";
import { getRecoveryQueue, retrySafeRecoveryItems } from "../../services/admin/recovery.js";
import { listProducts, setProductEnabled } from "../../services/admin/products.js";
import { getSystemHealth } from "../../services/admin/monitoring.js";
import { listAuditLogs } from "../../services/admin/audit.js";
import { createBroadcast, getBroadcastStatus } from "../../services/admin/broadcast.js";
import { listAdmins, addAdmin, removeAdmin, isOwnerUser } from "../../services/admin/adminRegistry.js";

const PAGE_SIZE = 5;
const PAY_STATUSES = [
  { id: "recovery-required", label: "🚨 نیاز به بررسی" },
  { id: "pending", label: "⏳ در انتظار" },
  { id: "paid", label: "💳 پرداخت‌شده" },
  { id: "fulfilled", label: "✅ تحویل‌شده" },
  { id: "failed", label: "❌ ناموفق" },
];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const money = (value) => (value == null ? "—" : Number(value).toLocaleString("en-US") + " تومان");
const num = (value) => (value == null ? "—" : Number(value).toLocaleString("en-US"));
const when = (value) => (value ? new Date(value).toLocaleString("fa-IR", { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

const HOME_BTN = { text: "🏠 خانه", callback_data: "adm:home" };
const BACK_BTN = { text: "⬅️ بازگشت", callback_data: "adm:home" };
const REFRESH_BTN = { text: "🔄 بروزرسانی", callback_data: "adm:refresh" };

function authorized(query) {
  const chatId = query?.message?.chat?.id;
  const userId = query?.from?.id;
  const chatType = query?.message?.chat?.type;
  if (chatType === "private") return isAdminUser(userId);
  return isAdmin(chatId, userId);
}

async function deny(bot, query) {
  await bot.answerCallbackQuery(query.id, { text: "⛔️ دسترسی مدیر تأیید نشد.", show_alert: true }).catch(() => {});
}

async function editOrSend(bot, chatId, messageId, text, keyboard) {
  const options = { parse_mode: "HTML", disable_web_page_preview: true };
  if (keyboard) options.reply_markup = keyboard;
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
  } catch {
    try { await bot.sendMessage(chatId, text, options); } catch { /* chat unreachable */ }
  }
}

// ── Screens ──────────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📊 داشبورد", callback_data: "adm:dash" }, { text: "👥 کاربران", callback_data: "adm:us" }],
      [{ text: "💳 پرداخت‌ها", callback_data: "adm:pay:recovery-required:1" }, { text: "🌐 سرویس‌های VPN", callback_data: "adm:vpns" }],
      [{ text: "📦 محصولات", callback_data: "adm:prod" }, { text: "📢 ارسال پیام همگانی", callback_data: "adm:bcast" }],
      [{ text: "🎁 معرفی‌ها", callback_data: "adm:ref" }, { text: "📋 بازیابی پرداخت‌ها", callback_data: "adm:rec" }],
      [{ text: "📜 گزارش عملیات", callback_data: "adm:audit:1" }, { text: "⚙️ وضعیت سیستم", callback_data: "adm:sys" }],
      [{ text: "🛡 مدیریت مدیران", callback_data: "adm:admins" }],
    ],
  };
}

function mainMenuText() {
  return "👑 <b>پنل مدیریت سویفت</b>\n\nیک بخش را برای مدیریت انتخاب کنید. همه عملیات این پنل از همان سرویس‌های امن و ثبت‌شده در گزارش استفاده می‌کنند که پنل وب نیز از آن‌ها بهره می‌برد.";
}

async function screenDashboard(bot, chatId, messageId) {
  const data = await getDashboardMetrics({ actorId: bot.__adminActorId });
  const m = data.metrics;
  const text =
    `👑 <b>داشبورد مدیریت</b>\n\n` +
    `👥 کاربران: <b>${num(m.totalUsers)}</b> (فعال: ${num(m.activeUsers)})\n` +
    `🟢 VPN های فعال: <b>${m.activeVpns == null ? num(m.trackedActiveVpns) + "*" : num(m.activeVpns)}</b>\n` +
    `💰 درآمد امروز: <b>${money(m.revenue.today)}</b>\n` +
    `🛒 سفارش‌های امروز: <b>${num(m.orders.today)}</b>\n` +
    `⏳ پرداخت‌های در انتظار: <b>${num(m.pendingPayments)}</b>\n` +
    `❌ پرداخت‌های ناموفق: <b>${num(m.failedPayments)}</b>\n` +
    `⚠️ خطاهای ساخت سرویس: <b>${num(m.failedProvisioning)}</b>\n` +
    `🆘 صف بازیابی: <b>${num((await getRecoveryQueue({ actorId: bot.__adminActorId, pageSize: 1 })).total)}</b>\n\n` +
    `<i>${m.activeVpns == null ? "*شمار داخلی (وضعیت WizardXray در دسترس نیست)\n" : ""}آخرین بروزرسانی: ${when(new Date())}</i>`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "👥 کاربران", callback_data: "adm:us" }, { text: "💳 پرداخت‌ها", callback_data: "adm:pay:recovery-required:1" }],
      [{ text: "🌐 سرویس‌ها", callback_data: "adm:vpns" }, { text: "📋 بازیابی", callback_data: "adm:rec" }],
      [REFRESH_BTN, HOME_BTN],
    ],
  });
}

async function screenUserSearch(bot, chatId, messageId) {
  await setSession(chatId, { step: "admin_panel_user_search" });
  await editOrSend(bot, chatId, messageId,
    "👥 <b>مدیریت کاربران</b>\n\n<b>شناسه عددی تلگرام</b> یا <b>@یوزرنیم</b> کاربر مورد نظر را ارسال کنید.",
    { inline_keyboard: [[BACK_BTN]] });
}

async function showUserProfile(bot, chatId, messageId, telegramId) {
  const data = await getUserDetail({ actorId: bot.__adminActorId, telegramId });
  const user = data.user;
  const text =
    `👤 <b>پروفایل کاربر</b>\n\n` +
    `🆔 شناسه: <code>${esc(user.telegramId)}</code>\n` +
    `🔗 یوزرنیم: ${user.username ? "@" + esc(user.username) : "—"}\n` +
    `📛 نام: ${esc(user.name || "—")}\n` +
    `💳 موجودی: <b>${money(user.balance)}</b>\n` +
    `💸 مجموع خرید: <b>${money(data.totalSpent)}</b>\n` +
    `🛒 سفارش‌ها: <b>${num(data.orderCount)}</b>\n` +
    `🌐 VPN های فعال: <b>${num(data.activeVpns)}</b> (منقضی: ${num(data.expiredVpns)})\n` +
    `✅ پرداخت‌ها: ${num(data.payments.length)} مورد\n` +
    `🎁 معرفی‌ها: ${num(data.referral.referralCount)}\n` +
    `🚫 وضعیت: ${user.isBanned ? "مسدود" : "فعال"}`;
  await setSession(chatId, { step: null, adminPanelUser: String(user.telegramId) });
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "🌐 سرویس‌ها", callback_data: "adm:usvpns" }, { text: "💳 پرداخت‌ها", callback_data: "adm:uspay" }],
      [{ text: "➕ افزایش موجودی", callback_data: "adm:bal:add" }, { text: "➖ کاهش موجودی", callback_data: "adm:bal:remove" }],
      user.isBanned
        ? [{ text: "🔓 رفع مسدودی", callback_data: "adm:blk:no" }]
        : [{ text: "🚫 مسدودسازی", callback_data: "adm:blk:yes" }],
      [REFRESH_BTN, BACK_BTN],
    ],
  });
}

async function screenUserPayments(bot, chatId, messageId, session) {
  const telegramId = session?.adminPanelUser;
  if (!telegramId) return screenUserSearch(bot, chatId, messageId);
  const data = await getUserDetail({ actorId: bot.__adminActorId, telegramId });
  const lines = data.payments.slice(0, 8).map((payment) =>
    `• <code>${esc(String(payment.id).slice(0, 20))}</code> · ${esc(payment.provider)} · ${money(payment.amount)} · ${esc(payment.status)}`);
  const text = `💳 <b>پرداخت‌های کاربر ${esc(telegramId)}</b>\n\n${lines.join("\n") || "پرداختی ثبت نشده است."}`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [[{ text: "👤 پروفایل", callback_data: "adm:usback" }], [BACK_BTN]],
  });
}

async function screenUserVpns(bot, chatId, messageId, session) {
  const telegramId = session?.adminPanelUser;
  if (!telegramId) return screenUserSearch(bot, chatId, messageId);
  const data = await listVpns({ actorId: bot.__adminActorId, query: { search: telegramId, status: "all", pageSize: 10 } });
  if (!data.items.length) {
    return editOrSend(bot, chatId, messageId, `🌐 <b>سرویسی برای کاربر ${esc(telegramId)} یافت نشد.</b>`, {
      inline_keyboard: [[{ text: "👤 پروفایل", callback_data: "adm:usback" }], [BACK_BTN]],
    });
  }
  const keys = data.items.map((item) => item.clientId);
  await setSession(chatId, { step: null, adminPanelUser: telegramId, adminVpnKeys: keys });
  const lines = data.items.slice(0, 8).map((vpn, index) =>
    `${index + 1}. <code>${esc(vpn.clientId)}</code> · ${vpn.status === "active" ? "🟢" : vpn.status === "expired" ? "🟡" : "🔴"} ${esc(vpn.status)} · انقضا ${when(vpn.expiresAt)}`);
  const keyboard = {
    inline_keyboard: [
      ...data.items.slice(0, 8).map((vpn, index) => [{ text: `🌐 ${vpn.clientId.slice(0, 28)}`, callback_data: `adm:vpnv:${index}` }]),
      [{ text: "👤 پروفایل", callback_data: "adm:usback" }],
      [BACK_BTN],
    ],
  };
  await editOrSend(bot, chatId, messageId, `🌐 <b>سرویس‌های کاربر ${esc(telegramId)}</b>\n\n${lines.join("\n")}`, keyboard);
}

async function screenPayments(bot, chatId, messageId, status, page) {
  const data = await listPayments({ actorId: bot.__adminActorId, query: { status, page, pageSize: PAGE_SIZE } });
  const keys = data.items.map((item) => item.key);
  await setSession(chatId, { step: null, adminPayKeys: keys, adminPayStatus: status, adminPayPage: data.page });
  const statusTabs = PAY_STATUSES.map((entry) => ({
    text: `${entry.id === status ? "•" : ""}${entry.label}`,
    callback_data: `adm:pay:${entry.id}:1`,
  })).reduce((rows, item, index) => (index % 2 === 0 ? [...rows, [item]] : [...rows.slice(0, -1), [...rows[rows.length - 1], item]]), []);
  const rows = data.items.map((item, index) => [{
    text: `${item.status === "recovery-required" ? "🚨" : item.status === "fulfilled" ? "✅" : item.status === "failed" ? "❌" : "⏳"} ${String(item.id).slice(0, 24)} · ${money(item.amount)}`,
    callback_data: `adm:payv:${index}`,
  }]);
  const pager = [];
  if (data.page > 1) pager.push({ text: "⬅️ قبلی", callback_data: `adm:pay:${status}:${data.page - 1}` });
  pager.push({ text: `${data.page}/${Math.max(1, data.pages)}`, callback_data: "adm:x" });
  if (data.page < data.pages) pager.push({ text: "بعدی ➡️", callback_data: `adm:pay:${status}:${data.page + 1}` });
  const statusLabel = PAY_STATUSES.find((entry) => entry.id === status)?.label || status;
  const text =
    `💳 <b>پرداخت‌ها — ${esc(statusLabel)}</b>\n\n` +
    (data.items.length
      ? data.items.map((item, index) => `${index + 1}. <code>${esc(String(item.id).slice(0, 26))}</code> · ${esc(item.providerLabel)} · ${money(item.amount)} · کاربر <code>${esc(item.userId)}</code>`).join("\n")
      : "موردی در این فهرست نیست.");
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [...statusTabs, ...rows, pager, [REFRESH_BTN, HOME_BTN]],
  });
}

async function screenPaymentDetail(bot, chatId, messageId, session, rowIndex) {
  const key = session?.adminPayKeys?.[Number(rowIndex)];
  if (!key) return screenPayments(bot, chatId, messageId, session?.adminPayStatus || "recovery-required", 1);
  const data = await getPaymentDetail({ actorId: bot.__adminActorId, key });
  await setSession(chatId, { ...session, adminPayDetail: key });
  const text =
    `💳 <b>جزئیات پرداخت</b>\n\n` +
    `🧾 شناسه: <code>${esc(data.id)}</code>\n` +
    `🏦 درگاه: ${esc(data.providerLabel)}\n` +
    `👤 کاربر: <code>${esc(data.userId)}</code>\n` +
    `💰 مبلغ: <b>${money(data.amount)}</b>\n` +
    `📦 محصول: ${esc(data.product)}\n` +
    `🔢 کد رهگیری: <code>${esc(data.trackingCode || "—")}</code>\n` +
    `📅 ایجاد: ${when(data.createdAt)}\n` +
    `✅ پرداخت: ${when(data.paidAt)}\n` +
    `📤 تحویل: ${when(data.fulfilledAt)}\n` +
    `📌 وضعیت: <b>${esc(data.status)}</b> (خام: ${esc(data.rawStatus)})\n` +
    `🔄 تلاش‌های مجدد: ${num(data.retryCount)}${data.lastError ? `\n⚠️ آخرین خطا: ${esc(data.lastError)}` : ""}\n\n` +
    `<b>روند پرداخت</b>\n` +
    (data.timeline.map((event) => `${event.status === "success" ? "✅" : event.status === "warning" ? "⚠️" : event.status === "pending" ? "⏳" : "•"} ${esc(event.name)} — ${when(event.at)}`).join("\n") || "—");
  const buttons = [];
  if (data.actions.retryVerification || data.actions.retryFulfillment) buttons.push([{ text: "🔄 تلاش مجدد", callback_data: `adm:payretry:${rowIndex}` }]);
  if (data.actions.manualResolve) buttons.push([{ text: "✅ ثبت تعیین تکلیف", callback_data: `adm:payresolve:${rowIndex}` }]);
  buttons.push([{ text: "⬅️ بازگشت", callback_data: `adm:pay:${session?.adminPayStatus || "recovery-required"}:${session?.adminPayPage || 1}` }]);
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [...buttons, [HOME_BTN]] });
}

async function screenVpnSearch(bot, chatId, messageId) {
  await setSession(chatId, { step: "admin_panel_vpn_search" });
  await editOrSend(bot, chatId, messageId,
    "🌐 <b>سرویس‌های VPN</b>\n\n<b>شناسه سرویس/کلاینت</b> یا <b>شناسه تلگرام کاربر</b> را برای جستجو ارسال کنید.",
    { inline_keyboard: [[BACK_BTN]] });
}

async function screenVpnDetail(bot, chatId, messageId, session, rowIndex) {
  const username = session?.adminVpnKeys?.[Number(rowIndex)];
  if (!username) return screenVpnSearch(bot, chatId, messageId);
  const data = await getVpnDetail({ actorId: bot.__adminActorId, username });
  const text =
    `🌐 <b>سرویس VPN</b>\n\n` +
    `👤 مالک: <code>${esc(data.user.telegramId)}</code>${data.user.name ? ` (${esc(data.user.name)})` : ""}\n` +
    `#⃣ شناسه کلاینت: <code>${esc(data.clientId)}</code>\n` +
    `📦 محصول: ${esc(data.product || "—")}\n` +
    `📅 ایجاد: ${when(data.createdAt)}\n` +
    `⏳ انقضا: ${when(data.expiresAt)}${data.panelExpiry ? ` (پنل: ${esc(data.panelExpiry)})` : ""}\n` +
    `📦 حجم: ${data.trafficGb != null ? num(data.trafficGb) + " گیگابایت" : "—"} (مصرف: ${esc(data.trafficUsed || "—")})\n` +
    `📊 WizardXray: ${data.wizardXray.status === "connected" ? "🟢" : "🔴"} ${esc(data.wizardXray.status)}${data.wizardXray.latencyMs != null ? ` · ${data.wizardXray.latencyMs}ms` : ""}\n` +
    `📌 وضعیت: <b>${esc(data.status)}</b>`;
  const keyboard = { inline_keyboard: [
    ...(data.availableActions.changeLink ? [[{ text: "🔗 تغییر لینک", callback_data: `adm:vpact:change-link:${rowIndex}` }]] : []),
    ...(data.availableActions.disable ? [[{ text: "⛔ غیرفعال‌سازی", callback_data: `adm:vpact:disable:${rowIndex}` }]] : []),
    ...(data.availableActions.revoke ? [[{ text: "🗑 حذف قطعی", callback_data: `adm:vpact:revoke:${rowIndex}` }]] : []),
    [{ text: "⏱ تمدید / 📦 حجم / 🔐 بازسازی — غیرفعال", callback_data: "adm:vpunavail" }],
    [REFRESH_BTN, BACK_BTN],
  ] };
  await editOrSend(bot, chatId, messageId, text, keyboard);
}

async function screenProducts(bot, chatId, messageId, page = 1) {
  const products = await listProducts({ actorId: bot.__adminActorId });
  const pageSize = 6;
  const pages = Math.max(1, Math.ceil(products.length / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const slice = products.slice((safePage - 1) * pageSize, safePage * pageSize);
  await setSession(chatId, { step: null, adminProductIds: products.map((product) => product.id) });
  const text =
    `📦 <b>محصولات</b> (صفحه ${safePage}/${pages})\n\n` +
    (slice.length
      ? slice.map((product, index) => {
          const globalIndex = (safePage - 1) * pageSize + index;
          return `${globalIndex + 1}. <b>${esc(product.name)}</b>\n    ${num(product.durationDays)} روز · ${num(product.trafficGb)} گیگ · ${money(product.priceToman)} · ${product.enabled ? "🟢 فعال" : "⚪️ غیرفعال"}`;
        }).join("\n")
      : "محصولی ثبت نشده است.");
  const pager = [];
  if (safePage > 1) pager.push({ text: "⬅️", callback_data: `adm:prod:${safePage - 1}` });
  pager.push({ text: `${safePage}/${pages}`, callback_data: "adm:x" });
  if (safePage < pages) pager.push({ text: "➡️", callback_data: `adm:prod:${safePage + 1}` });
  const rows = slice.map((product, index) => {
    const globalIndex = (safePage - 1) * pageSize + index;
    return [{ text: `${product.enabled ? "🟢" : "⚪️"} ${product.name.slice(0, 30)}`, callback_data: `adm:prodd:${globalIndex}` }];
  });
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [...rows, pager, [{ text: "➕ ساخت / ✏️ ویرایش — در پنل وب", callback_data: "adm:prodweb" }], [REFRESH_BTN, HOME_BTN]],
  });
}

async function screenProductDetail(bot, chatId, messageId, session, rowIndex) {
  const products = await listProducts({ actorId: bot.__adminActorId });
  const product = products.find((item) => item.id === session?.adminProductIds?.[Number(rowIndex)]);
  if (!product) return screenProducts(bot, chatId, messageId);
  const text =
    `📦 <b>محصول</b>\n\n` +
    `📛 نام: <b>${esc(product.name)}</b>\n` +
    `🆔 شناسه: <code>${esc(product.id)}</code>\n` +
    `📅 مدت: ${num(product.durationDays)} روز\n` +
    `📦 حجم: ${num(product.trafficGb)} گیگابایت\n` +
    `💰 قیمت: <b>${money(product.priceToman)}</b>\n` +
    `💸 هزینه: ${money(product.costToman)}\n` +
    `📈 سود: <b>${money(product.profitToman)}</b>\n` +
    `⚙️ فعال: ${product.enabled ? "بله" : "خیر"}\n` +
    `🔢 ترتیب نمایش: ${num(product.displayOrder)}`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: product.enabled ? "⚪️ غیرفعال‌سازی" : "🟢 فعال‌سازی", callback_data: `adm:prodt:${rowIndex}` }],
      [{ text: "⬅️ بازگشت", callback_data: "adm:prod:1" }, HOME_BTN],
    ],
  });
}

async function screenRecovery(bot, chatId, messageId) {
  const data = await getRecoveryQueue({ actorId: bot.__adminActorId, pageSize: 8 });
  const text =
    `📋 <b>بازیابی پرداخت‌ها</b>\n\n` +
    (data.items.length
      ? data.items.map((item) => `🚨 <code>${esc(String(item.key).slice(0, 30))}</code>\n    ${esc(item.kind)} · ${money(item.amount)} · تلاش ${num(item.retryCount)}${item.lastError ? ` · ${esc(item.lastError)}` : ""}`).join("\n")
      : "✅ موردی نیاز به بازیابی ندارد.") +
    `\n\nمجموع صف: <b>${num(data.total)}</b>`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "🔄 تلاش مجدد موارد امن", callback_data: "adm:recgo" }],
      [REFRESH_BTN, HOME_BTN],
    ],
  });
}

async function screenReferrals(bot, chatId, messageId) {
  const overview = await import("../../services/admin/users.js").then((module) => module.getReferralOverview({ actorId: bot.__adminActorId, pageSize: 5 }));
  const text =
    `🎁 <b>سیستم معرفی</b>\n\n` +
    `👥 حساب‌های دارای فعالیت معرفی: <b>${num(overview.total)}</b>\n\n` +
    (overview.items.length
      ? overview.items.map((item) => `• <code>${esc(item.telegramId)}</code>${item.referralCode ? ` · کد <code>${esc(item.referralCode)}</code>` : ""}${item.referredByTelegramId ? ` · معرفی‌کننده <code>${esc(item.referredByTelegramId)}</code>` : ""}`).join("\n")
      : "ثبت معرفی‌ها همراه با نسخه جدید ربات فعال شده و با تعامل کاربران نمایش داده می‌شود.");
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [[REFRESH_BTN, HOME_BTN]] });
}

async function screenAudit(bot, chatId, messageId, page = 1) {
  const data = await listAuditLogs({ page, pageSize: PAGE_SIZE });
  const text =
    `📜 <b>گزارش عملیات مدیران</b> (صفحه ${data.page}/${Math.max(1, Math.ceil(data.total / data.pageSize))})\n\n` +
    (data.items.length
      ? data.items.map((item) => `• ${when(item.createdAt)} · <code>${esc(item.actorTelegramId)}</code> · <b>${esc(item.action)}</b>${item.targetId ? ` → ${esc(String(item.targetId).slice(0, 24))}` : ""} · ${item.status === "succeeded" ? "✅" : item.status === "failed" ? "❌" : "⏳"}`).join("\n")
      : "عملیاتی ثبت نشده است.");
  const pager = [];
  if (data.page > 1) pager.push({ text: "⬅️ قبلی", callback_data: `adm:audit:${data.page - 1}` });
  if (data.page * data.pageSize < data.total) pager.push({ text: "بعدی ➡️", callback_data: `adm:audit:${data.page + 1}` });
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [...(pager.length ? [pager] : []), [REFRESH_BTN, HOME_BTN]] });
}

async function screenSystem(bot, chatId, messageId) {
  const data = await getSystemHealth({ actorId: bot.__adminActorId });
  const icon = { healthy: "🟢", degraded: "🟡", down: "🔴", unknown: "⚪️" };
  const text =
    `⚙️ <b>وضعیت سیستم</b>\n\n` +
    data.services.map((service) =>
      `${icon[service.status] || "⚪️"} <b>${esc(service.name)}</b> — ${esc(service.status)}` +
      (service.latencyMs != null ? ` · ${service.latencyMs}ms` : "") +
      (service.error ? `\n    ⚠️ ${esc(service.error)}` : "")
    ).join("\n") +
    `\n\nوضعیت کلی: <b>${esc(data.overall)}</b>\nآخرین بروزرسانی: ${when(new Date())}`;
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [[REFRESH_BTN, HOME_BTN]] });
}

async function screenBroadcast(bot, chatId, messageId) {
  await setSession(chatId, { step: "admin_panel_broadcast_message" });
  await editOrSend(bot, chatId, messageId,
    "📢 <b>ارسال پیام همگانی</b>\n\nمتن پیام را ارسال کنید. در مرحله بعد مخاطبان را انتخاب و تأیید خواهید کرد.",
    { inline_keyboard: [[BACK_BTN]] });
}

// ── Admin management (owner-only mutations) ──────────────────────────────────

async function screenAdmins(bot, chatId, messageId, userId) {
  const admins = await listAdmins({ actorId: userId });
  const isOwner = isOwnerUser(userId);
  const lines = admins.map((admin) =>
    `${admin.role === "owner" ? "👑" : "🛡"} <code>${esc(admin.telegramId)}</code> · ${admin.role === "owner" ? "مالک" : "مدیر"} · ${admin.source === "environment" ? "از تنظیمات سرور" : "از پایگاه داده"}`);
  const text =
    `🛡 <b>مدیریت مدیران</b>\n\n${lines.join("\n")}\n\n` +
    `${isOwner ? "👤 شما مالک اصلی هستید و می‌توانید مدیر اضافه یا حذف کنید." : "فقط مالک اصلی می‌تواند مدیران را تغییر دهد."}`;
  const keyboard = { inline_keyboard: [] };
  if (isOwner) {
    keyboard.inline_keyboard.push([{ text: "➕ افزودن مدیر", callback_data: "adm:admadd" }]);
    const removable = admins.filter((admin) => admin.source === "database" && admin.role !== "owner");
    for (const admin of removable.slice(0, 10)) {
      keyboard.inline_keyboard.push([{ text: `🗑 حذف ${admin.telegramId}`, callback_data: `adm:admrm:${admin.telegramId}` }]);
    }
  }
  keyboard.inline_keyboard.push([REFRESH_BTN, HOME_BTN]);
  await editOrSend(bot, chatId, messageId, text, keyboard);
}

// ── Router ───────────────────────────────────────────────────────────────────

export async function handleAdminPanelCommand(bot, msg) {
  const chatId = msg.chat.id;
  const text =
    "👑 <b>پنل مدیریت سویفت</b>\n\nبه مرکز کنترل مدیریت خوش آمدید. همه بخش‌ها از همان سرویس‌های امن و گزارش عملیات پنل وب استفاده می‌کنند.";
  await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: mainMenuKeyboard() });
}

export async function handleAdminCallback(bot, query) {
  const data = query?.data || "";
  if (!data.startsWith("adm:")) return false;
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const userId = query.from.id;

  if (!authorized(query)) { await deny(bot, query); return true; }
  bot.__adminActorId = String(userId);

  const [, action, arg1, arg2] = data.split(":");
  const session = await getSession(chatId);
  let handled = true;

  try {
    switch (action) {
      case "home":
        await clearSession(chatId).catch(() => {});
        await setSession(chatId, { step: null });
        await editOrSend(bot, chatId, messageId, mainMenuText(), mainMenuKeyboard());
        break;
      case "refresh":
        await renderRefresh(bot, query, chatId, messageId, session);
        break;
      case "dash":
        await screenDashboard(bot, chatId, messageId);
        break;
      case "us":
        await screenUserSearch(bot, chatId, messageId);
        break;
      case "usback":
        await showUserProfile(bot, chatId, messageId, session?.adminPanelUser);
        break;
      case "uspay":
        await screenUserPayments(bot, chatId, messageId, session);
        break;
      case "usvpns":
        await screenUserVpns(bot, chatId, messageId, session);
        break;
      case "bal":
        await setSession(chatId, { ...session, step: `admin_panel_balance:${arg1}`, adminPanelUser: session?.adminPanelUser });
        await editOrSend(bot, chatId, messageId,
          `💰 <b>${arg1 === "add" ? "افزایش" : "کاهش"} موجودی</b>\n\nکاربر: <code>${esc(session?.adminPanelUser || "؟")}</code>\n\nمبلغ را به تومان ارسال کنید.`,
          { inline_keyboard: [[{ text: "⬅️ انصراف", callback_data: "adm:usback" }]] });
        break;
      case "blk":
        await setSession(chatId, { ...session, step: `admin_panel_block:${arg1}`, adminPanelUser: session?.adminPanelUser });
        await editOrSend(bot, chatId, messageId,
          `${arg1 === "yes" ? "🚫 <b>مسدودسازی کاربر</b> — دلیل را ارسال کنید" : "🔓 <b>رفع مسدودی</b> — توضیح ارسال کنید (اختیاری)"}\n\nکاربر: <code>${esc(session?.adminPanelUser || "؟")}</code>`,
          { inline_keyboard: [[{ text: "⬅️ انصراف", callback_data: "adm:usback" }]] });
        break;
      case "pay":
        await screenPayments(bot, chatId, messageId, arg1 || "recovery-required", Number(arg2) || 1);
        break;
      case "payv":
        await screenPaymentDetail(bot, chatId, messageId, session, arg1);
        break;
      case "payretry":
        await bot.answerCallbackQuery(query.id, { text: "⏳ در حال تلاش مجدد..." });
        await confirmAndRun(bot, query, chatId, messageId,
          `🔄 پردازش مجدد این پرداخت انجام شود؟\n\n<code>${esc(String(session?.adminPayKeys?.[Number(arg1)] || "").slice(0, 40))}</code>\n\nتلاش‌های مجدد تکرارناپذیر نیستند — یک پرداخت تسویه‌شده هرگز دوباره اعمال نمی‌شود.`,
          async () => {
            const result = await retryPayment({ actorId: userId, operationId: randomUUID(), key: session.adminPayKeys[Number(arg1)] });
            return `✅ نتیجه تلاش مجدد: <b>${esc(result.status)}</b>`;
          });
        handled = true;
        break;
      case "payresolve":
        await setSession(chatId, { ...session, step: `admin_panel_resolve:${arg1}` });
        await editOrSend(bot, chatId, messageId,
          "✅ <b>تعیین تکلیف دستی</b>\n\nتوضیح کوتاهی درباره نحوه تسویه این پرداخت ارسال کنید. این عمل فقط ثبت وضعیت است و مبلغی جابه‌جا نمی‌کند.",
          { inline_keyboard: [[{ text: "⬅️ انصراف", callback_data: `adm:payv:${arg1}` }]] });
        break;
      case "vpns":
        await screenVpnSearch(bot, chatId, messageId);
        break;
      case "vpnv":
        await screenVpnDetail(bot, chatId, messageId, session, arg1);
        break;
      case "vpact": {
        const labels = { "change-link": "تغییر لینک اشتراک", disable: "غیرفعال‌سازی این سرویس", revoke: "حذف قطعی این سرویس" };
        const username = session?.adminVpnKeys?.[Number(arg2)];
        await confirmAndRun(bot, query, chatId, messageId,
          `⚠️ تأیید کنید: <b>${esc(labels[arg1] || arg1)}</b>\n\nسرویس: <code>${esc(username || "؟")}</code>${arg1 === "revoke" ? "\n\nاین عمل سرویس را در WizardXray حذف و از حساب کاربر پاک می‌کند و قابل بازگشت نیست." : ""}`,
          async () => {
            const result = await performVpnAction({ actorId: userId, operationId: randomUUID(), username, action: arg1, reason: `Telegram admin panel: ${arg1}` });
            return `✅ انجام شد (${esc(arg1)}).`;
          });
        break;
      }
      case "vpunavail":
        await bot.answerCallbackQuery(query.id, {
          text: "API تنظیم‌شده WizardXray نقطه پایانی امنی برای تمدید/افزایش حجم/بازسازی ندارد. از تغییر لینک یا حذف استفاده کنید.",
          show_alert: true,
        }).catch(() => {});
        break;
      case "prod":
        await screenProducts(bot, chatId, messageId, Number(arg1) || 1);
        break;
      case "prodd":
        await screenProductDetail(bot, chatId, messageId, session, arg1);
        break;
      case "prodt": {
        const products = await listProducts({ actorId: bot.__adminActorId });
        const product = products.find((item) => item.id === session?.adminProductIds?.[Number(arg1)]);
        const nextEnabled = !(product?.enabled ?? false);
        await confirmAndRun(bot, query, chatId, messageId,
          `${nextEnabled ? "🟢 فعال‌سازی" : "⚪️ غیرفعال‌سازی"} محصول <b>${esc(product?.name || "؟")}</b>؟`,
          async () => {
            await setProductEnabled({ actorId: userId, operationId: randomUUID(), productId: product.id, enabled: nextEnabled });
            return `✅ محصول ${nextEnabled ? "فعال" : "غیرفعال"} شد.`;
          });
        break;
      }
      case "prodweb":
        await bot.answerCallbackQuery(query.id, {
          text: "ساخت و ویرایش کامل محصولات با اعتبارسنجی کامل در پنل وب مدیریت (/admin) انجام می‌شود.",
          show_alert: true,
        }).catch(() => {});
        break;
      case "bcast":
        await screenBroadcast(bot, chatId, messageId);
        break;
      case "bcaud": {
        const message = session?.adminPanelBroadcastMessage;
        if (!message) { await screenBroadcast(bot, chatId, messageId); break; }
        await editOrSend(bot, chatId, messageId,
          `📢 <b>پیش‌نمایش پیام همگانی</b>\n\n——\n${esc(message.slice(0, 1200))}\n——\n\nمخاطبان را انتخاب کنید:`,
          broadcastAudienceKeyboard());
        break;
      }
      case "bcgo": {
        const message = session?.adminPanelBroadcastMessage;
        if (!message) { await screenBroadcast(bot, chatId, messageId); break; }
        await bot.answerCallbackQuery(query.id, { text: "🚀 در حال ارسال..." }).catch(() => {});
        const operationId = randomUUID();
        const result = await createBroadcast({ actorId: userId, operationId, message, audience: arg1 });
        await setSession(chatId, { step: null });
        await editOrSend(bot, chatId, messageId,
          `🚀 <b>ارسال همگانی آغاز شد</b>\n\nمخاطبان: <b>${esc(broadcastAudienceLabel(arg1))}</b>\nتعداد گیرندگان: <b>${num(result.broadcast?.total ?? 0)}</b>\n\nپیشرفت ارسال را از پنل وب دنبال کنید.`, { inline_keyboard: [[HOME_BTN]] });
        setTimeout(async () => {
          try {
            const status = await getBroadcastStatus({ actorId: userId, operationId });
            await bot.sendMessage(chatId,
              `📢 وضعیت ارسال همگانی\n\nوضعیت: <b>${esc(status.status)}</b>\nارسال‌شده: ${num(status.succeeded)}/${num(status.total)} · ناموفق: ${num(status.failed)}`,
              { parse_mode: "HTML" });
          } catch { /* status update is best-effort */ }
        }, 30_000).unref?.();
        break;
      }
      case "rec":
        await screenRecovery(bot, chatId, messageId);
        break;
      case "recgo":
        await bot.answerCallbackQuery(query.id, { text: "⏳ در حال تلاش مجدد موارد امن..." }).catch(() => {});
        await confirmAndRun(bot, query, chatId, messageId,
          "🔄 <b>تلاش مجدد برای همه موارد امن صف بازیابی؟</b>\n\nفقط مسیرهای تکرارناپذیر مجدداً اجرا می‌شوند (پرداخت‌شده بدون شارژ، ثبت‌های ناتمام). ساخت سرویس با نتیجه نامشخص هرگز تکرار نمی‌شود.",
          async () => {
            const result = await retrySafeRecoveryItems({ actorId: userId, operationId: randomUUID() });
            return `✅ از ${num(result.attempted)} مورد، ${num(result.succeeded)} موفق و ${num(result.failed?.length || 0)} ناموفق بود.`;
          });
        break;
      case "ref":
        await screenReferrals(bot, chatId, messageId);
        break;
      case "audit":
        await screenAudit(bot, chatId, messageId, Number(arg1) || 1);
        break;
      case "sys":
        await screenSystem(bot, chatId, messageId);
        break;
      case "admins":
        await screenAdmins(bot, chatId, messageId, userId);
        break;
      case "admadd": {
        if (!isOwnerUser(userId)) {
          await bot.answerCallbackQuery(query.id, { text: "⛔️ فقط مالک اصلی می‌تواند مدیر اضافه کند.", show_alert: true }).catch(() => {});
          break;
        }
        await setSession(chatId, { step: "admin_panel_add_admin" });
        await editOrSend(bot, chatId, messageId,
          "➕ <b>افزودن مدیر</b>\n\n<b>شناسه عددی تلگرام</b> کاربر را ارسال کنید.\n\nℹ️ کاربر پس از افزودن، به همه بخش‌های پنل دسترسی خواهد داشت (به جز مدیریت مدیران).",
          { inline_keyboard: [[{ text: "⬅️ انصراف", callback_data: "adm:admins" }]] });
        break;
      }
      case "admrm": {
        if (!isOwnerUser(userId)) {
          await bot.answerCallbackQuery(query.id, { text: "⛔️ فقط مالک اصلی می‌تواند مدیر حذف کند.", show_alert: true }).catch(() => {});
          break;
        }
        const targetId = String(arg1 || "");
        await confirmAndRun(bot, query, chatId, messageId,
          `🗑 حذف مدیر <code>${esc(targetId)}</code>؟\n\nدسترسی این کاربر حداکثر تا یک دقیقه دیگر قطع می‌شود.`,
          async () => {
            await removeAdmin({ actorId: userId, telegramId: targetId });
            return `✅ مدیر <code>${esc(targetId)}</code> حذف شد.`;
          });
        break;
      }
      case "x":
        await bot.answerCallbackQuery(query.id).catch(() => {});
        break;
      default:
        handled = false;
    }
  } catch (error) {
    const message = error instanceof AdminServiceError || error?.safeMessage ? error.safeMessage : "عملیات در حال حاضر انجام نشد.";
    await bot.answerCallbackQuery(query.id, { text: `❌ ${message}`, show_alert: true }).catch(() => {});
    console.error(JSON.stringify({
      ts: new Date().toISOString(), service: "admin-panel", level: "error",
      message: "Admin panel action failed", action, errorType: error?.name || "Error",
      code: typeof error?.code === "string" ? error.code : undefined,
    }));
  }

  if (handled) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
  }
  return true;
}

function broadcastAudienceKeyboard() {
  return { inline_keyboard: [
    [{ text: "👥 همه کاربران", callback_data: "adm:bcgo:all" }],
    [{ text: "🟢 کاربران فعال", callback_data: "adm:bcgo:active" }],
    [{ text: "⏳ کاربران منقضی", callback_data: "adm:bcgo:expired" }],
    [{ text: "💳 کاربران پرداخت‌کننده", callback_data: "adm:bcgo:paying" }],
    [{ text: "✏️ بازنویسی پیام", callback_data: "adm:bcast" }],
    [HOME_BTN],
  ] };
}

function broadcastAudienceLabel(audience) {
  return { all: "همه کاربران", active: "کاربران فعال", expired: "کاربران منقضی", paying: "کاربران پرداخت‌کننده", custom: "فهرست دلخواه" }[audience] || audience;
}

async function renderRefresh(bot, query, chatId, messageId, session) {
  // Re-render whatever screen the refresh button was pressed on.
  const data = query.data;
  if (data.startsWith("adm:pay:") && session?.adminPayKeys) return screenPayments(bot, chatId, messageId, session.adminPayStatus, session.adminPayPage);
  return screenDashboard(bot, chatId, messageId);
}

async function confirmAndRun(bot, query, chatId, messageId, confirmText, run) {
  const confirmKey = `adm:y:${Math.floor(Math.random() * 1e6)}`;
  pendingConfirms.set(confirmKey, { run, chatId, messageId });
  setTimeout(() => pendingConfirms.delete(confirmKey), 120_000).unref?.();
  await editOrSend(bot, chatId, messageId,
    `⚠️ <b>نیاز به تأیید</b>\n\n${confirmText}`,
    { inline_keyboard: [
      [{ text: "✅ تأیید", callback_data: confirmKey }, { text: "❌ انصراف", callback_data: "adm:x" }],
    ] });
}

const pendingConfirms = new Map();

export async function handleAdminConfirm(bot, query) {
  const data = query?.data || "";
  if (!data.startsWith("adm:y:")) return false;
  if (!authorized(query)) { await deny(bot, query); return true; }
  const pending = pendingConfirms.get(data);
  pendingConfirms.delete(data);
  if (!pending) {
    await bot.answerCallbackQuery(query.id, { text: "این تأیید منقضی شده است. دوباره تلاش کنید.", show_alert: true }).catch(() => {});
    return true;
  }
  await bot.answerCallbackQuery(query.id, { text: "⏳ در حال انجام..." }).catch(() => {});
  try {
    const message = await pending.run();
    await editOrSend(bot, pending.chatId, pending.messageId, `${message}`, { inline_keyboard: [[HOME_BTN]] });
  } catch (error) {
    const text = error?.safeMessage || "عملیات در حال حاضر انجام نشد.";
    await editOrSend(bot, pending.chatId, pending.messageId, `❌ <b>ناموفق</b>\n\n${esc(text)}`, { inline_keyboard: [[HOME_BTN]] });
    console.error(JSON.stringify({
      ts: new Date().toISOString(), service: "admin-panel", level: "error",
      message: "Confirmed admin action failed", errorType: error?.name || "Error",
      code: typeof error?.code === "string" ? error.code : undefined,
    }));
  }
  return true;
}

/** Entry point wired into handleCallbackQuery for every adm:* callback. */
export async function handleAdminPanelCallbacks(bot, query) {
  if (await handleAdminConfirm(bot, query)) return true;
  return handleAdminCallback(bot, query);
}

// ── Text-input steps (called from onMessage) ─────────────────────────────────

export async function handleAdminPanelStep(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const chatType = msg.chat?.type;
  const session = await getSession(chatId);
  const step = session?.step;
  if (!step || !String(step).startsWith("admin_panel_")) return false;

  const allowed = chatType === "private" ? isAdminUser(userId) : isAdmin(chatId, userId);
  if (!allowed) return false;
  bot.__adminActorId = String(userId);

  const text = String(msg.text || "").trim();
  const finish = async (clear = true) => { if (clear) await setSession(chatId, { step: null }); };

  try {
    if (step === "admin_panel_user_search") {
      const found = await listUsers({ actorId: userId, query: { search: text, pageSize: 5 } });
      if (!found.items.length) {
        await bot.sendMessage(chatId, `❌ کاربری برای <code>${esc(text)}</code> یافت نشد.`, { parse_mode: "HTML" });
        return true;
      }
      const user = found.items[0];
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await showUserProfile(bot, chatId, sent.message_id, user.telegramId);
      await finish();
      return true;
    }

    if (step === "admin_panel_vpn_search") {
      const data = await listVpns({ actorId: userId, query: { search: text, status: "all", pageSize: 8 } });
      if (!data.items.length) {
        await bot.sendMessage(chatId, `❌ سرویسی برای <code>${esc(text)}</code> یافت نشد.`, { parse_mode: "HTML" });
        return true;
      }
      await setSession(chatId, { step: null, adminVpnKeys: data.items.map((item) => item.clientId) });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await screenVpnDetail(bot, chatId, sent.message_id, { adminVpnKeys: data.items.map((item) => item.clientId) }, 0);
      await finish(false);
      return true;
    }

    if (step.startsWith("admin_panel_balance:")) {
      const direction = step.split(":")[1];
      const amount = Number(text.replace(/[,\s]/g, ""));
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        await bot.sendMessage(chatId, "❌ مبلغ را به صورت عدد مثبت و به تومان ارسال کنید.");
        return true;
      }
      const result = await changeUserBalance({
        actorId: userId, operationId: randomUUID(), telegramId: session.adminPanelUser,
        amount, direction, reason: `Telegram admin panel (${direction})`,
      });
      await bot.sendMessage(chatId, `✅ موجودی ${direction === "add" ? "افزایش" : "کاهش"} یافت. موجودی جدید: <b>${money(result.balance)}</b>.`, { parse_mode: "HTML" });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await showUserProfile(bot, chatId, sent.message_id, session.adminPanelUser);
      await finish();
      return true;
    }

    if (step.startsWith("admin_panel_block:")) {
      const blocking = step.split(":")[1] === "yes";
      const result = await setUserBlocked({
        actorId: userId, operationId: randomUUID(), telegramId: session.adminPanelUser,
        blocked: blocking, reason: text || "Telegram admin panel",
      });
      await bot.sendMessage(chatId, `✅ کاربر ${result.isBanned ? "مسدود" : "از مسدودی خارج"} شد.`, { parse_mode: "HTML" });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await showUserProfile(bot, chatId, sent.messageId, session.adminPanelUser);
      await finish();
      return true;
    }

    if (step === "admin_panel_broadcast_message") {
      if (!text || text.length > 4096) {
        await bot.sendMessage(chatId, "❌ متن پیام باید بین ۱ تا ۴۰۹۶ نویسه باشد.");
        return true;
      }
      await setSession(chatId, { step: null, adminPanelBroadcastMessage: text });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await editOrSend(bot, chatId, sent.message_id,
        `📢 <b>پیش‌نمایش پیام همگانی</b>\n\n——\n${esc(text.slice(0, 1200))}\n——\n\nمخاطبان را انتخاب کنید:`,
        broadcastAudienceKeyboard());
      return true;
    }

    if (step.startsWith("admin_panel_resolve:")) {
      const rowIndex = Number(step.split(":")[1]);
      const key = session.adminPayKeys?.[rowIndex];
      if (!key) { await finish(); return true; }
      if (text.length < 10) {
        await bot.sendMessage(chatId, "❌ توضیح حداقل ۱۰ نویسه درباره نحوه تسویه ارسال کنید.");
        return true;
      }
      await resolvePaymentRecovery({ actorId: userId, operationId: randomUUID(), key, reason: text });
      await bot.sendMessage(chatId, "✅ تعیین تکلیف ثبت و در گزارش عملیات درج شد.");
      await finish();
      return true;
    }

    if (step === "admin_panel_add_admin") {
      if (!isOwnerUser(userId)) {
        await bot.sendMessage(chatId, "⛔️ فقط مالک اصلی می‌تواند مدیر اضافه کند.");
        await finish();
        return true;
      }
      const result = await addAdmin({ actorId: userId, telegramId: text });
      const already = result?.alreadyPresent ? " (از قبل مدیر بود)" : "";
      await bot.sendMessage(chatId, `✅ مدیر <code>${esc(text)}</code> ثبت شد${already}. دسترسی حداکثر تا یک دقیقه دیگر فعال می‌شود.`, { parse_mode: "HTML" });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await screenAdmins(bot, chatId, sent.message_id, userId);
      await finish();
      return true;
    }
  } catch (error) {
    const message = error?.safeMessage || "عملیات در حال حاضر انجام نشد.";
    await bot.sendMessage(chatId, `❌ ${esc(message)}`, { parse_mode: "HTML" });
    console.error(JSON.stringify({
      ts: new Date().toISOString(), service: "admin-panel", level: "error",
      message: "Admin panel input step failed", step, errorType: error?.name || "Error",
      code: typeof error?.code === "string" ? error.code : undefined,
    }));
    return true;
  }
  return false;
}
