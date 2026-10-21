/**
 * Support ticket domain logic, shared by the Telegram bot, the customer web
 * area and the admin panel. Telegram/web delivery lives in ./delivery.js; this
 * module only owns persistence, ownership checks and the status lifecycle.
 *
 * Lifecycle:  open ⇄ pending → resolved → closed → (reopen) open
 *   - open     waiting for support
 *   - pending  support has replied, waiting for the customer
 *   - resolved support considers it done; a customer reply reopens it
 *   - closed   final until someone explicitly reopens it
 *
 * Models are injectable so the rules can be tested without MongoDB.
 */
import { randomBytes } from "node:crypto";
import SupportTicket, { TICKET_STATUSES } from "../../models/SupportTicket.js";
import SupportTicketMessage from "../../models/SupportTicketMessage.js";

export { TICKET_STATUSES };

export const MAX_MESSAGE_LENGTH = 3500;
export const MAX_SUBJECT_LENGTH = 100;
export const MAX_OPEN_TICKETS_PER_USER = 5;
export const CUSTOMER_REOPEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const TICKET_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TICKET_ID_PATTERN = /^T-[A-HJ-NP-Z2-9]{6}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const ADMIN_TRANSITIONS = Object.freeze({
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
});

export class SupportError extends Error {
  constructor(message, { status = 400, code = "support_error" } = {}) {
    super(message);
    this.name = "SupportError";
    this.status = status;
    this.code = code;
    this.safeMessage = message;
  }
}

const ERRORS = Object.freeze({
  notFound: () => new SupportError("تیکت یافت نشد.", { status: 404, code: "ticket_not_found" }),
  closed: () => new SupportError("این تیکت بسته شده است. برای ادامه، تیکت را دوباره باز کنید.", { status: 409, code: "ticket_closed" }),
  badStatus: () => new SupportError("وضعیت تیکت معتبر نیست.", { status: 400, code: "invalid_status" }),
  badTransition: () => new SupportError("این تغییر وضعیت مجاز نیست.", { status: 409, code: "invalid_transition" }),
  emptyMessage: () => new SupportError("متن پیام یا پیوست معتبر لازم است.", { status: 400, code: "invalid_message" }),
  tooManyOpen: () => new SupportError("تعداد تیکت‌های باز شما به سقف مجاز رسیده است. ابتدا یکی از تیکت‌ها را ببندید.", { status: 429, code: "too_many_open_tickets" }),
  reopenExpired: () => new SupportError("مهلت بازگشایی این تیکت گذشته است. لطفاً تیکت جدید ثبت کنید.", { status: 409, code: "reopen_window_expired" }),
});

// Test seam: lets flow tests (bot handlers, HTTP routes) run against in-memory models.
let injectedModels = null;
export function setSupportModelsForTests(deps) { injectedModels = deps; }
export function clearSupportModelsForTests() { injectedModels = null; }

function models(deps = {}) {
  const base = injectedModels || {};
  return {
    Ticket: deps.Ticket || base.Ticket || SupportTicket,
    Message: deps.Message || base.Message || SupportTicketMessage,
  };
}

export function isValidTicketId(value) {
  return typeof value === "string" && TICKET_ID_PATTERN.test(value);
}

function generateTicketId() {
  const bytes = randomBytes(6);
  let id = "T-";
  for (const byte of bytes) id += TICKET_ID_ALPHABET[byte % TICKET_ID_ALPHABET.length];
  return id;
}

function normalizeUserId(userId) {
  const text = String(userId ?? "");
  if (!/^\d{1,20}$/.test(text)) throw ERRORS.notFound();
  return text;
}

/** Trims and validates message text; control characters are rejected rather than silently stripped. */
export function normalizeText(raw) {
  const text = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : "";
  if (text.length > MAX_MESSAGE_LENGTH || CONTROL_CHARS.test(text)) throw ERRORS.emptyMessage();
  return text;
}

export function deriveSubject(text, fallback = "درخواست پشتیبانی") {
  const firstLine = String(text || "").split("\n").find((line) => line.trim()) || "";
  const subject = firstLine.trim().slice(0, MAX_SUBJECT_LENGTH);
  return subject || fallback;
}

function normalizeAttachment(attachment) {
  if (!attachment) return null;
  if (!["photo", "video"].includes(attachment.kind) || typeof attachment.fileId !== "string" || !attachment.fileId || attachment.fileId.length > 256) {
    throw ERRORS.emptyMessage();
  }
  return { kind: attachment.kind, fileId: attachment.fileId, fileSize: Number.isFinite(attachment.fileSize) ? attachment.fileSize : null };
}

function requireDedupeKey(dedupeKey) {
  if (typeof dedupeKey !== "string" || !dedupeKey || dedupeKey.length > 120) throw ERRORS.emptyMessage();
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

function publicMessage(doc) {
  return {
    id: String(doc._id),
    author: doc.author,
    text: doc.text || "",
    attachment: doc.attachment ? { kind: doc.attachment.kind } : null,
    createdAt: doc.createdAt,
  };
}

/** Customer and admin views differ: customers never see other users' ids or admin-side fields. */
function publicTicket(doc, audience) {
  const view = {
    ticketId: doc.ticketId,
    subject: doc.subject,
    status: doc.status,
    channel: doc.channel,
    createdAt: doc.createdAt,
    lastMessageAt: doc.lastMessageAt,
    lastMessageBy: doc.lastMessageBy,
    messageCount: doc.messageCount,
    closedAt: doc.closedAt,
  };
  if (audience === "customer") {
    view.unread = doc.unreadForCustomer || 0;
  } else {
    view.unread = doc.unreadForAdmin || 0;
    view.userTelegramId = doc.userTelegramId;
    view.closedBy = doc.closedBy;
  }
  return view;
}

async function insertMessage(Message, fields) {
  try {
    const doc = await Message.create(fields);
    return { doc, duplicate: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await Message.findOne({ dedupeKey: fields.dedupeKey }).lean();
    // A key collision with a different ticket is never "the same message".
    if (!existing || existing.ticketId !== fields.ticketId) throw error;
    return { doc: existing, duplicate: true };
  }
}

export async function createTicket({ userId, subject, text, attachment = null, dedupeKey, channel = "telegram" }, deps = {}) {
  const { Ticket, Message } = models(deps);
  const owner = normalizeUserId(userId);
  const body = normalizeText(text);
  const file = normalizeAttachment(attachment);
  if (!body && !file) throw ERRORS.emptyMessage();
  requireDedupeKey(dedupeKey);

  // Replay of the same inbound event returns the ticket it already created.
  const replay = await Message.findOne({ dedupeKey }).lean();
  if (replay) {
    const ticket = await Ticket.findOne({ ticketId: replay.ticketId, userTelegramId: owner }).lean();
    if (!ticket) throw ERRORS.notFound();
    return { ticket: publicTicket(ticket, "customer"), message: replay, duplicate: true, created: false };
  }

  const openCount = await Ticket.countDocuments({ userTelegramId: owner, status: { $ne: "closed" } });
  if (openCount >= MAX_OPEN_TICKETS_PER_USER) throw ERRORS.tooManyOpen();

  const cleanSubject = (typeof subject === "string" ? subject.replace(CONTROL_CHARS, " ").trim() : "").slice(0, MAX_SUBJECT_LENGTH) || deriveSubject(body);
  let ticket = null;
  for (let attempt = 0; attempt < 5 && !ticket; attempt += 1) {
    try {
      const now = new Date();
      ticket = await Ticket.create({
        ticketId: generateTicketId(),
        userTelegramId: owner,
        subject: cleanSubject,
        channel,
        status: "open",
        lastMessageAt: now,
        lastMessageBy: "customer",
        unreadForAdmin: 1,
        messageCount: 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  if (!ticket) throw new SupportError("ثبت تیکت اکنون ممکن نیست. دوباره تلاش کنید.", { status: 503, code: "ticket_unavailable" });

  const { doc, duplicate } = await insertMessage(Message, {
    ticketId: ticket.ticketId, author: "customer", text: body, attachment: file, dedupeKey,
  });
  if (duplicate) {
    // A concurrent twin won the race: discard the ticket created for this attempt.
    await Ticket.deleteOne({ ticketId: ticket.ticketId });
    const winner = await Ticket.findOne({ ticketId: doc.ticketId, userTelegramId: owner }).lean();
    if (!winner) throw ERRORS.notFound();
    return { ticket: publicTicket(winner, "customer"), message: doc, duplicate: true, created: false };
  }
  return { ticket: publicTicket(ticket, "customer"), message: doc, duplicate: false, created: true };
}

export async function addCustomerMessage({ ticketId, userId, text, attachment = null, dedupeKey }, deps = {}) {
  const { Ticket, Message } = models(deps);
  const owner = normalizeUserId(userId);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const body = normalizeText(text);
  const file = normalizeAttachment(attachment);
  if (!body && !file) throw ERRORS.emptyMessage();
  requireDedupeKey(dedupeKey);

  const ticket = await Ticket.findOne({ ticketId, userTelegramId: owner }).lean();
  if (!ticket) throw ERRORS.notFound();
  if (ticket.status === "closed") throw ERRORS.closed();

  const { doc, duplicate } = await insertMessage(Message, { ticketId, author: "customer", text: body, attachment: file, dedupeKey });
  if (duplicate) return { ticket: publicTicket(ticket, "customer"), message: doc, duplicate: true };

  const updated = await Ticket.findOneAndUpdate(
    { ticketId, userTelegramId: owner, status: { $ne: "closed" } },
    {
      $set: { status: "open", lastMessageAt: doc.createdAt || new Date(), lastMessageBy: "customer", updatedAt: new Date() },
      $inc: { unreadForAdmin: 1, messageCount: 1 },
    },
    { new: true },
  ).lean();
  // The ticket was closed between the read and the write: surface it instead of orphaning the message.
  if (!updated) {
    await Message.deleteOne({ dedupeKey });
    throw ERRORS.closed();
  }
  return { ticket: publicTicket(updated, "customer"), message: doc, duplicate: false };
}

export async function addAdminReply({ ticketId, adminId, text, attachment = null, dedupeKey }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const body = normalizeText(text);
  const file = normalizeAttachment(attachment);
  if (!body && !file) throw ERRORS.emptyMessage();
  requireDedupeKey(dedupeKey);

  const ticket = await Ticket.findOne({ ticketId }).lean();
  if (!ticket) throw ERRORS.notFound();
  if (ticket.status === "closed") throw ERRORS.closed();

  const { doc, duplicate } = await insertMessage(Message, {
    ticketId, author: "admin", authorAdminId: String(adminId), text: body, attachment: file, dedupeKey,
  });
  if (duplicate) return { ticket: publicTicket(ticket, "admin"), message: doc, duplicate: true, customerId: ticket.userTelegramId };

  const updated = await Ticket.findOneAndUpdate(
    { ticketId, status: { $ne: "closed" } },
    {
      $set: { status: "pending", lastMessageAt: doc.createdAt || new Date(), lastMessageBy: "admin", unreadForAdmin: 0, updatedAt: new Date() },
      $inc: { unreadForCustomer: 1, messageCount: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) {
    await Message.deleteOne({ dedupeKey });
    throw ERRORS.closed();
  }
  return { ticket: publicTicket(updated, "admin"), message: doc, duplicate: false, customerId: updated.userTelegramId };
}

/**
 * Status change. Admins follow ADMIN_TRANSITIONS; customers may only close
 * their own ticket or reopen one that was closed within the reopen window.
 */
export async function changeStatus({ ticketId, status, actor }, deps = {}) {
  const { Ticket } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  if (!TICKET_STATUSES.includes(status)) throw ERRORS.badStatus();
  const isCustomer = actor?.role === "customer";
  const audience = isCustomer ? "customer" : "admin";
  const filter = isCustomer ? { ticketId, userTelegramId: normalizeUserId(actor.id) } : { ticketId };
  const ticket = await Ticket.findOne(filter).lean();
  if (!ticket) throw ERRORS.notFound();
  if (ticket.status === status) return { ticket: publicTicket(ticket, audience), changed: false, customerId: ticket.userTelegramId };

  if (isCustomer) {
    const closing = status === "closed";
    const reopening = status === "open" && ticket.status === "closed";
    if (!closing && !reopening) throw ERRORS.badTransition();
    if (reopening && ticket.closedAt && Date.now() - new Date(ticket.closedAt).getTime() > CUSTOMER_REOPEN_WINDOW_MS) throw ERRORS.reopenExpired();
  } else if (!ADMIN_TRANSITIONS[ticket.status]?.includes(status)) {
    throw ERRORS.badTransition();
  }

  const set = { status, updatedAt: new Date() };
  if (status === "closed") {
    set.closedAt = new Date();
    set.closedBy = audience;
  } else if (ticket.status === "closed") {
    set.closedAt = null;
    set.closedBy = null;
  }
  // Compare-and-set on the status we validated against, so two concurrent
  // transitions cannot both succeed from the same starting state.
  const updated = await Ticket.findOneAndUpdate({ ...filter, status: ticket.status }, { $set: set }, { new: true }).lean();
  if (!updated) throw ERRORS.badTransition();
  return { ticket: publicTicket(updated, audience), changed: true, previous: ticket.status, customerId: updated.userTelegramId };
}

export async function listCustomerTickets({ userId, limit = 20 }, deps = {}) {
  const { Ticket } = models(deps);
  const owner = normalizeUserId(userId);
  const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const rows = await Ticket.find({ userTelegramId: owner }).sort({ lastMessageAt: -1 }).limit(size).lean();
  return rows.map((row) => publicTicket(row, "customer"));
}

/** Returns a ticket with its messages if, and only if, it belongs to the user. */
export async function getCustomerTicket({ userId, ticketId, markRead = true }, deps = {}) {
  const { Ticket, Message } = models(deps);
  const owner = normalizeUserId(userId);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const ticket = await Ticket.findOne({ ticketId, userTelegramId: owner }).lean();
  if (!ticket) throw ERRORS.notFound();
  if (markRead && ticket.unreadForCustomer) {
    await Ticket.updateOne({ ticketId, userTelegramId: owner }, { $set: { unreadForCustomer: 0 } });
    ticket.unreadForCustomer = 0;
  }
  const messages = await Message.find({ ticketId }).sort({ createdAt: 1 }).limit(500).lean();
  return { ticket: publicTicket(ticket, "customer"), messages: messages.map(publicMessage) };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listAdminTickets({ status, query, unreadOnly = false, page = 1, pageSize = 20 } = {}, deps = {}) {
  const { Ticket } = models(deps);
  const filter = {};
  if (status) {
    if (!TICKET_STATUSES.includes(status)) throw ERRORS.badStatus();
    filter.status = status;
  }
  if (unreadOnly) filter.unreadForAdmin = { $gt: 0 };
  const q = typeof query === "string" ? query.trim().slice(0, 40) : "";
  if (q) {
    if (/^\d{1,20}$/.test(q)) filter.userTelegramId = q;
    else if (isValidTicketId(q.toUpperCase())) filter.ticketId = q.toUpperCase();
    else filter.subject = { $regex: escapeRegex(q), $options: "i" };
  }
  const size = Math.min(Math.max(Number(pageSize) || 20, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const [rows, total, needsAttention] = await Promise.all([
    Ticket.find(filter).sort({ lastMessageAt: -1 }).skip((current - 1) * size).limit(size).lean(),
    Ticket.countDocuments(filter),
    Ticket.countDocuments({ status: "open", unreadForAdmin: { $gt: 0 } }),
  ]);
  return { tickets: rows.map((row) => publicTicket(row, "admin")), total, page: current, pageSize: size, needsAttention };
}

export async function getAdminTicket({ ticketId, markRead = true }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const ticket = await Ticket.findOne({ ticketId }).lean();
  if (!ticket) throw ERRORS.notFound();
  if (markRead && ticket.unreadForAdmin) {
    await Ticket.updateOne({ ticketId }, { $set: { unreadForAdmin: 0 } });
    ticket.unreadForAdmin = 0;
  }
  const messages = await Message.find({ ticketId }).sort({ createdAt: 1 }).limit(500).lean();
  return { ticket: publicTicket(ticket, "admin"), messages: messages.map(publicMessage) };
}

/** Attachment reference for a download. Pass `ownerId` for customers: other users' messages resolve to not-found. */
export async function getMessageAttachment({ messageId, ownerId = null }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!/^[a-f0-9]{24}$/i.test(String(messageId))) throw ERRORS.notFound();
  const message = await Message.findOne({ _id: messageId }).lean();
  if (!message?.attachment) throw ERRORS.notFound();
  if (ownerId !== null) {
    const ticket = await Ticket.findOne({ ticketId: message.ticketId, userTelegramId: normalizeUserId(ownerId) }).lean();
    if (!ticket) throw ERRORS.notFound();
  }
  return message.attachment;
}

export async function recordGroupMessage({ dedupeKey, groupMessageId }, deps = {}) {
  const { Message } = models(deps);
  if (!Number.isInteger(groupMessageId)) return;
  await Message.updateOne({ dedupeKey }, { $addToSet: { groupMessageIds: groupMessageId }, $set: { delivery: "sent" } });
}

export async function recordDelivery({ dedupeKey, delivery }, deps = {}) {
  const { Message } = models(deps);
  if (!["sent", "failed", "pending"].includes(delivery)) return;
  await Message.updateOne({ dedupeKey }, { $set: { delivery } });
}

/** Maps a Telegram reply in the admin group back to the ticket it came from. */
export async function findTicketByGroupMessage({ groupMessageId }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!Number.isInteger(groupMessageId)) return null;
  const message = await Message.findOne({ groupMessageIds: groupMessageId }).lean();
  if (!message) return null;
  return Ticket.findOne({ ticketId: message.ticketId }).lean();
}
