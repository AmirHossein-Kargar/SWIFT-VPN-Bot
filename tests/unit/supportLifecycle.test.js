/**
 * Ticket lifecycle policy, enforced server-side:
 *   open ⇄ pending_customer → closed (final; nobody reopens, customers open a new ticket).
 * Covers closed-ticket rejection from every entry point, idempotent close,
 * close/message races, legacy-status handling, pagination, attachment limits,
 * English admin errors, and the retired admin-group reply flow. In-memory
 * models only: no database, no Telegram.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSupportDeps, makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";
import { makeAuditModel } from "../helpers/fakeAuditModel.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";
delete process.env.SUPPORT_GROUP_ALERTS;

const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const delivery = await import("../../services/support/delivery.js");
const adminTickets = await import("../../services/admin/tickets.js");
const { handleSupportCallback } = await import("../../handlers/support/supportFlow.js");
const { handleSupportGroupReply } = await import("../../handlers/support/groupReply.js");
const { SUPPORT_COPY } = await import("../../messages/supportCopy.js");
const { setSessionClientForTests, clearSessionClientForTests } = await import("../../config/sessionStore.js");

const ALICE = 1001;
const BOB = 1002;
const ADMIN = "9001";
const PERSIAN = /[؀-ۿ]/;
let deps;
let bot;
let seq = 0;
const key = (prefix) => `${prefix}:${++seq}`;
const OP = () => `op-${String(++seq).padStart(16, "0")}`;

beforeEach(() => {
  deps = makeSupportDeps();
  tickets.setSupportModelsForTests(deps);
  setSessionClientForTests(makeSessionClient());
  bot = makeFakeBot();
  delete process.env.SUPPORT_GROUP_ALERTS;
});
afterEach(() => {
  tickets.clearSupportModelsForTests();
  clearSessionClientForTests();
});

const openTicket = async (userId = ALICE, text = "سرویس من وصل نمی‌شود") =>
  (await workflow.customerOpenTicket({ bot, userId, text, dedupeKey: key("open"), channel: "telegram" })).ticket.ticketId;
const customerSays = (ticketId, text = "پیام", userId = ALICE, dedupeKey = key("tg")) => workflow.customerReply({ userId, ticketId, text, dedupeKey });
const adminSays = (ticketId, text = "پاسخ", dedupeKey = key("web-admin")) => workflow.adminReply({ bot, adminId: ADMIN, ticketId, text, dedupeKey });
const closeAsAdmin = (ticketId) => workflow.adminSetStatus({ bot, ticketId, status: "closed", adminId: ADMIN });
const stored = (ticketId) => deps.Message.docs.filter((m) => m.ticketId === ticketId);
const ticketRow = (ticketId) => deps.Ticket.docs.find((t) => t.ticketId === ticketId);

describe("closing", () => {
  test("a new ticket starts open; an admin reply makes it pending_customer; a customer message makes it open again", async () => {
    const id = await openTicket();
    assert.equal(ticketRow(id).status, "open");
    await adminSays(id);
    assert.equal(ticketRow(id).status, "pending_customer");
    await customerSays(id);
    assert.equal(ticketRow(id).status, "open");
  });

  test("closing records who closed it and when, durably", async () => {
    const id = await openTicket();
    const result = await closeAsAdmin(id);
    assert.equal(result.changed, true);
    const row = ticketRow(id);
    assert.equal(row.status, "closed");
    assert.equal(row.closedBy, "admin");
    assert.equal(row.closedByAdminId, ADMIN);
    assert.ok(row.closedAt instanceof Date);
    assert.equal(row.unreadForAdmin, 0);
    const byCustomer = await openTicket(BOB);
    await workflow.customerSetStatus({ userId: BOB, ticketId: byCustomer, status: "closed" });
    assert.equal(ticketRow(byCustomer).closedBy, "customer");
    assert.equal(ticketRow(byCustomer).closedByAdminId, null);
  });

  test("closing twice is idempotent: success, no second notification, audit fields untouched", async () => {
    const id = await openTicket();
    await closeAsAdmin(id);
    const closedAt = ticketRow(id).closedAt;
    const notices = () => bot.of("sendMessage").filter((c) => c.args[0] === ALICE || String(c.args[0]) === String(ALICE)).length;
    const before = notices();
    const again = await closeAsAdmin(id);
    assert.equal(again.changed, false);
    assert.equal(again.ticket.status, "closed");
    assert.equal(ticketRow(id).closedAt, closedAt);
    assert.equal(notices(), before, "no second closed-notice");
    const byCustomer = await workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "closed" });
    assert.equal(byCustomer.changed, false);
    assert.equal(ticketRow(id).closedBy, "admin", "a later customer close does not rewrite who closed it");
  });

  test("the customer is told once, in Persian, that the ticket was closed - and not about open/pending changes", async () => {
    const id = await openTicket();
    await workflow.adminSetStatus({ bot, ticketId: id, status: "pending_customer", adminId: ADMIN });
    assert.equal(bot.of("sendMessage").length, 0);
    await closeAsAdmin(id);
    const [notice] = bot.of("sendMessage");
    assert.match(notice.args[1], PERSIAN);
    assert.ok(notice.args[1].includes(id));
    const buttons = notice.args[2].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(buttons.includes("sup_new") && !buttons.some((c) => /reopen/.test(c)));
  });
});

describe("a closed ticket stays closed", () => {
  test("neither side can post, from any entry point, and nothing is stored", async () => {
    const id = await openTicket();
    await adminSays(id);
    await closeAsAdmin(id);
    const count = stored(id).length;
    await assert.rejects(customerSays(id), { code: "ticket_closed" });
    await assert.rejects(adminSays(id), { code: "ticket_closed" });
    await assert.rejects(tickets.addCustomerMessage({ ticketId: id, userId: ALICE, text: "x", attachment: { kind: "photo", fileId: "F", fileSize: 5 }, dedupeKey: key("a") }, deps), { code: "ticket_closed" });
    assert.equal(stored(id).length, count);
    assert.equal(ticketRow(id).status, "closed");
    assert.equal(ticketRow(id).messageCount, count);
  });

  test("nobody can reopen it: customer, admin, API, stale callback", async () => {
    const id = await openTicket();
    await closeAsAdmin(id);
    await assert.rejects(workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "open" }), { code: "reopen_not_allowed" });
    for (const status of ["open", "pending_customer"]) {
      await assert.rejects(workflow.adminSetStatus({ bot, ticketId: id, status, adminId: ADMIN }), { code: "reopen_not_allowed" });
    }
    assert.equal(ticketRow(id).status, "closed");
  });

  test("a stale 'reopen' button is answered with the closed notice and changes nothing", async () => {
    const id = await openTicket();
    await closeAsAdmin(id);
    bot.calls.length = 0;
    await handleSupportCallback(bot, {
      id: "q1", from: { id: ALICE }, data: `sup_reopen:${id}`,
      message: { message_id: 7, chat: { id: ALICE, type: "private" } },
    });
    const [answer] = bot.of("answerCallbackQuery");
    assert.equal(answer.args[1].text, SUPPORT_COPY.closed);
    assert.equal(ticketRow(id).status, "closed");
    assert.equal(stored(id).length, 1);
  });

  test("the pre-lifecycle 'resolved' value counts as closed everywhere", async () => {
    const id = await openTicket();
    ticketRow(id).status = "resolved";
    assert.equal((await tickets.getAdminTicket({ ticketId: id, markRead: false }, deps)).ticket.status, "closed");
    await assert.rejects(customerSays(id), { code: "ticket_closed" });
    await assert.rejects(adminSays(id), { code: "ticket_closed" });
    await assert.rejects(workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "open" }), { code: "reopen_not_allowed" });
    assert.equal((await tickets.listAdminTickets({ status: "closed" }, deps)).total, 1);
    assert.equal(await deps.Ticket.countDocuments({ userTelegramId: String(ALICE), status: { $nin: ["closed", "resolved"] } }), 0);
  });

  test("legacy 'pending' reads as pending_customer and the migration rewrites both legacy values once", async () => {
    const a = await openTicket();
    const b = await openTicket();
    ticketRow(a).status = "pending";
    ticketRow(b).status = "resolved";
    ticketRow(b).closedAt = null;
    assert.equal((await tickets.listAdminTickets({ status: "pending_customer" }, deps)).total, 1);
    const first = await tickets.migrateLegacyTicketStatuses(deps);
    assert.deepEqual(first, { pending: 1, resolved: 1 });
    assert.equal(ticketRow(a).status, "pending_customer");
    assert.equal(ticketRow(b).status, "closed");
    assert.ok(ticketRow(b).closedAt, "closedAt is back-filled from the last update");
    assert.deepEqual(await tickets.migrateLegacyTicketStatuses(deps), { pending: 0, resolved: 0 });
  });

  test("a retry of a message accepted before the close is a success, not an error", async () => {
    const id = await openTicket();
    const dedupe = key("tg");
    await customerSays(id, "یک بار", ALICE, dedupe);
    await closeAsAdmin(id);
    const retry = await customerSays(id, "یک بار", ALICE, dedupe);
    assert.equal(retry.duplicate, true);
    assert.equal(stored(id).length, 2);
  });

  test("another customer can neither read, post to nor close the ticket", async () => {
    const id = await openTicket(ALICE);
    await assert.rejects(customerSays(id, "x", BOB), { code: "ticket_not_found" });
    await assert.rejects(workflow.customerSetStatus({ userId: BOB, ticketId: id, status: "closed" }), { code: "ticket_not_found" });
    await assert.rejects(tickets.listTicketMessages({ audience: "customer", userId: BOB, ticketId: id, beforeId: "0".repeat(23) + "f" }, deps), { code: "ticket_not_found" });
    assert.equal(ticketRow(id).status, "open");
  });
});

describe("close vs message races", () => {
  // Runs `action` once, right before the n-th matching call of `model[method]`.
  const beforeCall = (model, method, matcher, action) => {
    const real = model[method].bind(model);
    let fired = false;
    model[method] = (...args) => {
      if (!fired && matcher(...args)) {
        fired = true;
        const run = async () => { await action(); return real(...args); };
        // Query-style calls (`.lean()`) and plain promises both keep working.
        return { lean: async () => { await action(); return real(...args).lean(); }, then: (resolve, reject) => run().then(resolve, reject) };
      }
      return real(...args);
    };
  };
  const failOnce = (model, method, matcher) => {
    const real = model[method].bind(model);
    let fired = false;
    model[method] = (...args) => {
      if (!fired && matcher(...args)) { fired = true; throw Object.assign(new Error("injected failure"), { code: "EINJECTED" }); }
      return real(...args);
    };
  };
  // The reserve is the conditional touch of `updatedAt` alone: it changes no status or activity field.
  const isReserve = (filter, update) => Object.keys(update.$set || {}).join() === "updatedAt" && Boolean(filter.status);
  const isSettle = (filter, update) => Boolean(update.$max);

  test("a close that wins before the message is reserved rejects it and writes nothing", async () => {
    const id = await openTicket();
    const before = ticketRow(id).messageCount;
    beforeCall(deps.Ticket, "findOneAndUpdate", isReserve, () => closeAsAdmin(id));
    const creates = [];
    const realCreate = deps.Message.create.bind(deps.Message);
    deps.Message.create = async (fields) => { creates.push(fields); return realCreate(fields); };
    const key1 = key("tg");
    await assert.rejects(customerSays(id, "late", ALICE, key1), { code: "ticket_closed" });
    assert.equal(creates.length, 0, "no row was ever written, so none had to be deleted");
    assert.equal(stored(id).length, before);
    assert.equal(ticketRow(id).messageCount, before);
    assert.equal(ticketRow(id).status, "closed");
    await assert.rejects(customerSays(id, "late", ALICE, key1), { code: "ticket_closed" }, "a retry of the rejected message stays rejected");
    assert.equal(stored(id).length, before);
  });

  test("an admin reply rejected by a close is neither stored nor notified", async () => {
    const id = await openTicket();
    beforeCall(deps.Ticket, "findOneAndUpdate", isReserve, () => workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "closed" }));
    await assert.rejects(adminSays(id), { code: "ticket_closed" });
    assert.equal(stored(id).length, 1);
    assert.equal(ticketRow(id).messageCount, 1);
    assert.equal(bot.of("sendMessage").length, 0, "no reply notification for a rejected reply");
  });

  test("a close that lands after the reservation cannot turn an accepted message into a rejected or lost one", async () => {
    const id = await openTicket();
    const dedupeKey = key("tg");
    beforeCall(deps.Message, "create", () => true, () => closeAsAdmin(id));
    const result = await customerSays(id, "accepted", ALICE, dedupeKey);
    assert.equal(result.duplicate, false);
    assert.ok(stored(id).some((m) => String(m._id) === String(result.message._id)), "an accepted message is persisted");
    assert.equal(stored(id).length, ticketRow(id).messageCount);
    assert.equal(ticketRow(id).status, "closed");
    const retry = await customerSays(id, "accepted", ALICE, dedupeKey);
    assert.equal(retry.duplicate, true, "the retry is a genuine replay of a stored message");
    assert.equal(stored(id).length, 2);
  });

  test("an admin reply accepted just before a close is persisted, counted and notified once", async () => {
    const id = await openTicket();
    beforeCall(deps.Message, "create", () => true, () => workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "closed" }));
    const result = await adminSays(id);
    assert.equal(result.duplicate, false);
    assert.equal(stored(id).length, ticketRow(id).messageCount);
    assert.equal(bot.of("sendMessage").length, 1);
  });

  test("a failure after the reservation stores nothing, reports nothing, and a retry of the same key completes exactly once", async () => {
    const id = await openTicket();
    const dedupeKey = key("web-admin");
    failOnce(deps.Message, "create", () => true);
    await assert.rejects(adminSays(id, "reply", dedupeKey), { code: "EINJECTED" });
    assert.equal(stored(id).length, 1, "no message row");
    assert.equal(ticketRow(id).messageCount, 1, "counts only reflect stored messages");
    assert.equal(bot.of("sendMessage").length, 0, "nothing delivered for an unsaved reply");
    const retry = await adminSays(id, "reply", dedupeKey);
    assert.equal(retry.duplicate, false);
    assert.equal(stored(id).length, 2);
    assert.equal(ticketRow(id).messageCount, 2);
    assert.equal(bot.of("sendMessage").length, 1);
    assert.equal((await adminSays(id, "reply", dedupeKey)).duplicate, true);
    assert.equal(stored(id).length, 2);
    assert.equal(bot.of("sendMessage").length, 1, "the replay is not delivered again");
  });

  test("a failure after the insert leaves a short count that the retry repairs, without a duplicate row", async () => {
    const id = await openTicket();
    const dedupeKey = key("tg");
    failOnce(deps.Ticket, "findOneAndUpdate", isSettle);
    await assert.rejects(customerSays(id, "hello", ALICE, dedupeKey), { code: "EINJECTED" });
    assert.equal(stored(id).length, 2);
    assert.equal(ticketRow(id).messageCount, 1, "count short until settled");
    const retry = await customerSays(id, "hello", ALICE, dedupeKey);
    assert.equal(retry.duplicate, true);
    assert.equal(stored(id).length, 2);
    assert.equal(ticketRow(id).messageCount, 2, "the retry settled the count from what is stored");
    // Any later message would also have repaired it: the count is derived, never blindly incremented.
    assert.equal(retry.ticket.messageCount, 2);
  });

  test("a key already stored under another ticket or author is refused before anything is changed", async () => {
    const first = await openTicket(ALICE);
    const second = await openTicket(ALICE, "another");
    const dedupeKey = key("tg");
    await customerSays(first, "one", ALICE, dedupeKey);
    const snapshot = JSON.stringify(ticketRow(second));
    await assert.rejects(customerSays(second, "two", ALICE, dedupeKey), { code: "ticket_not_found" });
    assert.equal(JSON.stringify(ticketRow(second)), snapshot);
    assert.equal(stored(second).length, 1);
  });

  test("a customer message flipping the status mid-close does not stop the close", async () => {
    const id = await openTicket();
    await adminSays(id); // pending_customer
    const realUpdate = deps.Ticket.findOneAndUpdate.bind(deps.Ticket);
    let raced = false;
    deps.Ticket.findOneAndUpdate = (filter, update, options) => {
      if (!raced && update.$set?.status === "closed") {
        raced = true;
        ticketRow(id).status = "open"; // the customer wrote just before the compare-and-set
      }
      return realUpdate(filter, update, options);
    };
    const result = await closeAsAdmin(id);
    assert.equal(result.ticket.status, "closed");
    assert.equal(ticketRow(id).status, "closed");
  });

  test("concurrent closes and messages always end consistent: stored messages == messageCount, ticket closed", async () => {
    for (let round = 0; round < 25; round += 1) {
      const id = await openTicket(ALICE, `round ${round}`);
      const results = await Promise.allSettled([
        customerSays(id, "a", ALICE, key("race")),
        adminSays(id, "b"),
        closeAsAdmin(id),
        closeAsAdmin(id),
        workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "closed" }),
        customerSays(id, "c", ALICE, key("race")),
      ]);
      const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason.code);
      assert.ok(failures.every((code) => code === "ticket_closed"), `unexpected failure ${failures}`);
      assert.equal(ticketRow(id).status, "closed");
      for (const r of results.filter((x) => x.status === "fulfilled" && x.value.message)) {
        assert.ok(stored(id).some((m) => String(m._id) === String(r.value.message._id)), "every accepted message is persisted");
      }
      assert.equal(stored(id).length, ticketRow(id).messageCount, "no orphaned or uncounted message");
      const closedAt = ticketRow(id).closedAt;
      await closeAsAdmin(id);
      assert.equal(ticketRow(id).closedAt, closedAt);
    }
  });
});

describe("history pagination", () => {
  async function longTicket(count = 25) {
    const id = await openTicket(ALICE, "m0");
    for (let i = 1; i < count; i += 1) await (i % 2 ? adminSays(id, `m${i}`) : customerSays(id, `m${i}`));
    return id;
  }

  test("the newest page loads first and older pages continue without gaps or overlap", async () => {
    const id = await longTicket(25);
    const first = await tickets.getAdminTicket({ ticketId: id, limit: 10, markRead: false }, deps);
    assert.deepEqual(first.messages.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `m${15 + i}`));
    assert.equal(first.hasOlder, true);
    const second = await tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: first.oldestCursor, limit: 10 }, deps);
    assert.deepEqual(second.messages.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `m${5 + i}`));
    assert.equal(second.hasOlder, true);
    const third = await tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: second.oldestCursor, limit: 10 }, deps);
    assert.deepEqual(third.messages.map((m) => m.text), ["m0", "m1", "m2", "m3", "m4"]);
    assert.equal(third.hasOlder, false);
    const all = [...third.messages, ...second.messages, ...first.messages];
    assert.equal(new Set(all.map((m) => m.id)).size, 25, "stable ids, no duplicates");
    assert.deepEqual(all.map((m) => m.text), Array.from({ length: 25 }, (_, i) => `m${i}`), "deterministic order");
  });

  test("an exactly-full last page does not claim there is more", async () => {
    const id = await longTicket(20);
    const first = await tickets.getAdminTicket({ ticketId: id, limit: 10, markRead: false }, deps);
    const second = await tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: first.oldestCursor, limit: 10 }, deps);
    assert.equal(second.messages.length, 10);
    assert.equal(second.hasOlder, false);
  });

  test("a message arriving while older pages load does not shift them", async () => {
    const id = await longTicket(12);
    const first = await tickets.getAdminTicket({ ticketId: id, limit: 5, markRead: false }, deps);
    await customerSays(id, "late");
    const older = await tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: first.oldestCursor, limit: 5 }, deps);
    assert.deepEqual(older.messages.map((m) => m.text), ["m2", "m3", "m4", "m5", "m6"]);
    const live = await tickets.getTicketUpdates({ audience: "admin", ticketId: id, afterId: first.cursor }, deps);
    assert.deepEqual(live.messages.map((m) => m.text), ["late"]);
  });

  test("malformed cursors are rejected, not interpreted", async () => {
    const id = await longTicket(3);
    for (const bad of [undefined, "", "abc", "{$gt:''}", { $ne: null }]) {
      await assert.rejects(tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: bad }, deps), { code: "invalid_cursor" });
    }
  });

  test("only admins see sender ids and delivery state; customers get neither", async () => {
    const id = await openTicket();
    await adminSays(id, "hello");
    const admin = await tickets.getAdminTicket({ ticketId: id, markRead: false }, deps);
    const reply = admin.messages.find((m) => m.author === "admin");
    assert.equal(reply.adminId, ADMIN);
    assert.equal(reply.delivery, "sent", "the Telegram notification went out");
    const customer = await tickets.getCustomerTicket({ userId: ALICE, ticketId: id, markRead: false }, deps);
    assert.deepEqual(Object.keys(customer.messages.find((m) => m.author === "admin")).sort(), ["attachment", "author", "createdAt", "id", "text"]);
  });
});

describe("attachments", () => {
  test("only photos and videos within the size limit are accepted", async () => {
    const ok = await tickets.createTicket({ userId: "5", text: "", attachment: { kind: "video", fileId: "V", fileSize: tickets.MAX_ATTACHMENT_BYTES }, dedupeKey: key("v") }, deps);
    assert.equal(ok.message.attachment.kind, "video");
    await assert.rejects(tickets.createTicket({ userId: "5", text: "", attachment: { kind: "video", fileId: "V", fileSize: tickets.MAX_ATTACHMENT_BYTES + 1 }, dedupeKey: key("v") }, deps), { code: "attachment_too_large" });
    await assert.rejects(tickets.createTicket({ userId: "5", text: "x", attachment: { kind: "photo", fileId: "P", fileSize: -1 }, dedupeKey: key("v") }, deps), { code: "attachment_too_large" });
    for (const kind of ["document", "audio", "voice", "animation"]) {
      await assert.rejects(tickets.createTicket({ userId: "5", text: "x", attachment: { kind, fileId: "F" }, dedupeKey: key("v") }, deps), { code: "invalid_message" }, kind);
    }
    assert.equal(deps.Ticket.docs.length, 1, "rejected attachments create nothing");
  });

  test("an oversized upload is refused with the Persian explanation and creates no ticket", async () => {
    await assert.rejects(
      tickets.createTicket({ userId: "5", text: "", attachment: { kind: "video", fileId: "V", fileSize: 99 * 1024 * 1024 }, dedupeKey: key("v") }, deps),
      (error) => error.code === "attachment_too_large" && PERSIAN.test(error.safeMessage),
    );
    assert.equal(deps.Ticket.docs.length, 0);
  });
});

describe("admin API errors are English", () => {
  test("every ticket failure an admin can hit carries an English message and the same code", async () => {
    const id = await openTicket();
    const audit = makeAuditModel();
    const ctx = { actorId: ADMIN, ticketId: id, bot, auditModel: audit };
    await adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "closed" });

    const cases = [
      [async () => adminTickets.replyToSupportTicket({ ...ctx, operationId: OP(), text: "late" }), "ticket_closed"],
      [async () => adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "open" }), "reopen_not_allowed"],
      [async () => adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "bogus" }), "invalid_status"],
      [async () => adminTickets.getSupportTicket({ actorId: ADMIN, ticketId: "T-ZZZZZZ" }), "ticket_not_found"],
      [async () => adminTickets.getSupportTicketHistory({ actorId: ADMIN, ticketId: id, beforeId: "nope" }), "invalid_cursor"],
      [async () => adminTickets.listSupportTickets({ actorId: ADMIN, status: "resolved" }), "invalid_status"],
      [async () => adminTickets.replyToSupportTicket({ ...ctx, ticketId: (await openTicket(BOB)), operationId: OP(), text: "x".repeat(tickets.MAX_MESSAGE_LENGTH + 1) }), "message_too_long"],
    ];
    for (const [work, code] of cases) {
      await assert.rejects(work(), (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.safeMessage, PERSIAN, `${code}: ${error.safeMessage}`);
        return true;
      });
    }
  });

  test("the panel's close is idempotent across operation ids and reports whether anything changed", async () => {
    const id = await openTicket();
    const audit = makeAuditModel();
    const ctx = { actorId: ADMIN, ticketId: id, bot, auditModel: audit };
    const first = await adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "closed" });
    const second = await adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "closed" });
    assert.deepEqual([first.status, first.changed, second.status, second.changed], ["closed", true, "closed", false]);
    const sameOp = OP();
    const a = await adminTickets.setSupportTicketStatus({ ...ctx, ticketId: await openTicket(BOB), operationId: sameOp, status: "closed" });
    const b = await adminTickets.setSupportTicketStatus({ ...ctx, ticketId: a.ticketId, operationId: sameOp, status: "closed" });
    assert.equal(b.replayed, true);
  });

  test("a non-admin can do nothing", async () => {
    const id = await openTicket();
    await assert.rejects(adminTickets.setSupportTicketStatus({ actorId: "123", ticketId: id, operationId: OP(), status: "closed", bot, auditModel: makeAuditModel() }), { code: "forbidden" });
    await assert.rejects(adminTickets.getSupportTicketHistory({ actorId: "123", ticketId: id, beforeId: "a".repeat(24) }), { code: "forbidden" });
    assert.equal(ticketRow(id).status, "open");
  });
});

describe("the admin group no longer carries conversations", () => {
  const groupSends = () => bot.calls.filter((c) => ["sendMessage", "sendPhoto", "sendVideo"].includes(c.method) && String(c.args[0]) === process.env.GROUP_ID);

  test("opening a ticket, customer messages, admin replies and closing send nothing to the group", async () => {
    const id = await openTicket(ALICE, "اطلاعات خصوصی من");
    await customerSays(id, "متن دوم");
    await customerSays(id, "", ALICE, key("tg")).catch(() => {});
    await adminSays(id, "پاسخ");
    await closeAsAdmin(id);
    assert.deepEqual(groupSends(), []);
    assert.equal(deps.Message.docs.every((m) => !m.groupMessageIds.length), true);
  });

  test("the optional alert is off by default, and when enabled carries no conversation or identity", async () => {
    await openTicket();
    assert.deepEqual(groupSends(), []);
    process.env.SUPPORT_GROUP_ALERTS = "1";
    const secret = "رمز-خصوصی-123456";
    const id = (await workflow.customerOpenTicket({ bot, userId: ALICE, subject: secret, text: secret, dedupeKey: key("open"), channel: "telegram" })).ticket.ticketId;
    const [alert] = groupSends();
    assert.ok(alert.args[1].includes(id));
    assert.ok(!alert.args[1].includes(secret) && !alert.args[1].includes(String(ALICE)));
    await customerSays(id, "reply");
    await adminSays(id, "reply");
    assert.equal(groupSends().length, 1, "only NEW tickets are announced");
    // Replays of the same event do not announce twice.
    const dedupeKey = key("open");
    await workflow.customerOpenTicket({ bot, userId: BOB, text: "x", dedupeKey, channel: "telegram" });
    await workflow.customerOpenTicket({ bot, userId: BOB, text: "x", dedupeKey, channel: "telegram" });
    assert.equal(groupSends().length, 2);
  });

  test("an alert failure never fails or loses the ticket", async () => {
    process.env.SUPPORT_GROUP_ALERTS = "1";
    const broken = makeFakeBot({ failOn: ["sendMessage"] });
    const result = await workflow.customerOpenTicket({ bot: broken, userId: ALICE, text: "hi", dedupeKey: key("open"), channel: "telegram" });
    assert.equal(result.created, true);
    assert.equal(deps.Ticket.docs.length, 1);
  });

  test("an admin replying to an old group copy gets a pointer to the panel: nothing is delivered, stored or changed", async () => {
    const id = await openTicket();
    deps.Message.docs[0].groupMessageIds = [555];
    bot.calls.length = 0;
    const handled = await handleSupportGroupReply(bot, {
      message_id: 90, text: "/close", chat: { id: Number(process.env.GROUP_ID), type: "supergroup" },
      from: { id: Number(ADMIN) }, reply_to_message: { message_id: 555 },
    });
    assert.equal(handled, true);
    assert.equal(ticketRow(id).status, "open");
    assert.equal(stored(id).length, 1);
    const sends = bot.of("sendMessage");
    assert.equal(sends.length, 1);
    assert.equal(String(sends[0].args[0]), process.env.GROUP_ID, "only the group is answered; the customer is never contacted");
    assert.ok(sends[0].args[1].includes(id));
    await handleSupportGroupReply(bot, {
      message_id: 91, text: "پاسخ از گروه", chat: { id: Number(process.env.GROUP_ID), type: "supergroup" },
      from: { id: Number(ADMIN) }, reply_to_message: { message_id: 555 },
    });
    assert.equal(stored(id).length, 1);
  });

  test("a non-admin in the group is ignored (no pointer, no ticket data leaked), as is a reply to a non-ticket message", async () => {
    await openTicket();
    deps.Message.docs[0].groupMessageIds = [555];
    bot.calls.length = 0;
    const stranger = await handleSupportGroupReply(bot, {
      message_id: 92, text: "/close", chat: { id: Number(process.env.GROUP_ID), type: "supergroup" },
      from: { id: 424242 }, reply_to_message: { message_id: 555 },
    });
    assert.equal(stranger, false);
    const unrelated = await handleSupportGroupReply(bot, {
      message_id: 93, text: "hi", chat: { id: Number(process.env.GROUP_ID), type: "supergroup" },
      from: { id: Number(ADMIN) }, reply_to_message: { message_id: 31337 },
    });
    assert.equal(unrelated, false, "other group workflows (payments, manual fulfillment) still receive the message");
    assert.equal(bot.calls.length, 0);
  });
});

describe("customer notification", () => {
  test("an admin reply notifies the customer in Persian without copying the reply, and records delivery", async () => {
    const id = await openTicket();
    const secret = "reply-body-must-not-leave-the-panel";
    const result = await adminSays(id, secret);
    assert.equal(result.delivered, true);
    const [notice] = bot.of("sendMessage");
    assert.equal(String(notice.args[0]), String(ALICE));
    assert.equal(notice.args[1], SUPPORT_COPY.adminReply);
    assert.ok(!JSON.stringify(notice.args).includes(secret));
    assert.deepEqual(notice.args[2].reply_markup.inline_keyboard[0], [{ text: SUPPORT_COPY.viewTicket, callback_data: `sup_open:${id}` }]);
    assert.equal(deps.Message.docs.find((m) => m.author === "admin").delivery, "sent");
  });

  test("a blocked bot is recorded as failed delivery but the reply is kept", async () => {
    const id = await openTicket();
    const result = await workflow.adminReply({ bot: makeFakeBot({ failOn: ["sendMessage"] }), adminId: ADMIN, ticketId: id, text: "x", dedupeKey: key("w") });
    assert.equal(result.delivered, false);
    assert.equal(deps.Message.docs.find((m) => m.author === "admin").delivery, "failed");
    assert.equal(ticketRow(id).status, "pending_customer");
  });

  test("no Persian-copy sentence is written twice: delivery and flows read the shared module", async () => {
    assert.match(delivery.statusLabel("pending_customer"), PERSIAN);
    assert.equal(delivery.statusLabel("closed"), "بسته");
    assert.equal(delivery.statusLabel("resolved" /* legacy */), "باز", "unknown values fall back, never leak a raw status");
  });
});

