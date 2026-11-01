/**
 * Support ticket domain logic, shared by the Telegram bot, the customer web
 * area and the admin panel. Telegram delivery lives in ./delivery.js; this
 * module only owns persistence, ownership checks and the status lifecycle.
 *
 * Lifecycle:   open ⇄ pending_customer → closed (final)
 *   - open              waiting for support (new tickets, and any customer message)
 *   - pending_customer  support has replied and is waiting for the customer
 *   - closed            final: nobody can post to it and nobody can reopen it.
 *                       A customer who still needs help opens a new ticket.
 *
 * Tickets stored before this lifecycle may carry `pending` / `resolved`; they
 * are treated as `pending_customer` / `closed` everywhere (and rewritten by
 * migrateLegacyTicketStatuses at startup).
 *
 * Every write that must not touch a closed ticket is a conditional update
 * (`status: { $nin: closed values }`) performed BEFORE the message row is
 * written (see acceptMessage), so a close racing a message resolves to exactly
 * one outcome: the message is accepted (and persisted, counted, deliverable),
 * or it is rejected and nothing at all was written.
 *
 * Creating a ticket is two writes (ticket, first message) and MongoDB gives no
 * atomic write across collections, so a new ticket is `provisional` (hidden from
 * every list, count and lookup) until its first message exists; see createTicket.
 *
 * Models are injectable so the rules can be tested without MongoDB.
 */
import { randomBytes } from "node:crypto";
import SupportTicket, {
  TICKET_STATUSES,
  CLOSED_STATUS_VALUES,
  normalizeTicketStatus,
} from "../../models/SupportTicket.js";
import SupportTicketMessage from "../../models/SupportTicketMessage.js";
import User from "../../models/User.js";
import { SUPPORT_COPY } from "../../messages/supportCopy.js";
import { ticketDeletionEligibility } from "./retention.js";

export { TICKET_STATUSES, normalizeTicketStatus };

export const MAX_MESSAGE_LENGTH = 3500;
export const MAX_SUBJECT_LENGTH = 100;
export const MAX_OPEN_TICKETS_PER_USER = 5;
/** Telegram bots cannot download larger files, and the attachment proxy enforces the same cap. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ADMIN_PAGE_SIZE = 40;
export const CUSTOMER_PAGE_SIZE = 500;

const TICKET_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TICKET_ID_PATTERN = /^T-[A-HJ-NP-Z2-9]{6}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const NOT_CLOSED = Object.freeze({ $nin: CLOSED_STATUS_VALUES });
/**
 * Open-ticket count used by the cap. It is pinned to the single-field owner
 * index because `userTelegramId` never changes: a scan of that index cannot
 * miss a ticket whose OTHER indexed fields (lastMessageAt, status) are updated
 * while the count runs. If the index is missing the hint is rejected (BadValue)
 * and the plain count is used.
 */
const OWNER_INDEX = "userTelegramId_1";
async function countOpenTickets(Ticket, owner) {
  const filter = { userTelegramId: owner, status: NOT_CLOSED };
  try {
    return await Ticket.countDocuments(filter, { hint: OWNER_INDEX });
  } catch (error) {
    if (error?.code !== 2 && error?.codeName !== "BadValue") throw error;
    return Ticket.countDocuments(filter);
  }
}
/** Spread into every ticket filter that serves a reader: half-created tickets do not exist for them. */
const VISIBLE = Object.freeze({ provisional: { $ne: true } });
/** A provisional ticket older than this was abandoned by a crashed create and is recovered or removed. */
export const PROVISIONAL_GRACE_MS = 60_000;
/** How often a creator that loses a cap race tries again before giving up with "too many open tickets". */
const CAP_RACE_ROUNDS = 6;
const STATUS_QUERY_VALUES = Object.freeze({
  open: ["open"],
  pending_customer: ["pending_customer", "pending"],
  closed: [...CLOSED_STATUS_VALUES],
});

const ADMIN_TRANSITIONS = Object.freeze({
  open: ["pending_customer", "closed"],
  pending_customer: ["open", "closed"],
  closed: [],
});

export class SupportError extends Error {
  /**
   * `message` is the customer-facing (Persian) text; `adminMessage` is the
   * English text the admin panel shows for the same failure.
   */
  constructor(message, { status = 400, code = "support_error", adminMessage = null } = {}) {
    super(message);
    this.name = "SupportError";
    this.status = status;
    this.code = code;
    this.safeMessage = message;
    this.adminMessage = adminMessage || message;
  }
}

/** Re-labels a SupportError with its English message for admin API responses. */
export function toAdminError(error) {
  if (!(error instanceof SupportError)) return error;
  return new SupportError(error.adminMessage, { status: error.status, code: error.code, adminMessage: error.adminMessage });
}

const ERRORS = Object.freeze({
  notFound: () => new SupportError("تیکت یافت نشد.", { status: 404, code: "ticket_not_found", adminMessage: "Ticket not found." }),
  closed: () => new SupportError(SUPPORT_COPY.closed, { status: 409, code: "ticket_closed", adminMessage: "This ticket is closed and cannot receive new messages." }),
  reopenForbidden: () => new SupportError(SUPPORT_COPY.closed, { status: 409, code: "reopen_not_allowed", adminMessage: "Closed tickets cannot be reopened. The customer can open a new ticket." }),
  badStatus: () => new SupportError("وضعیت تیکت معتبر نیست.", { status: 400, code: "invalid_status", adminMessage: "Invalid ticket status." }),
  badTransition: () => new SupportError("این تغییر وضعیت مجاز نیست.", { status: 409, code: "invalid_transition", adminMessage: "This status change is not allowed." }),
  emptyMessage: () => new SupportError("متن پیام یا پیوست معتبر لازم است.", { status: 400, code: "invalid_message", adminMessage: "A message or a valid attachment is required." }),
  tooLong: () => new SupportError("پیام شما بیش از حد طولانی است.", { status: 400, code: "message_too_long", adminMessage: `Message is too long (maximum ${MAX_MESSAGE_LENGTH.toLocaleString("en-US")} characters).` }),
  tooManyOpen: () => new SupportError("تعداد تیکت‌های باز شما به سقف مجاز رسیده است. ابتدا یکی از تیکت‌ها را ببندید.", { status: 429, code: "too_many_open_tickets", adminMessage: "Too many open tickets for this customer." }),
  attachmentTooLarge: () => new SupportError("حجم فایل بیش از حد مجاز است.", { status: 413, code: "attachment_too_large", adminMessage: "The attachment is larger than the 20 MB limit." }),
  unavailable: () => new SupportError("ثبت تیکت اکنون ممکن نیست. دوباره تلاش کنید.", { status: 503, code: "ticket_unavailable", adminMessage: "Ticket creation is unavailable. Try again." }),
});

// Test seam: lets flow tests (bot handlers, HTTP routes) run against in-memory models.
let injectedModels = null;
export function setSupportModelsForTests(deps) { injectedModels = deps; }
export function clearSupportModelsForTests() { injectedModels = null; }
/** Model handles (injected in tests) for sibling support services such as deletion.js. */
export function getSupportModels(deps = {}) { return models(deps); }

function models(deps = {}) {
  const base = injectedModels || {};
  return {
    Ticket: deps.Ticket || base.Ticket || SupportTicket,
    Message: deps.Message || base.Message || SupportTicketMessage,
    User: deps.User || base.User || User,
  };
}

export function isValidTicketId(value) {
  return typeof value === "string" && TICKET_ID_PATTERN.test(value);
}

const isClosed = (status) => CLOSED_STATUS_VALUES.includes(status);

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
  if (text.length > MAX_MESSAGE_LENGTH) throw ERRORS.tooLong();
  if (CONTROL_CHARS.test(text)) throw ERRORS.emptyMessage();
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
  const size = Number.isFinite(attachment.fileSize) ? attachment.fileSize : null;
  if (size !== null && (size < 0 || size > MAX_ATTACHMENT_BYTES)) throw ERRORS.attachmentTooLarge();
  return { kind: attachment.kind, fileId: attachment.fileId, fileSize: size };
}

function requireDedupeKey(dedupeKey) {
  if (typeof dedupeKey !== "string" || !dedupeKey || dedupeKey.length > 120) throw ERRORS.emptyMessage();
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

/** `audience` decides which delivery/sender details a reader may see. */
function publicMessage(doc, audience = "customer") {
  const view = {
    id: String(doc._id),
    author: doc.author,
    text: doc.text || "",
    attachment: doc.attachment ? { kind: doc.attachment.kind, fileSize: doc.attachment.fileSize ?? null } : null,
    createdAt: doc.createdAt,
  };
  if (audience === "admin") {
    view.adminId = doc.author === "admin" ? doc.authorAdminId ?? null : null;
    view.delivery = doc.author === "admin" ? doc.delivery || "pending" : null;
  }
  return view;
}

/** Customer and admin views differ: customers never see other users' ids or admin-side fields. */
function publicTicket(doc, audience) {
  const view = {
    ticketId: doc.ticketId,
    subject: doc.subject,
    status: normalizeTicketStatus(doc.status),
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
    view.closedByAdminId = doc.closedByAdminId ?? null;
    const verdict = ticketDeletionEligibility(doc);
    view.deletable = verdict.eligible;
    view.deletableAt = verdict.eligibleAt;
  }
  return view;
}

/**
 * Inserts a message, absorbing a replay of the same event (unique dedupeKey).
 * A collision with a message of a DIFFERENT ticket is never "the same message"
 * and is reported as a retryable failure, never as a raw duplicate-key error.
 */
async function insertMessage(Message, fields) {
  try {
    const doc = await Message.create(fields);
    return { doc, duplicate: false };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await Message.findOne({ dedupeKey: fields.dedupeKey }).lean();
    if (!existing || existing.ticketId !== fields.ticketId) throw ERRORS.unavailable();
    return { doc: existing, duplicate: true };
  }
}

/** The message a retried request already stored on this ticket, if any. */
async function findReplay(Message, { dedupeKey, ticketId, author }) {
  const existing = await Message.findOne({ dedupeKey }).lean();
  return existing && existing.ticketId === ticketId && existing.author === author ? existing : null;
}

/**
 * Completes a provisional ticket. EVERY path that makes a hidden ticket visible
 * (the creator, a twin's retry, the recovery sweep) goes through here or
 * through the same check, because the cap invariant needs it:
 *
 *   VERIFY    count the owner's non-closed tickets (hidden ones included). Over
 *             the cap means this ticket is withdrawn (only while still hidden)
 *             and `null` is returned; nothing was acknowledged to anyone.
 *   STORE     the first message (absorbing a twin's identical insert).
 *   ACTIVATE  one conditional update; only the call whose update matches
 *             reports `created`, so the new-ticket alert fires once.
 *
 * Why the cap holds: a ticket becomes visible only after a count that started
 * after its own insert and showed <= MAX. Take the visible ticket whose count
 * started last: every other visible ticket was inserted before its own count,
 * which started no later, so all of them (and every legacy open ticket) are in
 * that count; hence the final total <= MAX. A ticket is deleted only by the
 * failed verification of the very same ticket (or a sweep), never by another
 * creator's decision, and deletions only lower later counts for tickets that
 * really are gone.
 */
async function completeCreate({ Ticket, Message }, ticket, fields) {
  if ((await countOpenTickets(Ticket, ticket.userTelegramId)) > MAX_OPEN_TICKETS_PER_USER) {
    const removed = await Ticket.deleteOne({ ticketId: ticket.ticketId, provisional: true });
    if (removed?.deletedCount) return null;
    // Not removed: a verified twin already made it visible (it stands), or it is gone (recoverable by retry).
    const current = await Ticket.findOne({ ticketId: ticket.ticketId }).lean();
    if (!current || current.provisional) throw ERRORS.unavailable();
  }
  const { doc } = await insertMessage(Message, { ...fields, ticketId: ticket.ticketId });
  const now = new Date();
  const persisted = await Message.countDocuments({ ticketId: ticket.ticketId });
  const activated = await Ticket.findOneAndUpdate(
    { ticketId: ticket.ticketId, provisional: true },
    { $set: { provisional: false, lastMessageAt: now, lastMessageId: String(doc._id), updatedAt: now, unreadForAdmin: 1, messageCount: persisted } },
    { new: true },
  ).lean();
  if (activated) return { ticket: publicTicket(activated, "customer"), message: doc, duplicate: false, created: true };
  const current = await Ticket.findOne({ ticketId: ticket.ticketId }).lean();
  if (!current || current.provisional) throw ERRORS.unavailable();
  return { ticket: publicTicket(current, "customer"), message: doc, duplicate: true, created: false };
}

/** What a retry of an already-handled create event resolves to; ownership is always enforced. */
async function resumeCreate({ Ticket, Message }, ticket, owner, fields) {
  if (ticket.userTelegramId !== owner) throw ERRORS.notFound();
  if (ticket.provisional) {
    const result = await completeCreate({ Ticket, Message }, ticket, fields);
    if (!result) throw ERRORS.tooManyOpen();
    return result;
  }
  const message = await Message.findOne({ dedupeKey: fields.dedupeKey }).lean();
  if (!message) throw ERRORS.unavailable();
  return { ticket: publicTicket(ticket, "customer"), message, duplicate: true, created: false };
}

/**
 * Removes or finishes this user's abandoned provisional tickets (a create that
 * crashed between its two writes), so they can never hold the open-ticket cap.
 * A ticket whose message landed is made visible only if the cap still allows
 * it; otherwise it is withdrawn like any over-cap creation (its create was
 * never acknowledged, and a retry clears the leftover message).
 */
async function recoverAbandoned({ Ticket, Message }, owner) {
  const cutoff = new Date(Date.now() - PROVISIONAL_GRACE_MS);
  const stale = await Ticket.find({ userTelegramId: owner, provisional: true, createdAt: { $lt: cutoff } }).limit(MAX_OPEN_TICKETS_PER_USER + 5).lean();
  for (const ticket of stale) {
    const message = await Message.findOne({ ticketId: ticket.ticketId }).lean();
    if (!message || (await countOpenTickets(Ticket, owner)) > MAX_OPEN_TICKETS_PER_USER) {
      await Ticket.deleteOne({ ticketId: ticket.ticketId, provisional: true });
      continue;
    }
    const persisted = await Message.countDocuments({ ticketId: ticket.ticketId });
    await Ticket.updateOne(
      { ticketId: ticket.ticketId, provisional: true },
      { $set: { provisional: false, unreadForAdmin: 1, messageCount: persisted, lastMessageAt: message.createdAt || new Date(), lastMessageId: String(message._id) } },
    );
  }
}

/**
 * Creates a ticket and its first message so that one inbound event yields
 * exactly one visible ticket with exactly one message, however it is retried,
 * duplicated or interrupted:
 *
 *   1. The ticket is inserted `provisional` with `createKey` = the event's
 *      dedupeKey (unique). Twins collide here and converge on the winner's
 *      ticket; nobody ever deletes a "losing" ticket.
 *   2. The per-user cap is enforced insert-then-verify inside completeCreate
 *      (see the proof there): the user's non-closed tickets, hidden ones
 *      included, are counted after the insert and a ticket over the cap is
 *      withdrawn. The creator then retries after a random pause (a few rounds);
 *      racers that collide may all back off together for a round, and a creator
 *      that never gets a slot is refused with "too many open tickets".
 *      Abandoned provisional tickets are cleared first.
 *   3. The first message is stored (unique dedupeKey), then the ticket is made
 *      visible with its counters in a single conditional update.
 *
 * A crash after 1 leaves a hidden ticket: a retry of the same event finishes
 * it, otherwise it is removed (or activated, if its message did land) once it
 * is older than PROVISIONAL_GRACE_MS. A failed message insert removes the
 * hidden ticket immediately when no message exists for it.
 */
export async function createTicket({ userId, subject, text, attachment = null, dedupeKey, channel = "telegram" }, deps = {}) {
  const { Ticket, Message } = models(deps);
  const owner = normalizeUserId(userId);
  const body = normalizeText(text);
  const file = normalizeAttachment(attachment);
  if (!body && !file) throw ERRORS.emptyMessage();
  requireDedupeKey(dedupeKey);
  const fields = { author: "customer", text: body, attachment: file, dedupeKey };

  // Replay of the same inbound event resolves to the ticket it already created.
  const byKey = await Ticket.findOne({ createKey: dedupeKey }).lean();
  if (byKey) return resumeCreate({ Ticket, Message }, byKey, owner, fields);
  const replay = await Message.findOne({ dedupeKey }).lean();
  if (replay) {
    const ticket = await Ticket.findOne({ ticketId: replay.ticketId }).lean();
    if (ticket) {
      // A twin that reached the message before the ticket became visible finishes the create like any retry.
      if (ticket.provisional) return resumeCreate({ Ticket, Message }, ticket, owner, fields);
      if (ticket.userTelegramId !== owner) throw ERRORS.notFound();
      return { ticket: publicTicket(ticket, "customer"), message: replay, duplicate: true, created: false };
    }
    // A message whose ticket is gone is unreachable; clear it so the event can be retried.
    await Message.deleteOne({ _id: replay._id });
  }

  const cleanSubject = (typeof subject === "string" ? subject.replace(CONTROL_CHARS, " ").trim() : "").slice(0, MAX_SUBJECT_LENGTH) || deriveSubject(body);

  // A round that loses a cap race removes its own ticket and retries after a random pause, so
  // simultaneous creators drain one by one instead of all being refused together.
  for (let round = 0; round < CAP_RACE_ROUNDS; round += 1) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * 25 * round));
    await recoverAbandoned({ Ticket, Message }, owner);
    if ((await countOpenTickets(Ticket, owner)) >= MAX_OPEN_TICKETS_PER_USER) {
      // A twin of this very event may be the ticket that filled the cap.
      const twin = await Ticket.findOne({ createKey: dedupeKey }).lean();
      if (twin) return resumeCreate({ Ticket, Message }, twin, owner, fields);
      throw ERRORS.tooManyOpen();
    }

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
          provisional: true,
          createKey: dedupeKey,
          lastMessageAt: now,
          lastMessageBy: "customer",
          unreadForAdmin: 0,
          messageCount: 0,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // Either the same event won the race (converge on its ticket) or the random id collided (retry).
        const twin = await Ticket.findOne({ createKey: dedupeKey }).lean();
        if (twin) return resumeCreate({ Ticket, Message }, twin, owner, fields);
      }
    }
    if (!ticket) throw ERRORS.unavailable();

    try {
      const result = await completeCreate({ Ticket, Message }, ticket, fields);
      if (!result) continue; // lost a cap race; the ticket was withdrawn
      return result;
    } catch (error) {
      // Nothing stored for this ticket: do not leave a hidden ticket holding the cap until the grace period ends.
      try {
        if (!(await Message.findOne({ ticketId: ticket.ticketId }).lean())) await Ticket.deleteOne({ ticketId: ticket.ticketId, provisional: true });
      } catch { /* recoverAbandoned removes it later */ }
      throw error;
    }
  }
  throw ERRORS.tooManyOpen();
}

/**
 * Accepts one message on an existing ticket, in three steps whose order is the
 * guarantee (MongoDB offers no atomic write across the two collections, and
 * the deployment is not assumed to support transactions):
 *
 *   1. RESERVE   a conditional update of the ticket (`status ∉ closed`) that
 *                only touches `updatedAt`. This is the single linearization
 *                point against a concurrent close: it either wins (the message
 *                is accepted, ordered before any later close) or matches
 *                nothing (rejected, nothing written). It changes no status or
 *                activity field, so a failure before the row exists leaves the
 *                ticket exactly as it was.
 *   2. INSERT    the message under its unique dedupeKey. A message therefore
 *                exists only if a reservation succeeded; nothing is ever
 *                deleted, so a retry can never be told "accepted" about a row
 *                that later disappears.
 *   3. APPLY     status / lastMessage fields, skipped if a close landed since.
 *   4. SETTLE    messageCount := max(messageCount, persisted messages) and the
 *                recipient's unread counter. The count is derived from what is
 *                stored, so it is idempotent: a retry or any later message
 *                repairs a count left short by a crash after 2.
 *
 * Residual window (crash after 2): the row is stored but the caller saw an
 * error. A retry of the same dedupeKey re-applies step 3 while that message is
 * still the newest one, so status/lastMessage are repaired too.
 */
async function acceptMessage({ Ticket, Message }, { ticketId, filter, reserve, fields, unreadField, audience }) {
  const settle = async (bumpUnread) => {
    const persisted = await Message.countDocuments({ ticketId });
    const update = { $max: { messageCount: persisted } };
    if (bumpUnread) update.$inc = { [unreadField]: 1 };
    return Ticket.findOneAndUpdate({ ticketId }, update, { new: true }).lean();
  };
  const replayed = async (message) => ({ ticket: publicTicket(await settle(false), audience), message, duplicate: true });
  const apply = (at, messageId) => Ticket.updateOne({ ...filter, status: NOT_CLOSED }, { $set: { ...reserve, lastMessageAt: at, lastMessageId: String(messageId), updatedAt: at } });

  // A retry of a message that was already accepted is a success, even if the ticket has been closed since.
  const existing = await Message.findOne({ dedupeKey: fields.dedupeKey }).lean();
  if (existing) {
    if (existing.ticketId !== ticketId || existing.author !== fields.author) throw ERRORS.notFound();
    // Repairs a crash between the insert and the status update, but only while this is still the newest message.
    const [latest] = await Message.find({ ticketId }).sort({ _id: -1 }).limit(1).lean();
    if (latest && String(latest._id) === String(existing._id)) await apply(existing.createdAt || new Date(), existing._id);
    return replayed(existing);
  }

  const now = new Date();
  const reserved = await Ticket.findOneAndUpdate(
    { ...filter, status: NOT_CLOSED },
    { $set: { updatedAt: now } },
    { new: true },
  ).lean();
  if (!reserved) {
    // Closed. A concurrent twin of this very request may have been accepted just before the close: that is still a success.
    const twin = await findReplay(Message, { dedupeKey: fields.dedupeKey, ticketId, author: fields.author });
    if (twin) return replayed(twin);
    throw ERRORS.closed();
  }

  const { doc, duplicate } = await insertMessage(Message, { ...fields, createdAt: now });
  if (!duplicate) await apply(now, doc._id);
  const ticket = await settle(!duplicate);
  return { ticket: publicTicket(ticket, audience), message: doc, duplicate, customerId: ticket.userTelegramId };
}

export async function addCustomerMessage({ ticketId, userId, text, attachment = null, dedupeKey }, deps = {}) {
  const { Ticket, Message } = models(deps);
  const owner = normalizeUserId(userId);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const body = normalizeText(text);
  const file = normalizeAttachment(attachment);
  if (!body && !file) throw ERRORS.emptyMessage();
  requireDedupeKey(dedupeKey);

  const filter = { ticketId, userTelegramId: owner, ...VISIBLE };
  if (!(await Ticket.findOne(filter).lean())) throw ERRORS.notFound();
  const { customerId, ...result } = await acceptMessage({ Ticket, Message }, {
    ticketId,
    filter,
    reserve: { status: "open", lastMessageBy: "customer" },
    fields: { ticketId, author: "customer", text: body, attachment: file, dedupeKey },
    unreadField: "unreadForAdmin",
    audience: "customer",
  });
  return result;
}

export async function addAdminReply({ ticketId, adminId, text, attachment = null, dedupeKey }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const body = normalizeText(text);
  const file = normalizeAttachment(attachment);
  if (!body && !file) throw ERRORS.emptyMessage();
  requireDedupeKey(dedupeKey);

  if (!(await Ticket.findOne({ ticketId, ...VISIBLE }).lean())) throw ERRORS.notFound();
  return acceptMessage({ Ticket, Message }, {
    ticketId,
    filter: { ticketId, ...VISIBLE },
    reserve: { status: "pending_customer", lastMessageBy: "admin", unreadForAdmin: 0 },
    fields: { ticketId, author: "admin", authorAdminId: String(adminId), text: body, attachment: file, dedupeKey },
    unreadField: "unreadForCustomer",
    audience: "admin",
  });
}

/**
 * Status change.
 *
 * - Admins follow ADMIN_TRANSITIONS: open ⇄ pending_customer, and either → closed.
 * - Customers may only close their own ticket.
 * - Nobody can leave `closed`.
 * - Asking for the status the ticket already has is a successful no-op, so a
 *   repeated or retried close never errors and never rewrites the audit fields.
 */
export async function changeStatus({ ticketId, status, actor }, deps = {}) {
  const { Ticket } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  if (!TICKET_STATUSES.includes(status)) throw ERRORS.badStatus();
  const isCustomer = actor?.role === "customer";
  const audience = isCustomer ? "customer" : "admin";
  const filter = isCustomer ? { ticketId, userTelegramId: normalizeUserId(actor.id), ...VISIBLE } : { ticketId, ...VISIBLE };

  // Compare-and-set on the status we validated against: two concurrent
  // transitions cannot both succeed from the same starting state. A lost race
  // is re-evaluated against the new state (a customer message flipping
  // pending_customer → open must not stop an admin from closing).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ticket = await Ticket.findOne(filter).lean();
    if (!ticket) throw ERRORS.notFound();
    const current = normalizeTicketStatus(ticket.status);
    if (current === status) return { ticket: publicTicket(ticket, audience), changed: false, customerId: ticket.userTelegramId };

    if (current === "closed") throw ERRORS.reopenForbidden();
    if (isCustomer ? status !== "closed" : !ADMIN_TRANSITIONS[current]?.includes(status)) throw ERRORS.badTransition();

    const now = new Date();
    const set = { status, updatedAt: now };
    if (status === "closed") {
      set.closedAt = now;
      set.closedBy = audience;
      set.closedByAdminId = isCustomer ? null : String(actor?.id ?? "");
      if (!isCustomer) set.unreadForAdmin = 0;
    }
    const updated = await Ticket.findOneAndUpdate({ ...filter, status: ticket.status }, { $set: set }, { new: true }).lean();
    if (updated) return { ticket: publicTicket(updated, audience), changed: true, previous: current, customerId: updated.userTelegramId };
  }
  throw ERRORS.badTransition();
}

/**
 * One page of a conversation in insertion order (_id). Insertion order is the
 * only order every reader and the live cursor agree on, even when timestamps
 * tie.
 *
 *   afterId  → the next `limit` messages after that id (live catch-up).
 *   beforeId → the `limit` messages immediately older than that id (history).
 *   neither  → the NEWEST `limit` messages.
 *
 * Rows always come back oldest-first. `hasMore` means newer rows exist beyond
 * an `afterId` page; `hasOlder` means older rows exist before the first row.
 */
async function loadMessages(Message, ticketId, { afterId = null, beforeId = null, limit = CUSTOMER_PAGE_SIZE } = {}) {
  if (afterId) {
    const rows = await Message.find({ ticketId, _id: { $gt: afterId } }).sort({ _id: 1 }).limit(limit + 1).lean();
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit, hasOlder: false };
  }
  const filter = beforeId ? { ticketId, _id: { $lt: beforeId } } : { ticketId };
  const rows = await Message.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasOlder = rows.length > limit;
  return { rows: rows.slice(0, limit).reverse(), hasMore: false, hasOlder };
}

function clampLimit(value, fallback, max) {
  return Math.min(Math.max(Number(value) || fallback, 1), max);
}

function validCursor(value) {
  return typeof value === "string" && OBJECT_ID_PATTERN.test(value) ? value : null;
}

function messagePage(rows, audience, extra = {}) {
  return {
    messages: rows.map((row) => publicMessage(row, audience)),
    cursor: rows.length ? String(rows[rows.length - 1]._id) : null,
    oldestCursor: rows.length ? String(rows[0]._id) : null,
    ...extra,
  };
}

export async function listCustomerTickets({ userId, limit = 20 }, deps = {}) {
  const { Ticket } = models(deps);
  const owner = normalizeUserId(userId);
  const size = clampLimit(limit, 20, 50);
  const rows = await Ticket.find({ userTelegramId: owner, ...VISIBLE }).sort({ lastMessageAt: -1 }).limit(size).lean();
  return rows.map((row) => publicTicket(row, "customer"));
}

/** Returns a ticket with its newest messages if, and only if, it belongs to the user. */
export async function getCustomerTicket({ userId, ticketId, markRead = true, limit = CUSTOMER_PAGE_SIZE }, deps = {}) {
  const { Ticket, Message } = models(deps);
  const owner = normalizeUserId(userId);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  let ticket = await Ticket.findOne({ ticketId, userTelegramId: owner, ...VISIBLE }).lean();
  if (!ticket) throw ERRORS.notFound();
  const { rows, hasOlder } = await loadMessages(Message, ticketId, { limit: clampLimit(limit, CUSTOMER_PAGE_SIZE, CUSTOMER_PAGE_SIZE) });
  ticket = await repairStaleActivity({ Ticket, Message }, ticket, rows);
  if (markRead && ticket.unreadForCustomer) {
    await Ticket.updateOne({ ticketId, userTelegramId: owner }, { $set: { unreadForCustomer: 0 } });
    ticket.unreadForCustomer = 0;
  }
  return { ticket: publicTicket(ticket, "customer"), ...messagePage(rows, "customer", { hasOlder }) };
}

/**
 * Repairs a ticket whose newest message was stored but whose status / activity
 * fields were never updated (a crash between the insert and the update in
 * acceptMessage). Reads already load the newest messages, so the check is free.
 *
 * Every applied update records `lastMessageId`; the ticket is stale exactly
 * when its newest stored message is a different one. Safe against old state
 * overwriting new: the write is compare-and-set on that exact `lastMessageId`
 * (any message applied meanwhile moves it and the repair simply does not
 * match), it derives everything from the newest stored message, and closed
 * tickets are never touched. A manual status change does not move
 * `lastMessageId`, so it is never undone. Tickets that predate the field have
 * none and are left alone. Unread uses $max, not $inc, so the in-flight owner
 * of that message finishing normally cannot double-count.
 */
async function repairStaleActivity({ Ticket, Message }, ticket, rows) {
  const newest = rows[rows.length - 1];
  if (!newest || !ticket.lastMessageId || isClosed(ticket.status) || String(newest._id) === ticket.lastMessageId) return ticket;
  const fromAdmin = newest.author === "admin";
  const persisted = await Message.countDocuments({ ticketId: ticket.ticketId });
  const set = {
    lastMessageAt: newest.createdAt || new Date(),
    lastMessageBy: newest.author,
    lastMessageId: String(newest._id),
    status: fromAdmin ? "pending_customer" : "open",
    updatedAt: new Date(),
  };
  if (fromAdmin) set.unreadForAdmin = 0;
  const repaired = await Ticket.findOneAndUpdate(
    { ticketId: ticket.ticketId, lastMessageId: ticket.lastMessageId, status: NOT_CLOSED },
    { $set: set, $max: { messageCount: persisted, [fromAdmin ? "unreadForCustomer" : "unreadForAdmin"]: 1 } },
    { new: true },
  ).lean();
  return repaired || ticket;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Adds each customer's name and username to one page of the admin list, in a
 * single query on the unique telegramId index. Identity is optional: a failed
 * lookup leaves `customer` null, so it can never hide a ticket from the inbox.
 */
async function withCustomers(tickets, UserModel) {
  const ids = [...new Set(tickets.map((ticket) => ticket.userTelegramId).filter(Boolean))];
  let users = [];
  try {
    if (ids.length) users = await UserModel.find({ telegramId: { $in: ids } }, "telegramId firstName lastName username").lean();
  } catch (error) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), service: "support", level: "warn", message: "Ticket customer lookup failed", code: typeof error?.code === "string" ? error.code : error?.name }));
  }
  const byId = new Map(users.map((user) => [String(user.telegramId), user]));
  return tickets.map((ticket) => {
    const user = byId.get(ticket.userTelegramId);
    const customer = user
      ? { name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null, username: user.username || null }
      : null;
    return { ...ticket, customer };
  });
}

export async function listAdminTickets({ status, query, unreadOnly = false, page = 1, pageSize = 20 } = {}, deps = {}) {
  const { Ticket, User: UserModel } = models(deps);
  const filter = { ...VISIBLE };
  if (status) {
    if (!TICKET_STATUSES.includes(status)) throw ERRORS.badStatus();
    filter.status = { $in: STATUS_QUERY_VALUES[status] };
  }
  if (unreadOnly) filter.unreadForAdmin = { $gt: 0 };
  const q = typeof query === "string" ? query.trim().slice(0, 40) : "";
  if (q) {
    if (/^\d{1,20}$/.test(q)) filter.userTelegramId = q;
    else if (isValidTicketId(q.toUpperCase())) filter.ticketId = q.toUpperCase();
    else filter.subject = { $regex: escapeRegex(q), $options: "i" };
  }
  const size = clampLimit(pageSize, 20, 50);
  const current = Math.max(Number(page) || 1, 1);
  const [rows, total, needsAttention, unreadTotal] = await Promise.all([
    Ticket.find(filter).sort({ lastMessageAt: -1, _id: -1 }).skip((current - 1) * size).limit(size).lean(),
    Ticket.countDocuments(filter),
    Ticket.countDocuments({ ...VISIBLE, status: "open", unreadForAdmin: { $gt: 0 } }),
    Ticket.countDocuments({ ...VISIBLE, unreadForAdmin: { $gt: 0 } }),
  ]);
  const tickets = await withCustomers(rows.map((row) => publicTicket(row, "admin")), UserModel);
  return { tickets, total, page: current, pageSize: size, needsAttention, unreadTotal };
}

export async function getAdminTicket({ ticketId, markRead = true, limit = ADMIN_PAGE_SIZE }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  let ticket = await Ticket.findOne({ ticketId, ...VISIBLE }).lean();
  if (!ticket) throw ERRORS.notFound();
  const { rows, hasOlder } = await loadMessages(Message, ticketId, { limit: clampLimit(limit, ADMIN_PAGE_SIZE, 100) });
  ticket = await repairStaleActivity({ Ticket, Message }, ticket, rows);
  if (markRead && ticket.unreadForAdmin) {
    await Ticket.updateOne({ ticketId }, { $set: { unreadForAdmin: 0 } });
    ticket.unreadForAdmin = 0;
  }
  return { ticket: publicTicket(ticket, "admin"), ...messagePage(rows, "admin", { hasOlder }) };
}

/**
 * Older history for "load earlier messages". `beforeId` is the oldest id the
 * client already holds; the page that comes back ends right before it, so
 * repeated or overlapping requests can never duplicate or skip a message.
 */
export async function listTicketMessages({ audience, userId = null, ticketId, beforeId, limit = ADMIN_PAGE_SIZE }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const customer = audience === "customer";
  const filter = customer ? { ticketId, userTelegramId: normalizeUserId(userId), ...VISIBLE } : { ticketId, ...VISIBLE };
  const ticket = await Ticket.findOne(filter).lean();
  if (!ticket) throw ERRORS.notFound();
  const cursor = validCursor(beforeId);
  if (!cursor) throw new SupportError("شناسه پیام نامعتبر است.", { status: 400, code: "invalid_cursor", adminMessage: "Invalid message cursor." });
  const { rows, hasOlder } = await loadMessages(Message, ticketId, { beforeId: cursor, limit: clampLimit(limit, ADMIN_PAGE_SIZE, 100) });
  return messagePage(rows, customer ? "customer" : "admin", { hasOlder });
}

/**
 * Incremental read for live views (polled by the web panel and customer area).
 *
 * - Ownership: a customer only ever reaches their own ticket; anything else is
 *   the same "not found" as a missing ticket.
 * - `afterId` is the id of the last message the client already has. Replaying
 *   the same cursor returns the same rows, so a repeated or retried poll can
 *   never duplicate or skip messages.
 * - Read state is only written when something is actually unread AND the
 *   caller says the ticket is on screen. The write is compare-and-set on
 *   messageCount, so a message that arrives mid-poll stays unread.
 */
export async function getTicketUpdates({ audience, userId = null, ticketId, afterId = null, markRead = false, limit = 100 }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!isValidTicketId(ticketId)) throw ERRORS.notFound();
  const customer = audience === "customer";
  const filter = customer ? { ticketId, userTelegramId: normalizeUserId(userId), ...VISIBLE } : { ticketId, ...VISIBLE };
  const ticket = await Ticket.findOne(filter).lean();
  if (!ticket) throw ERRORS.notFound();

  const cursor = validCursor(afterId);
  const { rows, hasMore } = await loadMessages(Message, ticketId, { afterId: cursor, limit: clampLimit(limit, 100, 200) });

  const unreadField = customer ? "unreadForCustomer" : "unreadForAdmin";
  if (markRead && ticket[unreadField] && !hasMore) {
    const cleared = await Ticket.updateOne({ ...filter, messageCount: ticket.messageCount }, { $set: { [unreadField]: 0 } });
    if (cleared?.matchedCount !== 0 && cleared?.modifiedCount !== 0) ticket[unreadField] = 0;
  }
  return {
    ticket: publicTicket(ticket, customer ? "customer" : "admin"),
    messages: rows.map((row) => publicMessage(row, customer ? "customer" : "admin")),
    cursor: rows.length ? String(rows[rows.length - 1]._id) : cursor,
    hasMore,
    serverTime: new Date().toISOString(),
  };
}

/** Attachment reference for a download. Pass `ownerId` for customers: other users' messages resolve to not-found. */
export async function getMessageAttachment({ messageId, ownerId = null }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!OBJECT_ID_PATTERN.test(String(messageId))) throw ERRORS.notFound();
  const message = await Message.findOne({ _id: messageId }).lean();
  if (!message?.attachment) throw ERRORS.notFound();
  if (ownerId !== null) {
    const ticket = await Ticket.findOne({ ticketId: message.ticketId, userTelegramId: normalizeUserId(ownerId), ...VISIBLE }).lean();
    if (!ticket) throw ERRORS.notFound();
  }
  return message.attachment;
}

export async function recordDelivery({ dedupeKey, delivery }, deps = {}) {
  const { Message } = models(deps);
  if (!["sent", "failed", "pending"].includes(delivery)) return;
  await Message.updateOne({ dedupeKey }, { $set: { delivery } });
}

/**
 * Maps a Telegram message in the admin group back to the ticket it was copied
 * from. Copies are no longer posted, but old ones exist in the group history;
 * the lookup lets the deprecated reply handler recognise them and point the
 * admin at the panel instead of silently ignoring the reply.
 */
export async function findTicketByGroupMessage({ groupMessageId }, deps = {}) {
  const { Ticket, Message } = models(deps);
  if (!Number.isInteger(groupMessageId)) return null;
  const message = await Message.findOne({ groupMessageIds: groupMessageId }).lean();
  if (!message) return null;
  return Ticket.findOne({ ticketId: message.ticketId }).lean();
}

/**
 * Rewrites tickets stored with the pre-simplification statuses. Idempotent and
 * safe to run on every start: it only touches rows that still carry a legacy
 * value, and readers/writers already treat those values as their canonical
 * equivalents until it has run.
 */
export async function migrateLegacyTicketStatuses(deps = {}) {
  const { Ticket } = models(deps);
  const pending = await Ticket.updateMany({ status: "pending" }, { $set: { status: "pending_customer" } });
  const resolved = await Ticket.updateMany(
    { status: "resolved" },
    [{ $set: { status: "closed", closedAt: { $ifNull: ["$closedAt", "$updatedAt"] }, closedBy: { $ifNull: ["$closedBy", "admin"] } } }],
  );
  return { pending: pending?.modifiedCount ?? 0, resolved: resolved?.modifiedCount ?? 0 };
}
