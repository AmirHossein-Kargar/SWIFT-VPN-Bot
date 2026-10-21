/**
 * Send one Telegram message to one user from the web admin panel.
 *
 * Uses the bot singleton the rest of the app already runs (no second bot
 * instance; the token never leaves the server). Each send is an audited,
 * idempotent operation: a completed operationId replays its stored result
 * without sending again, and an in-flight or failed one is refused rather
 * than resent (runAuditedAction without resumeStarted), so a double click or
 * a retried request can never deliver the message twice.
 *
 * A send is reported as delivered only when Telegram accepted it; rejections
 * and network failures are surfaced as errors, never as success.
 */
import User from "../../models/User.js";
import { default as botInstance } from "../../config/botInstance.js";
import escapeHtml from "../../utils/escapeHtml.js";
import { getSupportDirectButton } from "../../messages/supportContact.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { requireTelegramId } from "./validation.js";

export const MAX_ADMIN_MESSAGE_LENGTH = 3500;
const HEADER = "🔔 <b>پیام از پشتیبانی</b>";

function validateMessage(raw) {
  if (typeof raw !== "string") {
    throw new AdminServiceError("Message text is required.", { status: 400, code: "invalid_message" });
  }
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text || text.length > MAX_ADMIN_MESSAGE_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new AdminServiceError(`Message must be 1–${MAX_ADMIN_MESSAGE_LENGTH} printable characters.`, { status: 400, code: "invalid_message" });
  }
  return text;
}

/** The exact Telegram payload, exported so the UI preview and tests agree with what is sent. */
export function buildAdminMessage(text) {
  return `${HEADER}\n\n${escapeHtml(text)}`;
}

function mapTelegramError(error) {
  const status = Number(error?.response?.statusCode);
  const description = String(error?.response?.body?.description || "");
  if (status === 403 || /blocked by the user|bot was blocked|user is deactivated/i.test(description)) {
    return new AdminServiceError("Telegram refused the message: the user has blocked the bot or deactivated their account.", { status: 409, code: "recipient_unreachable" });
  }
  if (status === 400 && /chat not found/i.test(description)) {
    return new AdminServiceError("Telegram has no chat with this user (they never started the bot).", { status: 404, code: "chat_not_found" });
  }
  if (status === 429) {
    return new AdminServiceError("Telegram rate-limited the bot; try again shortly.", { status: 429, code: "telegram_rate_limited" });
  }
  if (Number.isInteger(status)) {
    return new AdminServiceError(`Telegram rejected the message (HTTP ${status}).`, { status: 502, code: "telegram_rejected" });
  }
  // Network failure: Telegram may or may not have delivered it.
  return new AdminServiceError("The delivery outcome is unknown (network error talking to Telegram). Check with the user before sending again.", { status: 503, code: "delivery_unknown" });
}

export async function sendUserMessage({
  actorId,
  operationId,
  telegramId,
  message,
  ipAddress,
  bot = botInstance.bot,
  userModel = User,
  auditModel,
} = {}) {
  assertAdminUser(actorId);
  const id = requireTelegramId(telegramId);
  const text = validateMessage(message);

  const { result, replayed } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "USER_MESSAGE_SENT",
    targetType: "user",
    targetId: id,
    targetUserId: id,
    ipAddress,
    metadata: { characters: text.length },
    ...(auditModel ? { auditModel } : {}),
    execute: async () => {
      const exists = await userModel.findOne({ telegramId: id }).select("telegramId").lean();
      if (!exists) throw new AdminServiceError("User not found.", { status: 404, code: "user_not_found" });
      if (!bot?.sendMessage) {
        throw new AdminServiceError("The Telegram bot is not running on this server.", { status: 503, code: "bot_unavailable" });
      }
      const buttons = getSupportDirectButton();
      let sent;
      try {
        sent = await bot.sendMessage(id, buildAdminMessage(text), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
        });
      } catch (error) {
        throw mapTelegramError(error);
      }
      const messageId = Number.isInteger(sent?.message_id) ? sent.message_id : null;
      return { ok: true, delivered: true, telegramMessageId: messageId, auditSummary: { delivered: true, telegramMessageId: messageId } };
    },
  });
  // A replay returns the stored audit summary; make it explicit it was not resent.
  return replayed ? { ok: true, delivered: Boolean(result?.delivered), replayed: true, telegramMessageId: result?.telegramMessageId ?? null } : result;
}
