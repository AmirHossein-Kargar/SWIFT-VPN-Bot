/**
 * SWIFT Telegram Admin Panel
 * --------------------------
 * Inline-keyboard admin UI running on the SAME admin services as the web
 * dashboard (services/admin/*). Callback data uses short "adm:" prefixes —
 * Telegram caps callback_data at 64 bytes, so long IDs are kept in the chat
 * session and referenced by index.
 *
 * Authorization: private chats require the clicker to be in ADMINS; group
 * chats additionally require the configured GROUP_ID (utils/auth.js policy).
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
import { getAnalytics } from "../../services/admin/analytics.js";
import { getSystemHealth } from "../../services/admin/monitoring.js";
import { listAuditLogs } from "../../services/admin/audit.js";
import { createBroadcast, getBroadcastStatus } from "../../services/admin/broadcast.js";

const PAGE_SIZE = 5;
const PAY_STATUSES = [
  { id: "recovery-required", label: "🚨 Recovery" },
  { id: "pending", label: "⏳ Pending" },
  { id: "paid", label: "💳 Paid" },
  { id: "fulfilled", label: "✅ Fulfilled" },
  { id: "failed", label: "❌ Failed" },
];

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const money = (value) => (value == null ? "—" : Number(value).toLocaleString("en-US") + " T");
const num = (value) => (value == null ? "—" : Number(value).toLocaleString("en-US"));
const when = (value) => (value ? new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const HOME_BTN = { text: "🏠 Home", callback_data: "adm:home" };
const BACK_BTN = { text: "⬅️ Back", callback_data: "adm:home" };
const REFRESH_BTN = { text: "🔄 Refresh", callback_data: "adm:refresh" };

function authorized(query) {
  const chatId = query?.message?.chat?.id;
  const userId = query?.from?.id;
  const chatType = query?.message?.chat?.type;
  if (chatType === "private") return isAdminUser(userId);
  return isAdmin(chatId, userId);
}

async function deny(bot, query) {
  await bot.answerCallbackQuery(query.id, { text: "⛔️ Admin access denied.", show_alert: true }).catch(() => {});
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
      [{ text: "📊 Dashboard", callback_data: "adm:dash" }, { text: "👥 Users", callback_data: "adm:us" }],
      [{ text: "💳 Payments", callback_data: "adm:pay:recovery-required:1" }, { text: "🌐 VPN Services", callback_data: "adm:vpns" }],
      [{ text: "📦 Products", callback_data: "adm:prod" }, { text: "📢 Broadcast", callback_data: "adm:bcast" }],
      [{ text: "🎁 Referrals", callback_data: "adm:ref" }, { text: "📋 Recovery", callback_data: "adm:rec" }],
      [{ text: "📜 Audit Logs", callback_data: "adm:audit:1" }, { text: "⚙️ System", callback_data: "adm:sys" }],
    ],
  };
}

function mainMenuText() {
  return "👑 <b>SWIFT ADMIN</b>\n\nSelect a section to manage the platform. All actions here run through the same audited admin services as the web dashboard.";
}

async function screenDashboard(bot, chatId, messageId) {
  const data = await getDashboardMetrics({ actorId: bot.__adminActorId });
  const m = data.metrics;
  const text =
    `👑 <b>SWIFT ADMIN — Dashboard</b>\n\n` +
    `👥 Users: <b>${num(m.totalUsers)}</b> (active ${num(m.activeUsers)})\n` +
    `🟢 Active VPNs: <b>${m.activeVpns == null ? num(m.trackedActiveVpns) + "*" : num(m.activeVpns)}</b>\n` +
    `💰 Today: <b>${money(m.revenue.today)}</b>\n` +
    `🛒 Orders today: <b>${num(m.orders.today)}</b>\n` +
    `⏳ Pending payments: <b>${num(m.pendingPayments)}</b>\n` +
    `❌ Failed payments: <b>${num(m.failedPayments)}</b>\n` +
    `⚠️ Failed provisioning: <b>${num(m.failedProvisioning)}</b>\n` +
    `🆘 Recovery queue: <b>${num((await getRecoveryQueue({ actorId: bot.__adminActorId, pageSize: 1 })).total)}</b>\n\n` +
    `<i>${m.activeVpns == null ? "*local tracked count (WizardXray status unavailable)\n" : ""}Updated ${when(new Date())}</i>`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "👥 Users", callback_data: "adm:us" }, { text: "💳 Payments", callback_data: "adm:pay:recovery-required:1" }],
      [{ text: "🌐 VPNs", callback_data: "adm:vpns" }, { text: "📋 Recovery", callback_data: "adm:rec" }],
      [REFRESH_BTN, HOME_BTN],
    ],
  });
}

async function screenUserSearch(bot, chatId, messageId) {
  await setSession(chatId, { step: "admin_panel_user_search" });
  await editOrSend(bot, chatId, messageId,
    "👥 <b>User management</b>\n\nSend the <b>Telegram ID</b> or <b>@username</b> of the user you want to manage.",
    { inline_keyboard: [[BACK_BTN]] });
}

async function showUserProfile(bot, chatId, messageId, telegramId) {
  const data = await getUserDetail({ actorId: bot.__adminActorId, telegramId });
  const user = data.user;
  const text =
    `👤 <b>User</b>\n\n` +
    `🆔 ID: <code>${esc(user.telegramId)}</code>\n` +
    `🔗 Username: ${user.username ? "@" + esc(user.username) : "—"}\n` +
    `📛 Name: ${esc(user.name || "—")}\n` +
    `💳 Balance: <b>${money(user.balance)}</b>\n` +
    `💸 Total spent: <b>${money(data.totalSpent)}</b>\n` +
    `🛒 Orders: <b>${num(data.orderCount)}</b>\n` +
    `🌐 Active VPNs: <b>${num(data.activeVpns)}</b> (expired ${num(data.expiredVpns)})\n` +
    `✅ Payments: ${num(data.payments.length)} shown\n` +
    `🎁 Referrals: ${num(data.referral.referralCount)}\n` +
    `🚫 Status: ${user.isBanned ? "BLOCKED" : "active"}`;
  await setSession(chatId, { step: null, adminPanelUser: String(user.telegramId) });
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "🌐 VPNs", callback_data: "adm:usvpns" }, { text: "💳 Payments", callback_data: "adm:uspay" }],
      [{ text: "➕ Add Balance", callback_data: "adm:bal:add" }, { text: "➖ Remove Balance", callback_data: "adm:bal:remove" }],
      user.isBanned
        ? [{ text: "🔓 Unblock", callback_data: "adm:blk:no" }]
        : [{ text: "🚫 Block", callback_data: "adm:blk:yes" }],
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
  const text = `💳 <b>Payments — user ${esc(telegramId)}</b>\n\n${lines.join("\n") || "No payments recorded."}`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [[{ text: "👤 Profile", callback_data: "adm:usback" }], [BACK_BTN]],
  });
}

async function screenUserVpns(bot, chatId, messageId, session) {
  const telegramId = session?.adminPanelUser;
  if (!telegramId) return screenUserSearch(bot, chatId, messageId);
  const data = await listVpns({ actorId: bot.__adminActorId, query: { search: telegramId, status: "all", pageSize: 10 } });
  if (!data.items.length) {
    return editOrSend(bot, chatId, messageId, `🌐 <b>No VPN services found for ${esc(telegramId)}.</b>`, {
      inline_keyboard: [[{ text: "👤 Profile", callback_data: "adm:usback" }], [BACK_BTN]],
    });
  }
  const keys = data.items.map((item) => item.clientId);
  await setSession(chatId, { step: null, adminPanelUser: telegramId, adminVpnKeys: keys });
  const lines = data.items.slice(0, 8).map((vpn, index) =>
    `${index + 1}. <code>${esc(vpn.clientId)}</code> · ${vpn.status === "active" ? "🟢" : vpn.status === "expired" ? "🟡" : "🔴"} ${esc(vpn.status)} · exp ${when(vpn.expiresAt)}`);
  const keyboard = {
    inline_keyboard: [
      ...data.items.slice(0, 8).map((vpn, index) => [{ text: `🌐 ${vpn.clientId.slice(0, 28)}`, callback_data: `adm:vpnv:${index}` }]),
      [{ text: "👤 Profile", callback_data: "adm:usback" }],
      [BACK_BTN],
    ],
  };
  await editOrSend(bot, chatId, messageId, `🌐 <b>VPN services — user ${esc(telegramId)}</b>\n\n${lines.join("\n")}`, keyboard);
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
  if (data.page > 1) pager.push({ text: "⬅️ Prev", callback_data: `adm:pay:${status}:${data.page - 1}` });
  pager.push({ text: `${data.page}/${Math.max(1, data.pages)}`, callback_data: "adm:x" });
  if (data.page < data.pages) pager.push({ text: "Next ➡️", callback_data: `adm:pay:${status}:${data.page + 1}` });
  const text =
    `💳 <b>Payments — ${esc(status)}</b>\n\n` +
    (data.items.length
      ? data.items.map((item, index) => `${index + 1}. <code>${esc(String(item.id).slice(0, 26))}</code> · ${esc(item.providerLabel)} · ${money(item.amount)} · user <code>${esc(item.userId)}</code>`).join("\n")
      : "Nothing in this list.");
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
    `💳 <b>Payment detail</b>\n\n` +
    `🧾 ID: <code>${esc(data.id)}</code>\n` +
    `🏦 Provider: ${esc(data.providerLabel)}\n` +
    `👤 User: <code>${esc(data.userId)}</code>\n` +
    `💰 Amount: <b>${money(data.amount)}</b>\n` +
    `📦 Product: ${esc(data.product)}\n` +
    `🔢 Tracking: <code>${esc(data.trackingCode || "—")}</code>\n` +
    `📅 Created: ${when(data.createdAt)}\n` +
    `✅ Paid: ${when(data.paidAt)}\n` +
    `📤 Fulfilled: ${when(data.fulfilledAt)}\n` +
    `📌 Status: <b>${esc(data.status)}</b> (raw: ${esc(data.rawStatus)})\n` +
    `🔄 Retries: ${num(data.retryCount)}${data.lastError ? `\n⚠️ Last error: ${esc(data.lastError)}` : ""}\n\n` +
    `<b>Timeline</b>\n` +
    (data.timeline.map((event) => `${event.status === "success" ? "✅" : event.status === "warning" ? "⚠️" : event.status === "pending" ? "⏳" : "•"} ${esc(event.name)} — ${when(event.at)}`).join("\n") || "—");
  const buttons = [];
  if (data.actions.retryVerification || data.actions.retryFulfillment) buttons.push([{ text: "🔄 Retry", callback_data: `adm:payretry:${rowIndex}` }]);
  if (data.actions.manualResolve) buttons.push([{ text: "✅ Resolve", callback_data: `adm:payresolve:${rowIndex}` }]);
  buttons.push([{ text: "⬅️ Back", callback_data: `adm:pay:${session?.adminPayStatus || "recovery-required"}:${session?.adminPayPage || 1}` }]);
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [...buttons, [HOME_BTN]] });
}

async function screenVpnSearch(bot, chatId, messageId) {
  await setSession(chatId, { step: "admin_panel_vpn_search" });
  await editOrSend(bot, chatId, messageId,
    "🌐 <b>VPN services</b>\n\nSend a <b>service/client ID</b> or a <b>user Telegram ID</b> to look up VPN services.",
    { inline_keyboard: [[BACK_BTN]] });
}

async function screenVpnDetail(bot, chatId, messageId, session, rowIndex) {
  const username = session?.adminVpnKeys?.[Number(rowIndex)];
  if (!username) return screenVpnSearch(bot, chatId, messageId);
  const data = await getVpnDetail({ actorId: bot.__adminActorId, username });
  const text =
    `🌐 <b>VPN service</b>\n\n` +
    `👤 Owner: <code>${esc(data.user.telegramId)}</code>${data.user.name ? ` (${esc(data.user.name)})` : ""}\n` +
    `#⃣ Client ID: <code>${esc(data.clientId)}</code>\n` +
    `📦 Product: ${esc(data.product || "—")}\n` +
    `📅 Created: ${when(data.createdAt)}\n` +
    `⏳ Expiry: ${when(data.expiresAt)}${data.panelExpiry ? ` (panel: ${esc(data.panelExpiry)})` : ""}\n` +
    `📦 Traffic: ${data.trafficGb != null ? num(data.trafficGb) + " GB" : "—"} (used ${esc(data.trafficUsed || "—")})\n` +
    `📊 WizardXray: ${data.wizardXray.status === "connected" ? "🟢" : "🔴"} ${esc(data.wizardXray.status)}${data.wizardXray.latencyMs != null ? ` · ${data.wizardXray.latencyMs}ms` : ""}\n` +
    `📌 Status: <b>${esc(data.status)}</b>`;
  const keyboard = { inline_keyboard: [
    ...(data.availableActions.changeLink ? [[{ text: "🔗 Change link", callback_data: `adm:vpact:change-link:${rowIndex}` }]] : []),
    ...(data.availableActions.disable ? [[{ text: "⛔ Disable", callback_data: `adm:vpact:disable:${rowIndex}` }]] : []),
    ...(data.availableActions.revoke ? [[{ text: "🗑 Revoke", callback_data: `adm:vpact:revoke:${rowIndex}` }]] : []),
    [{ text: "⏱ Extend / 📦 Traffic / 🔐 Regenerate — unavailable", callback_data: "adm:vpunavail" }],
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
    `📦 <b>Products</b> (page ${safePage}/${pages})\n\n` +
    (slice.length
      ? slice.map((product, index) => {
          const globalIndex = (safePage - 1) * pageSize + index;
          return `${globalIndex + 1}. <b>${esc(product.name)}</b>\n    ${num(product.durationDays)}d · ${num(product.trafficGb)}GB · ${money(product.priceToman)} · ${product.enabled ? "🟢 enabled" : "⚪️ disabled"}`;
        }).join("\n")
      : "No products yet.");
  const pager = [];
  if (safePage > 1) pager.push({ text: "⬅️", callback_data: `adm:prod:${safePage - 1}` });
  pager.push({ text: `${safePage}/${pages}`, callback_data: "adm:x" });
  if (safePage < pages) pager.push({ text: "➡️", callback_data: `adm:prod:${safePage + 1}` });
  const rows = slice.map((product, index) => {
    const globalIndex = (safePage - 1) * pageSize + index;
    return [{ text: `${product.enabled ? "🟢" : "⚪️"} ${product.name.slice(0, 30)}`, callback_data: `adm:prodd:${globalIndex}` }];
  });
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [...rows, pager, [{ text: "➕ Create / ✏️ Edit — use web panel", callback_data: "adm:prodweb" }], [REFRESH_BTN, HOME_BTN]],
  });
}

async function screenProductDetail(bot, chatId, messageId, session, rowIndex) {
  const products = await listProducts({ actorId: bot.__adminActorId });
  const product = products.find((item) => item.id === session?.adminProductIds?.[Number(rowIndex)]);
  if (!product) return screenProducts(bot, chatId, messageId);
  const text =
    `📦 <b>Product</b>\n\n` +
    `📛 Name: <b>${esc(product.name)}</b>\n` +
    `🆔 ID: <code>${esc(product.id)}</code>\n` +
    `📅 Duration: ${num(product.durationDays)} days\n` +
    `📦 Traffic: ${num(product.trafficGb)} GB\n` +
    `💰 Price: <b>${money(product.priceToman)}</b>\n` +
    `💸 Cost: ${money(product.costToman)}\n` +
    `📈 Profit: <b>${money(product.profitToman)}</b>\n` +
    `⚙️ Enabled: ${product.enabled ? "yes" : "no"}\n` +
    `🔢 Display order: ${num(product.displayOrder)}`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: product.enabled ? "⚪️ Disable" : "🟢 Enable", callback_data: `adm:prodt:${rowIndex}` }],
      [{ text: "⬅️ Back", callback_data: "adm:prod:1" }, HOME_BTN],
    ],
  });
}

async function screenRecovery(bot, chatId, messageId) {
  const data = await getRecoveryQueue({ actorId: bot.__adminActorId, pageSize: 8 });
  const text =
    `📋 <b>Payment recovery</b>\n\n` +
    (data.items.length
      ? data.items.map((item) => `🚨 <code>${esc(String(item.key).slice(0, 30))}</code>\n    ${esc(item.kind)} · ${money(item.amount)} · retries ${num(item.retryCount)}${item.lastError ? ` · ${esc(item.lastError)}` : ""}`).join("\n")
      : "✅ Nothing needs recovery.") +
    `\n\nTotal in queue: <b>${num(data.total)}</b>`;
  await editOrSend(bot, chatId, messageId, text, {
    inline_keyboard: [
      [{ text: "🔄 Retry all safe", callback_data: "adm:recgo" }],
      [REFRESH_BTN, HOME_BTN],
    ],
  });
}

async function screenReferrals(bot, chatId, messageId) {
  const overview = await import("../../services/admin/users.js").then((module) => module.getReferralOverview({ actorId: bot.__adminActorId, pageSize: 5 }));
  const text =
    `🎁 <b>Referrals</b>\n\n` +
    `👥 Accounts with referral activity: <b>${num(overview.total)}</b>\n\n` +
    (overview.items.length
      ? overview.items.map((item) => `• <code>${esc(item.telegramId)}</code>${item.referralCode ? ` · code <code>${esc(item.referralCode)}</code>` : ""}${item.referredByTelegramId ? ` · referred by <code>${esc(item.referredByTelegramId)}</code>` : ""}`).join("\n")
      : "Referral tracking starts with the updated bot; records appear as users interact.");
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [[REFRESH_BTN, HOME_BTN]] });
}

async function screenAudit(bot, chatId, messageId, page = 1) {
  const data = await listAuditLogs({ page, pageSize: PAGE_SIZE });
  const text =
    `📜 <b>Audit log</b> (page ${data.page}/${Math.max(1, Math.ceil(data.total / data.pageSize))})\n\n` +
    (data.items.length
      ? data.items.map((item) => `• ${when(item.createdAt)} · <code>${esc(item.actorTelegramId)}</code> · <b>${esc(item.action)}</b>${item.targetId ? ` → ${esc(String(item.targetId).slice(0, 24))}` : ""} · ${item.status === "succeeded" ? "✅" : item.status === "failed" ? "❌" : "⏳"}`).join("\n")
      : "No audit records yet.");
  const pager = [];
  if (data.page > 1) pager.push({ text: "⬅️ Prev", callback_data: `adm:audit:${data.page - 1}` });
  if (data.page * data.pageSize < data.total) pager.push({ text: "Next ➡️", callback_data: `adm:audit:${data.page + 1}` });
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [...(pager.length ? [pager] : []), [REFRESH_BTN, HOME_BTN]] });
}

async function screenSystem(bot, chatId, messageId) {
  const data = await getSystemHealth({ actorId: bot.__adminActorId });
  const icon = { healthy: "🟢", degraded: "🟡", down: "🔴", unknown: "⚪️" };
  const text =
    `⚙️ <b>System health</b>\n\n` +
    data.services.map((service) =>
      `${icon[service.status] || "⚪️"} <b>${esc(service.name)}</b> — ${esc(service.status)}` +
      (service.latencyMs != null ? ` · ${service.latencyMs}ms` : "") +
      (service.error ? `\n    ⚠️ ${esc(service.error)}` : "")
    ).join("\n") +
    `\n\nOverall: <b>${esc(data.overall)}</b>\nUpdated ${when(new Date())}`;
  await editOrSend(bot, chatId, messageId, text, { inline_keyboard: [[REFRESH_BTN, HOME_BTN]] });
}

async function screenBroadcast(bot, chatId, messageId) {
  await setSession(chatId, { step: "admin_panel_broadcast_message" });
  await editOrSend(bot, chatId, messageId,
    "📢 <b>Broadcast</b>\n\nSend the message text you want to deliver. In the next step you will pick the audience and confirm.",
    { inline_keyboard: [[BACK_BTN]] });
}

// ── Router ───────────────────────────────────────────────────────────────────

export async function handleAdminPanelCommand(bot, msg) {
  const chatId = msg.chat.id;
  const text =
    "👑 <b>SWIFT ADMIN</b>\n\nWelcome to the admin control panel. Everything here shares the same permissions, services and audit trail as the web dashboard.";
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
          `💰 <b>${arg1 === "add" ? "Add" : "Remove"} balance</b>\n\nUser: <code>${esc(session?.adminPanelUser || "?")}</code>\n\nSend the amount in Toman.`,
          { inline_keyboard: [[{ text: "⬅️ Cancel", callback_data: "adm:usback" }]] });
        break;
      case "blk":
        await setSession(chatId, { ...session, step: `admin_panel_block:${arg1}`, adminPanelUser: session?.adminPanelUser });
        await editOrSend(bot, chatId, messageId,
          `${arg1 === "yes" ? "🚫 <b>Block user</b> — send the reason" : "🔓 <b>Unblock user</b> — send a note (optional)"}\n\nUser: <code>${esc(session?.adminPanelUser || "?")}</code>`,
          { inline_keyboard: [[{ text: "⬅️ Cancel", callback_data: "adm:usback" }]] });
        break;
      case "pay":
        await screenPayments(bot, chatId, messageId, arg1 || "recovery-required", Number(arg2) || 1);
        break;
      case "payv":
        await screenPaymentDetail(bot, chatId, messageId, session, arg1);
        break;
      case "payretry":
        await bot.answerCallbackQuery(query.id, { text: "⏳ Retrying…" });
        await confirmAndRun(bot, query, chatId, messageId,
          `🔄 Retry payment processing?\n\n<code>${esc(String(session?.adminPayKeys?.[Number(arg1)] || "").slice(0, 40))}</code>\n\nRetries are idempotent — a paid order can never be credited twice.`,
          async () => {
            const result = await retryPayment({ actorId: userId, operationId: randomUUID(), key: session.adminPayKeys[Number(arg1)] });
            return `✅ Retry result: <b>${esc(result.status)}</b>`;
          });
        handled = true;
        break;
      case "payresolve":
        await setSession(chatId, { ...session, step: `admin_panel_resolve:${arg1}` });
        await editOrSend(bot, chatId, messageId,
          "✅ <b>Manual resolve</b>\n\nSend a short note describing how this payment was settled. This records the disposition only — it does not move money.",
          { inline_keyboard: [[{ text: "⬅️ Cancel", callback_data: `adm:payv:${arg1}` }]] });
        break;
      case "vpns":
        await screenVpnSearch(bot, chatId, messageId);
        break;
      case "vpnv":
        await screenVpnDetail(bot, chatId, messageId, session, arg1);
        break;
      case "vpact": {
        const labels = { "change-link": "change the subscription link", disable: "disable this service", revoke: "PERMANENTLY REVOKE this service" };
        const username = session?.adminVpnKeys?.[Number(arg2)];
        await confirmAndRun(bot, query, chatId, messageId,
          `⚠️ Confirm: <b>${esc(labels[arg1] || arg1)}</b>\n\nService: <code>${esc(username || "?")}</code>${arg1 === "revoke" ? "\n\nThis deletes the service on WizardXray and removes it from the user's account. It cannot be undone." : ""}`,
          async () => {
            const result = await performVpnAction({ actorId: userId, operationId: randomUUID(), username, action: arg1, reason: `Telegram admin panel: ${arg1}` });
            return `✅ Done (${esc(arg1)}).`;
          });
        break;
      }
      case "vpunavail":
        await bot.answerCallbackQuery(query.id, {
          text: "The configured WizardXray API has no safe endpoint for extend-time / traffic / regenerate. Use change-link or revoke.",
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
          `${nextEnabled ? "🟢 Enable" : "⚪️ Disable"} product <b>${esc(product?.name || "?")}</b>?`,
          async () => {
            await setProductEnabled({ actorId: userId, operationId: randomUUID(), productId: product.id, enabled: nextEnabled });
            return `✅ Product ${nextEnabled ? "enabled" : "disabled"}.`;
          });
        break;
      }
      case "prodweb":
        await bot.answerCallbackQuery(query.id, {
          text: "Creating and editing products with full validation is available in the web admin dashboard (/admin).",
          show_alert: true,
        }).catch(() => {});
        break;
      case "bcast":
        await screenBroadcast(bot, chatId, messageId);
        break;
      case "bcaud": {
        const message = session?.adminPanelBroadcastMessage;
        if (!message) { await screenBroadcast(bot, chatId, messageId); break; }
        const audiences = [
          { id: "all", label: "👥 All users" },
          { id: "active", label: "🟢 Active users" },
          { id: "expired", label: "⏳ Expired users" },
          { id: "paying", label: "💳 Paying users" },
        ];
        const keyboard = { inline_keyboard: [
          ...audiences.map((audience) => [{ text: audience.label, callback_data: `adm:bcgo:${audience.id}` }]),
          [{ text: "⬅️ Rewrite message", callback_data: "adm:bcast" }],
          [HOME_BTN],
        ] };
        await editOrSend(bot, chatId, messageId,
          `📢 <b>Broadcast preview</b>\n\n——\n${esc(message.slice(0, 1200))}\n——\n\nChoose the audience:`,
          keyboard);
        break;
      }
      case "bcgo": {
        const message = session?.adminPanelBroadcastMessage;
        if (!message) { await screenBroadcast(bot, chatId, messageId); break; }
        await bot.answerCallbackQuery(query.id, { text: "🚀 Starting broadcast…" }).catch(() => {});
        const operationId = randomUUID();
        const result = await createBroadcast({ actorId: userId, operationId, message, audience: arg1 });
        await setSession(chatId, { step: null });
        await editOrSend(bot, chatId, messageId,
          `🚀 <b>Broadcast started</b>\n\nAudience: <b>${esc(arg1)}</b>\nRecipients: <b>${num(result.broadcast?.total ?? 0)}</b>\n\nTrack progress from the web dashboard, or check back here.`, { inline_keyboard: [[HOME_BTN]] });
        setTimeout(async () => {
          try {
            const status = await getBroadcastStatus({ actorId: userId, operationId });
            await bot.sendMessage(chatId,
              `📢 Broadcast update\n\nStatus: <b>${esc(status.status)}</b>\nSent: ${num(status.succeeded)}/${num(status.total)} · Failed: ${num(status.failed)}`,
              { parse_mode: "HTML" });
          } catch { /* status update is best-effort */ }
        }, 30_000).unref?.();
        break;
      }
      case "rec":
        await screenRecovery(bot, chatId, messageId);
        break;
      case "recgo":
        await bot.answerCallbackQuery(query.id, { text: "⏳ Retrying safe items…" }).catch(() => {});
        await confirmAndRun(bot, query, chatId, messageId,
          "🔄 <b>Retry all safe recovery items?</b>\n\nOnly idempotent paths are retried (paid-not-credited, pending commits). Ambiguous provisioning is never replayed.",
          async () => {
            const result = await retrySafeRecoveryItems({ actorId: userId, operationId: randomUUID() });
            return `✅ Retried ${num(result.attempted)}: ${num(result.succeeded)} succeeded, ${num(result.failed?.length || 0)} failed.`;
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
      case "x":
        await bot.answerCallbackQuery(query.id).catch(() => {});
        break;
      default:
        handled = false;
    }
  } catch (error) {
    const message = error instanceof AdminServiceError ? error.safeMessage : "The operation could not be completed.";
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
    `⚠️ <b>Confirmation required</b>\n\n${confirmText}`,
    { inline_keyboard: [
      [{ text: "✅ Confirm", callback_data: confirmKey }, { text: "❌ Cancel", callback_data: "adm:x" }],
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
    await bot.answerCallbackQuery(query.id, { text: "This confirmation expired. Try again.", show_alert: true }).catch(() => {});
    return true;
  }
  await bot.answerCallbackQuery(query.id, { text: "⏳ Running…" }).catch(() => {});
  try {
    const message = await pending.run();
    await editOrSend(bot, pending.chatId, pending.messageId, `${message}`, { inline_keyboard: [[HOME_BTN]] });
  } catch (error) {
    const text = error instanceof AdminServiceError ? error.safeMessage : "The operation could not be completed.";
    await editOrSend(bot, pending.chatId, pending.messageId, `❌ <b>Failed</b>\n\n${esc(text)}`, { inline_keyboard: [[HOME_BTN]] });
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
        await bot.sendMessage(chatId, `❌ No user found for <code>${esc(text)}</code>.`, { parse_mode: "HTML" });
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
        await bot.sendMessage(chatId, `❌ No VPN services found for <code>${esc(text)}</code>.`, { parse_mode: "HTML" });
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
        await bot.sendMessage(chatId, "❌ Send a whole positive amount in Toman.");
        return true;
      }
      const result = await changeUserBalance({
        actorId: userId, operationId: randomUUID(), telegramId: session.adminPanelUser,
        amount, direction, reason: `Telegram admin panel (${direction})`,
      });
      await bot.sendMessage(chatId, `✅ Balance ${direction === "add" ? "added" : "removed"}. New balance: <b>${money(result.balance)}</b>.`, { parse_mode: "HTML" });
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
      await bot.sendMessage(chatId, `✅ User ${result.isBanned ? "blocked" : "unblocked"}.`, { parse_mode: "HTML" });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await showUserProfile(bot, chatId, sent.messageId, session.adminPanelUser);
      await finish();
      return true;
    }

    if (step === "admin_panel_broadcast_message") {
      if (!text || text.length > 4096) {
        await bot.sendMessage(chatId, "❌ Message must be 1–4096 characters.");
        return true;
      }
      await setSession(chatId, { step: null, adminPanelBroadcastMessage: text });
      const sent = await bot.sendMessage(chatId, "…", { parse_mode: "HTML" });
      await editOrSend(bot, chatId, sent.message_id,
        `📢 <b>Broadcast preview</b>\n\n——\n${esc(text.slice(0, 1200))}\n——\n\nChoose the audience:`,
        { inline_keyboard: [
          [{ text: "👥 All users", callback_data: "adm:bcgo:all" }],
          [{ text: "🟢 Active users", callback_data: "adm:bcgo:active" }],
          [{ text: "⏳ Expired users", callback_data: "adm:bcgo:expired" }],
          [{ text: "💳 Paying users", callback_data: "adm:bcgo:paying" }],
          [{ text: "✏️ Rewrite message", callback_data: "adm:bcast" }],
          [HOME_BTN],
        ] });
      return true;
    }

    if (step.startsWith("admin_panel_resolve:")) {
      const rowIndex = Number(step.split(":")[1]);
      const key = session.adminPayKeys?.[rowIndex];
      if (!key) { await finish(); return true; }
      if (text.length < 10) {
        await bot.sendMessage(chatId, "❌ Please send at least a 10-character note describing the resolution.");
        return true;
      }
      await resolvePaymentRecovery({ actorId: userId, operationId: randomUUID(), key, reason: text });
      await bot.sendMessage(chatId, "✅ Recovery resolved and recorded in the audit log.");
      await finish();
      return true;
    }
  } catch (error) {
    const message = error instanceof AdminServiceError ? error.safeMessage : "The operation could not be completed.";
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
