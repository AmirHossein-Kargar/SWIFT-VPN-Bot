/**
 * Support ticket service: ownership, lifecycle, idempotency, attachment
 * validation and admin listing — against in-memory models that emulate unique
 * indexes, so duplicate-delivery behavior is really exercised.
 */
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeSupportDeps } from "../helpers/fakeSupport.js";

const tickets = await import("../../services/support/tickets.js");

let deps;
beforeEach(() => { deps = makeSupportDeps(); });

const open = (userId = "1001", extra = {}) =>
  tickets.createTicket({ userId, text: "سلام، سرویس من وصل نمی‌شود", dedupeKey: `k-${Math.random()}`, ...extra }, deps);

describe("createTicket", () => {
  test("creates an open ticket with a T-XXXXXX id and the first message", async () => {
    const { ticket, created } = await open();
    assert.ok(created);
    assert.match(ticket.ticketId, /^T-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.unread, 0, "customer view: nothing unread for the author");
    const detail = await tickets.getAdminTicket({ ticketId: ticket.ticketId, markRead: false }, deps);
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.ticket.unread, 1, "support sees one unread message");
  });

  test("a replayed event (same dedupeKey) does not create a second ticket or message", async () => {
    const input = { userId: "1001", text: "سلام", dedupeKey: "tg:1001:55" };
    const first = await tickets.createTicket(input, deps);
    const second = await tickets.createTicket(input, deps);
    assert.equal(second.duplicate, true);
    assert.equal(second.ticket.ticketId, first.ticket.ticketId);
    assert.equal(deps.Ticket.docs.length, 1);
    assert.equal(deps.Message.docs.length, 1);
  });

  test("a dedupeKey owned by another user is not replayed to a stranger", async () => {
    await tickets.createTicket({ userId: "1001", text: "x", dedupeKey: "shared-key" }, deps);
    await assert.rejects(tickets.createTicket({ userId: "2002", text: "y", dedupeKey: "shared-key" }, deps), { code: "ticket_not_found" });
  });

  test("rejects empty content, control characters and over-long text", async () => {
    for (const text of ["", "   ", "bad\u0000text"]) {
      await assert.rejects(tickets.createTicket({ userId: "1", text, dedupeKey: "d" + text.length }, deps), { code: "invalid_message" });
    }
    await assert.rejects(tickets.createTicket({ userId: "1", text: "x".repeat(tickets.MAX_MESSAGE_LENGTH + 1), dedupeKey: "long" }, deps), { code: "message_too_long" });
  });

  test("caps how many open tickets one user can hold; closed ones do not count", async () => {
    for (let i = 0; i < tickets.MAX_OPEN_TICKETS_PER_USER; i += 1) await open("1001");
    await assert.rejects(open("1001"), { code: "too_many_open_tickets" });
    await open("2002");
    const [first] = await tickets.listCustomerTickets({ userId: "1001" }, deps);
    await tickets.changeStatus({ ticketId: first.ticketId, status: "closed", actor: { role: "customer", id: "1001" } }, deps);
    await open("1001");
  });

  test("attachments must be a photo/video with a file id", async () => {
    await assert.rejects(open("1", { attachment: { kind: "document", fileId: "abc" } }), { code: "invalid_message" });
    await assert.rejects(open("1", { attachment: { kind: "photo", fileId: "" } }), { code: "invalid_message" });
    const { message } = await tickets.createTicket({ userId: "1", text: "", attachment: { kind: "video", fileId: "F1", fileSize: 10 }, dedupeKey: "vid" }, deps);
    assert.equal(message.attachment.kind, "video");
  });
});

describe("ownership and isolation", () => {
  test("a customer can read only their own tickets", async () => {
    const mine = (await open("1001")).ticket;
    const theirs = (await open("2002")).ticket;
    assert.deepEqual((await tickets.listCustomerTickets({ userId: "1001" }, deps)).map((t) => t.ticketId), [mine.ticketId]);
    await assert.rejects(tickets.getCustomerTicket({ userId: "1001", ticketId: theirs.ticketId }, deps), { code: "ticket_not_found" });
  });

  test("a customer cannot post to, close or reopen another user's ticket", async () => {
    const theirs = (await open("2002")).ticket;
    await assert.rejects(tickets.addCustomerMessage({ ticketId: theirs.ticketId, userId: "1001", text: "hi", dedupeKey: "x1" }, deps), { code: "ticket_not_found" });
    await assert.rejects(tickets.changeStatus({ ticketId: theirs.ticketId, status: "closed", actor: { role: "customer", id: "1001" } }, deps), { code: "ticket_not_found" });
    assert.equal(deps.Message.docs.length, 1);
  });

  test("customer views never carry another user's id or admin-only fields", async () => {
    const { ticket } = await open("1001");
    const view = (await tickets.getCustomerTicket({ userId: "1001", ticketId: ticket.ticketId }, deps)).ticket;
    assert.equal("userTelegramId" in view, false);
    assert.equal("closedBy" in view, false);
  });

  test("attachment lookup is owner-scoped for customers", async () => {
    const { message } = await tickets.createTicket({ userId: "1001", text: "", attachment: { kind: "photo", fileId: "FILE" }, dedupeKey: "p1" }, deps);
    const id = message._id;
    assert.equal((await tickets.getMessageAttachment({ messageId: id, ownerId: "1001" }, deps)).fileId, "FILE");
    await assert.rejects(tickets.getMessageAttachment({ messageId: id, ownerId: "2002" }, deps), { code: "ticket_not_found" });
    await assert.rejects(tickets.getMessageAttachment({ messageId: "not-an-id", ownerId: "1001" }, deps), { code: "ticket_not_found" });
  });

  test("malformed ticket ids and user ids are treated as not found", async () => {
    await assert.rejects(tickets.getCustomerTicket({ userId: "1001", ticketId: "T-../etc" }, deps), { code: "ticket_not_found" });
    await assert.rejects(tickets.listCustomerTickets({ userId: "abc" }, deps), { code: "ticket_not_found" });
  });
});

describe("conversation and lifecycle", () => {
  test("messages are returned in chronological order with correct authors", async () => {
    const { ticket } = await open("1001");
    await tickets.addAdminReply({ ticketId: ticket.ticketId, adminId: "9", text: "در حال بررسی", dedupeKey: "a1" }, deps);
    await tickets.addCustomerMessage({ ticketId: ticket.ticketId, userId: "1001", text: "ممنون", dedupeKey: "c2" }, deps);
    const { messages } = await tickets.getCustomerTicket({ userId: "1001", ticketId: ticket.ticketId }, deps);
    assert.deepEqual(messages.map((m) => m.author), ["customer", "admin", "customer"]);
  });

  test("admin reply marks the ticket pending and unread for the customer; reading clears it", async () => {
    const { ticket } = await open("1001");
    const reply = await tickets.addAdminReply({ ticketId: ticket.ticketId, adminId: "9", text: "سلام", dedupeKey: "a1" }, deps);
    assert.equal(reply.ticket.status, "pending_customer");
    assert.equal(reply.customerId, "1001");
    const [listed] = await tickets.listCustomerTickets({ userId: "1001" }, deps);
    assert.equal(listed.unread, 1);
    await tickets.getCustomerTicket({ userId: "1001", ticketId: ticket.ticketId }, deps);
    assert.equal((await tickets.listCustomerTickets({ userId: "1001" }, deps))[0].unread, 0);
  });

  test("a customer reply moves a pending_customer ticket back to open", async () => {
    const { ticket } = await open("1001");
    await tickets.addAdminReply({ ticketId: ticket.ticketId, adminId: "9", text: "لطفاً توضیح دهید", dedupeKey: "a1" }, deps);
    assert.equal((await tickets.listAdminTickets({}, deps)).tickets[0].status, "pending_customer");
    const after = await tickets.addCustomerMessage({ ticketId: ticket.ticketId, userId: "1001", text: "هنوز مشکل دارم", dedupeKey: "c2" }, deps);
    assert.equal(after.ticket.status, "open");
  });

  test("duplicate admin reply and duplicate customer message are absorbed", async () => {
    const { ticket } = await open("1001");
    const a = await tickets.addAdminReply({ ticketId: ticket.ticketId, adminId: "9", text: "x", dedupeKey: "same" }, deps);
    const b = await tickets.addAdminReply({ ticketId: ticket.ticketId, adminId: "9", text: "x", dedupeKey: "same" }, deps);
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    const c = await tickets.addCustomerMessage({ ticketId: ticket.ticketId, userId: "1001", text: "y", dedupeKey: "cs" }, deps);
    const d = await tickets.addCustomerMessage({ ticketId: ticket.ticketId, userId: "1001", text: "y", dedupeKey: "cs" }, deps);
    assert.equal(c.duplicate, false);
    assert.equal(d.duplicate, true);
    assert.equal(deps.Message.docs.length, 3);
    assert.equal(deps.Ticket.docs[0].messageCount, 3);
  });

  test("closed tickets reject new messages from both sides", async () => {
    const { ticket } = await open("1001");
    await tickets.changeStatus({ ticketId: ticket.ticketId, status: "closed", actor: { role: "customer", id: "1001" } }, deps);
    await assert.rejects(tickets.addCustomerMessage({ ticketId: ticket.ticketId, userId: "1001", text: "x", dedupeKey: "z1" }, deps), { code: "ticket_closed" });
    await assert.rejects(tickets.addAdminReply({ ticketId: ticket.ticketId, adminId: "9", text: "x", dedupeKey: "z2" }, deps), { code: "ticket_closed" });
  });

  test("customers may only close; every other status, and any reopen, is refused", async () => {
    const { ticket } = await open("1001");
    const actor = { role: "customer", id: "1001" };
    await assert.rejects(tickets.changeStatus({ ticketId: ticket.ticketId, status: "pending_customer", actor }, deps), { code: "invalid_transition" });
    await assert.rejects(tickets.changeStatus({ ticketId: ticket.ticketId, status: "resolved", actor }, deps), { code: "invalid_status" });
    const closed = await tickets.changeStatus({ ticketId: ticket.ticketId, status: "closed", actor }, deps);
    assert.equal(closed.ticket.status, "closed");
    await assert.rejects(tickets.changeStatus({ ticketId: ticket.ticketId, status: "open", actor }, deps), { code: "reopen_not_allowed" });
    assert.equal((await tickets.listCustomerTickets({ userId: "1001" }, deps))[0].status, "closed");
  });

  test("admin transitions follow the table and unknown or legacy statuses are refused", async () => {
    const { ticket } = await open("1001");
    const admin = { role: "admin", id: "9" };
    for (const bad of ["bogus", "pending", "resolved"]) {
      await assert.rejects(tickets.changeStatus({ ticketId: ticket.ticketId, status: bad, actor: admin }, deps), { code: "invalid_status" }, bad);
    }
    assert.equal((await tickets.changeStatus({ ticketId: ticket.ticketId, status: "pending_customer", actor: admin }, deps)).ticket.status, "pending_customer");
    assert.equal((await tickets.changeStatus({ ticketId: ticket.ticketId, status: "open", actor: admin }, deps)).ticket.status, "open");
    await tickets.changeStatus({ ticketId: ticket.ticketId, status: "closed", actor: admin }, deps);
    await assert.rejects(tickets.changeStatus({ ticketId: ticket.ticketId, status: "open", actor: admin }, deps), { code: "reopen_not_allowed" });
    await assert.rejects(tickets.changeStatus({ ticketId: ticket.ticketId, status: "pending_customer", actor: admin }, deps), { code: "reopen_not_allowed" });
  });
});

describe("admin listing", () => {
  test("filters by status, searches by ticket id / user id / subject, paginates, and counts attention", async () => {
    const a = (await open("1001", { subject: "مشکل پرداخت" })).ticket;
    await open("2002", { subject: "اتصال قطع" });
    await open("2002", { subject: "راهنمای نصب" });
    await tickets.changeStatus({ ticketId: a.ticketId, status: "pending_customer", actor: { role: "admin" } }, deps);

    assert.equal((await tickets.listAdminTickets({ status: "pending_customer" }, deps)).total, 1);
    assert.equal((await tickets.listAdminTickets({ query: a.ticketId.toLowerCase() }, deps)).total, 1);
    assert.equal((await tickets.listAdminTickets({ query: "2002" }, deps)).total, 2);
    assert.equal((await tickets.listAdminTickets({ query: "اتصال" }, deps)).total, 1);
    assert.equal((await tickets.listAdminTickets({ query: ".*" }, deps)).total, 0, "regex metacharacters are literal");
    const page = await tickets.listAdminTickets({ page: 2, pageSize: 2 }, deps);
    assert.equal(page.tickets.length, 1);
    assert.equal(page.total, 3);
    assert.equal(page.needsAttention, 2);
    await assert.rejects(tickets.listAdminTickets({ status: "nope" }, deps), { code: "invalid_status" });
  });

  test("opening a ticket as admin clears its unread flag", async () => {
    const { ticket } = await open("1001");
    assert.equal((await tickets.listAdminTickets({ unreadOnly: true }, deps)).total, 1);
    await tickets.getAdminTicket({ ticketId: ticket.ticketId }, deps);
    assert.equal((await tickets.listAdminTickets({ unreadOnly: true }, deps)).total, 0);
  });
});
