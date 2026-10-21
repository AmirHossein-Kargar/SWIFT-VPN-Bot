/**
 * Telegram support UX: a single support menu message that is edited in place
 * (no transient "loading" messages), ticket list/detail screens, and the
 * compose mode that routes the customer's next messages into a ticket.
 *
 * Session shape (Redis, keyed by Telegram user id):
 *   support: true            compose mode is active
 *   supportTicketId: string  ticket the next messages join (null = new ticket)
 *   supportMessageId: number the one message this flow edits
 *   supportAt: number        ms epoch of the last support interaction
 */
import { getSession, setSession } from "../../config/sessionStore.js";
import { getSupportMessage, getSupportDirectButton } from "../../messages/supportContact.js";
import escapeHtml from "../../utils/escapeHtml.js";
import {
  listCustomerTickets,
  getCustomerTicket,
  isValidTicketId,
  SupportError,
} from "../../services/support/tickets.js";
import { customerSetStatus } from "../../services/support/workflow.js";
import { statusLabel } from "../../services/support/delivery.js";
import { issueCustomerLoginCode } from "../../services/support/customerAuth.js";

export const COMPOSE_TTL_MS = 30 * 60 * 1000;
const HOME_ROW = [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "back_to_home" }];

const locks = new Map();

/** Serializes work per user so a double-tapped button cannot run a flow twice concurrently. */
export async function withUserLock(userId, fn) {
  const key = String(userId);
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function isComposing(session, now = Date.now()) {
  return Boolean(session?.support) && now - Number(session.supportAt || 0) < COMPOSE_TTL_MS;
}

export function logSupportError(event, error) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    service: "support-bot",
    level: "error",
    event,
    errorType: error?.name || "Error",
    code: typeof error?.code === "string" ? error.code : undefined,
  }));
}

function webBaseUrl() {
  const raw = String(process.env.WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\//i.test(raw) ? raw : null;
}

export function menuKeyboard() {
  const rows = [
    [{ text: "🎫 تیکت جدید", callback_data: "sup_new" }, { text: "📂 تیکت‌های من", callback_data: "sup_list" }],
  ];
  if (webBaseUrl()) rows.push([{ text: "🌐 مشاهده در پنل وب", callback_data: "sup_web" }]);
  return { inline_keyboard: [...rows, ...getSupportDirectButton(), HOME_ROW] };
}

/** Edit `messageId` in place; fall back to a fresh message only when Telegram cannot edit it. Returns the live message id. */
async function editOrSend(bot, chatId, messageId, text, reply_markup) {
  const options = { parse_mode: "HTML", reply_markup };
  if (messageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
      return messageId;
    } catch (error) {
      if (/message is not modified/i.test(String(error?.message))) return messageId;
    }
  }
  const sent = await bot.sendMessage(chatId, text, options);
  return sent?.message_id ?? null;
}

async function saveSession(userId, patch) {
  const session = (await getSession(userId)) || {};
  const next = { ...session, ...patch };
  await setSession(userId, next);
  return next;
}

async function leaveCompose(userId, extra = {}) {
  await saveSession(userId, { support: false, supportTicketId: null, supportAt: null, ...extra });
}

/**
 * Entry point for the "🛠 پشتیبانی" button. Sends exactly one menu message: a
 * previous support message (from an earlier tap) is removed first, so repeated
 * taps never stack up messages or sessions.
 */
export async function showSupportMenu(bot, chatId, userId, { messageId = null } = {}) {
  return withUserLock(userId, async () => {
    const session = (await getSession(userId)) || {};
    const previousId = session.supportMessageId;
    const text = getSupportMessage();
    let liveId;
    if (messageId) {
      liveId = await editOrSend(bot, chatId, messageId, text, menuKeyboard());
    } else {
      if (previousId) {
        try { await bot.deleteMessage(chatId, previousId); } catch { /* already gone */ }
      }
      const sent = await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: menuKeyboard() });
      liveId = sent?.message_id ?? null;
    }
    await setSession(userId, { ...session, support: false, supportTicketId: null, supportAt: null, supportMessageId: liveId });
    return liveId;
  });
}

function ticketLine(ticket) {
  const unread = ticket.unread ? " 🔔" : "";
  return `${ticket.ticketId} • ${statusLabel(ticket.status)}${unread}`;
}

async function showTicketList(bot, chatId, userId, messageId) {
  const tickets = await listCustomerTickets({ userId, limit: 8 });
  if (!tickets.length) {
    return editOrSend(bot, chatId, messageId, "📂 هنوز تیکتی ثبت نکرده‌اید.", {
      inline_keyboard: [[{ text: "🎫 تیکت جدید", callback_data: "sup_new" }], [{ text: "⬅️ بازگشت", callback_data: "sup_menu" }], HOME_ROW],
    });
  }
  const rows = tickets.map((ticket) => [{ text: `${ticketLine(ticket)} — ${ticket.subject.slice(0, 24)}`, callback_data: `sup_open:${ticket.ticketId}` }]);
  rows.push([{ text: "⬅️ بازگشت", callback_data: "sup_menu" }], HOME_ROW);
  return editOrSend(bot, chatId, messageId, "📂 <b>تیکت‌های من</b>\nیکی را برای مشاهده یا ادامه گفتگو انتخاب کنید.", { inline_keyboard: rows });
}

async function showTicket(bot, chatId, userId, messageId, ticketId) {
  const { ticket, messages } = await getCustomerTicket({ userId, ticketId });
  const recent = messages.slice(-3).map((message) => {
    const who = message.author === "admin" ? "🛠 پشتیبانی" : "👤 شما";
    const body = message.text ? escapeHtml(message.text.slice(0, 300)) : message.attachment ? (message.attachment.kind === "photo" ? "🖼 عکس" : "🎥 فیلم") : "";
    return `${who}: ${body}`;
  });
  const closed = ticket.status === "closed";
  const text =
    `🎫 <b>تیکت ${escapeHtml(ticket.ticketId)}</b> — ${statusLabel(ticket.status)}\n📌 ${escapeHtml(ticket.subject)}\n\n` +
    `${recent.join("\n\n")}\n\n` +
    (closed ? "این تیکت بسته است." : "✍️ برای ادامه گفتگو، پیام خود را همین‌جا ارسال کنید.");
  const rows = closed
    ? [[{ text: "🔓 بازگشایی تیکت", callback_data: `sup_reopen:${ticketId}` }]]
    : [[{ text: "🔒 بستن تیکت", callback_data: `sup_close:${ticketId}` }]];
  rows.push([{ text: "⬅️ تیکت‌های من", callback_data: "sup_list" }], HOME_ROW);
  const liveId = await editOrSend(bot, chatId, messageId, text, { inline_keyboard: rows });
  if (closed) await leaveCompose(userId, { supportMessageId: liveId });
  else await saveSession(userId, { support: true, supportTicketId: ticketId, supportAt: Date.now(), supportMessageId: liveId });
}

async function startNewTicket(bot, chatId, userId, messageId) {
  const liveId = await editOrSend(
    bot,
    chatId,
    messageId,
    "✍️ پیام خود را ارسال کنید (متن، عکس یا فیلم).\nبا اولین پیام، یک تیکت جدید ساخته می‌شود.",
    { inline_keyboard: [[{ text: "❌ انصراف", callback_data: "sup_menu" }], HOME_ROW] },
  );
  await saveSession(userId, { support: true, supportTicketId: null, supportAt: Date.now(), supportMessageId: liveId });
}

async function sendWebLink(bot, chatId, userId) {
  const base = webBaseUrl();
  if (!base) return "پنل وب در دسترس نیست.";
  const { code } = await issueCustomerLoginCode(userId);
  const url = `${base}/panel/support/login#code=${code}`;
  await bot.sendMessage(chatId, "🌐 لینک ورود یک‌بارمصرف به پنل پشتیبانی (۵ دقیقه معتبر است):", {
    reply_markup: { inline_keyboard: [[{ text: "ورود به پنل پشتیبانی", url }]] },
    protect_content: true,
  });
  return null;
}

const CALLBACK_PATTERN = /^sup_(menu|new|list|web|open|close|reopen)(?::(T-[A-HJ-NP-Z2-9]{6}))?$/;

/**
 * Handles every `sup_*` callback. Returns true when the callback belonged to
 * the support flow. The query is always answered exactly once, so Telegram's
 * button spinner stops on success, failure and stale taps alike.
 */
export async function handleSupportCallback(bot, query) {
  const match = CALLBACK_PATTERN.exec(String(query?.data || ""));
  if (!match) return false;
  const [, action, ticketId] = match;
  const userId = query.from?.id;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  let answer = {};

  if (!userId || !chatId || !messageId || query.message?.chat?.type !== "private") {
    await bot.answerCallbackQuery(query.id, { text: "⚠️ این دکمه دیگر معتبر نیست.", show_alert: true }).catch(() => {});
    return true;
  }

  try {
    await withUserLock(userId, async () => {
      switch (action) {
        case "menu":
          await leaveCompose(userId);
          await editOrSend(bot, chatId, messageId, getSupportMessage(), menuKeyboard());
          await saveSession(userId, { supportMessageId: messageId });
          break;
        case "new":
          await startNewTicket(bot, chatId, userId, messageId);
          break;
        case "list":
          await leaveCompose(userId);
          await showTicketList(bot, chatId, userId, messageId);
          break;
        case "web": {
          const failure = await sendWebLink(bot, chatId, userId);
          if (failure) answer = { text: failure, show_alert: true };
          break;
        }
        case "open":
          if (!ticketId) throw new SupportError("تیکت یافت نشد.", { status: 404, code: "ticket_not_found" });
          await showTicket(bot, chatId, userId, messageId, ticketId);
          break;
        case "close":
        case "reopen": {
          if (!ticketId) throw new SupportError("تیکت یافت نشد.", { status: 404, code: "ticket_not_found" });
          await customerSetStatus({ bot, userId, ticketId, status: action === "close" ? "closed" : "open" });
          if (action === "close") {
            await leaveCompose(userId);
            const liveId = await editOrSend(bot, chatId, messageId, `🔒 تیکت <b>${escapeHtml(ticketId)}</b> بسته شد.`, {
              inline_keyboard: [[{ text: "🔓 بازگشایی تیکت", callback_data: `sup_reopen:${ticketId}` }], [{ text: "⬅️ تیکت‌های من", callback_data: "sup_list" }], HOME_ROW],
            });
            await saveSession(userId, { supportMessageId: liveId });
          } else {
            await showTicket(bot, chatId, userId, messageId, ticketId);
          }
          break;
        }
        default:
          break;
      }
    });
  } catch (error) {
    if (error instanceof SupportError) {
      answer = { text: `⚠️ ${error.safeMessage}`, show_alert: true };
    } else {
      logSupportError("support_callback_failed", error);
      answer = { text: "❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.", show_alert: true };
    }
  }
  await bot.answerCallbackQuery(query.id, answer).catch(() => {});
  return true;
}

export { isValidTicketId };
