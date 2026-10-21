/**
 * Live ticket synchronization: the web panel and customer area poll
 * getTicketUpdates with a message-id cursor; Telegram-originated and
 * web-originated messages all land in the same collection, so these tests drive
 * the real workflow functions from both channels and read them back through the
 * cursor API.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSupportDeps, makeFakeBot } from "../helpers/fakeSupport.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";

const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const { getSupportTicketUpdates } = await import("../../services/admin/tickets.js");

const { getTicketUpdates, getAdminTicket, getCustomerTicket } = tickets;
const ALICE = 1001;
const BOB = 1002;
let deps;
let bot;
let seq = 0;
const key = (prefix) => `${prefix}:${++seq}`;

beforeEach(() => { deps = makeSupportDeps(); tickets.setSupportModelsForTests(deps); bot = makeFakeBot(); });
afterEach(() => tickets.clearSupportModelsForTests());

async function openTicket(userId = ALICE, text = "سلام، مشکل دارم") {
  const result = await workflow.customerOpenTicket({ bot, from: { id: userId }, userId, subject: "مشکل اتصال", text, dedupeKey: key("open"), channel: "telegram" });
  return result.ticket.ticketId;
}
const customerSays = (ticketId, text, userId = ALICE, dedupeKey = key("tg")) => workflow.customerReply({ bot, from: { id: userId }, userId, ticketId, text, dedupeKey });
const adminSays = (ticketId, text, dedupeKey = key("web-admin")) => workflow.adminReply({ bot, adminId: "9001", ticketId, text, dedupeKey });
const poll = (ticketId, extra = {}) => getTicketUpdates({ audience: "admin", ticketId, ...extra });
const texts = (result) => result.messages.map((m) => m.text);

describe("cursor-based updates", () => {
  test("a first poll returns the whole conversation and a cursor; the next poll returns only what is new", async () => {
    const id = await openTicket();
    await adminSays(id, "پاسخ اول");
    const first = await poll(id);
    assert.deepEqual(texts(first), ["سلام، مشکل دارم", "پاسخ اول"]);

    assert.deepEqual((await poll(id, { afterId: first.cursor })).messages, [], "nothing new");
    await customerSays(id, "ممنون، هنوز وصل نمی‌شود");
    const next = await poll(id, { afterId: first.cursor });
    assert.deepEqual(texts(next), ["ممنون، هنوز وصل نمی‌شود"]);
    assert.notEqual(next.cursor, first.cursor);
  });

  test("messages stay in insertion order across channels, even when timestamps tie", async () => {
    const id = await openTicket();
    for (const message of deps.Message.docs) message.createdAt = new Date(1_000); // identical timestamps
    await adminSays(id, "web reply 1");
    await customerSays(id, "telegram reply");
    await adminSays(id, "web reply 2");
    for (const message of deps.Message.docs) message.createdAt = new Date(1_000);
    const all = await poll(id);
    assert.deepEqual(texts(all), ["سلام، مشکل دارم", "web reply 1", "telegram reply", "web reply 2"]);
    assert.deepEqual((await getAdminTicket({ ticketId: id })).messages.map((m) => m.text), texts(all), "full load and live poll agree");
  });

  test("replaying the same cursor (a retried or reconnecting poll) returns identical rows: no loss, no duplicates", async () => {
    const id = await openTicket();
    const base = await poll(id);
    await customerSays(id, "a");
    await customerSays(id, "b");
    const one = await poll(id, { afterId: base.cursor });
    const again = await poll(id, { afterId: base.cursor });
    assert.deepEqual(one.messages, again.messages);
    assert.deepEqual(texts(one), ["a", "b"]);
    // A client that merges by id ends with exactly one copy of each message.
    const merged = new Map([...base.messages, ...one.messages, ...again.messages].map((m) => [m.id, m]));
    assert.equal(merged.size, 3);
  });

  test("a reconnect after a long gap catches up in pages without skipping messages", async () => {
    const id = await openTicket();
    const base = await poll(id);
    for (let i = 0; i < 5; i += 1) await customerSays(id, `m${i}`);
    const page1 = await poll(id, { afterId: base.cursor, limit: 2 });
    assert.equal(page1.hasMore, true);
    const page2 = await poll(id, { afterId: page1.cursor, limit: 2 });
    const page3 = await poll(id, { afterId: page2.cursor, limit: 2 });
    assert.deepEqual([...texts(page1), ...texts(page2), ...texts(page3)], ["m0", "m1", "m2", "m3", "m4"]);
    assert.equal(page3.hasMore, false);
  });

  test("a malformed cursor falls back to a safe full resync instead of an error or an injection", async () => {
    const id = await openTicket();
    for (const bad of ["not-an-id", "{$gt:''}", "../x", "", null, undefined, { $ne: null }]) {
      const result = await poll(id, { afterId: bad });
      assert.deepEqual(texts(result), ["سلام، مشکل دارم"]);
    }
  });

  test("a very long ticket keeps the NEWEST messages on a full load (the oldest are trimmed, not the latest)", async () => {
    const id = await openTicket();
    for (let i = 0; i < 520; i += 1) await customerSays(id, `n${i}`);
    const full = await getAdminTicket({ ticketId: id });
    assert.equal(full.messages.length, 500);
    assert.equal(full.messages.at(-1).text, "n519");
    const afterFull = await poll(id, { afterId: full.cursor });
    assert.deepEqual(afterFull.messages, []);
  });
});

describe("web <-> Telegram synchronization", () => {
  test("a Telegram customer message and a web admin reply are both visible to the other side's next poll", async () => {
    const id = await openTicket();
    const adminView = await poll(id);
    const customerView = await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id });
    await customerSays(id, "از تلگرام", ALICE, "tg:900:5");
    await adminSays(id, "از پنل وب");
    assert.deepEqual(texts(await poll(id, { afterId: adminView.cursor })), ["از تلگرام", "از پنل وب"]);
    assert.deepEqual(texts(await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id, afterId: customerView.cursor })), ["از تلگرام", "از پنل وب"]);
  });

  test("status changes appear on the next poll for both sides", async () => {
    const id = await openTicket();
    assert.equal((await poll(id)).ticket.status, "open");
    await workflow.adminSetStatus({ bot, ticketId: id, status: "resolved" });
    assert.equal((await poll(id)).ticket.status, "resolved");
    assert.equal((await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id })).ticket.status, "resolved");
    await workflow.customerSetStatus({ bot, userId: ALICE, ticketId: id, status: "closed" });
    assert.equal((await poll(id)).ticket.status, "closed");
  });

  test("a redelivered Telegram update or double-submitted web form creates exactly one message", async () => {
    const id = await openTicket();
    const dedupe = "tg:777:42";
    await customerSays(id, "یک بار", ALICE, dedupe);
    await customerSays(id, "یک بار", ALICE, dedupe);
    await adminSays(id, "یک پاسخ", "web-admin:op-1");
    await adminSays(id, "یک پاسخ", "web-admin:op-1");
    const all = await poll(id);
    assert.deepEqual(texts(all), ["سلام، مشکل دارم", "یک بار", "یک پاسخ"]);
    assert.equal(all.ticket.messageCount, 3);
  });

  test("concurrent replies from both channels are all stored once, in a single consistent order for every reader", async () => {
    const id = await openTicket();
    await Promise.all([
      customerSays(id, "c1"), adminSays(id, "a1"), customerSays(id, "c2"), adminSays(id, "a2"), customerSays(id, "c3"),
    ]);
    const adminOrder = texts(await poll(id)).slice(1);
    const customerOrder = texts(await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id })).slice(1);
    assert.equal(adminOrder.length, 5);
    assert.deepEqual([...adminOrder].sort(), ["a1", "a2", "c1", "c2", "c3"]);
    assert.deepEqual(adminOrder, customerOrder);
    assert.equal((await poll(id)).ticket.messageCount, 6);
  });
});

describe("read state and unread counters", () => {
  test("polling without markRead never writes; unread persists until the ticket is actually viewed", async () => {
    const id = await openTicket();
    await customerSays(id, "جدید");
    const writes = [];
    const realUpdate = deps.Ticket.updateOne.bind(deps.Ticket);
    deps.Ticket.updateOne = async (...args) => { writes.push(args); return realUpdate(...args); };
    for (let i = 0; i < 3; i += 1) await poll(id);
    assert.equal(writes.length, 0, "background polls do not write");
    assert.ok((await poll(id)).ticket.unread > 0);
    assert.equal((await poll(id, { markRead: true })).ticket.unread, 0);
  });

  test("repeated viewing polls do not keep writing once the ticket is read", async () => {
    const id = await openTicket();
    await customerSays(id, "x");
    await poll(id, { markRead: true });
    const writes = [];
    const realUpdate = deps.Ticket.updateOne.bind(deps.Ticket);
    deps.Ticket.updateOne = async (...args) => { writes.push(args); return realUpdate(...args); };
    for (let i = 0; i < 5; i += 1) await poll(id, { markRead: true });
    assert.equal(writes.length, 0);
  });

  test("a message that arrives during a viewing poll is not marked read", async () => {
    const id = await openTicket();
    await customerSays(id, "قبل");
    const realFind = deps.Message.find.bind(deps.Message);
    let injected = false;
    deps.Message.find = (...args) => {
      const cursor = realFind(...args);
      if (!injected) { injected = true; return Object.assign(cursor, { lean: async () => { await customerSays(id, "وسط poll"); return cursor.then((rows) => rows); } }); }
      return cursor;
    };
    const viewed = await poll(id, { markRead: true });
    assert.equal(injected, true, "the late message really arrived mid-poll");
    assert.ok(viewed.messages.every((m) => m.text !== "وسط poll"), "the late message was not part of this response");
    assert.ok((await poll(id)).ticket.unread > 0, "the late message keeps the ticket unread");
  });

  test("the customer's unread counter rises on an admin reply and clears only when the customer views", async () => {
    const id = await openTicket();
    await adminSays(id, "پاسخ");
    const peek = await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id });
    assert.equal(peek.ticket.unread, 1);
    assert.equal((await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id, markRead: true })).ticket.unread, 0);
    assert.equal((await getCustomerTicket({ userId: ALICE, ticketId: id, markRead: false })).ticket.unread, 0);
  });
});

describe("authorization", () => {
  test("a customer can only poll their own ticket; another customer's looks exactly like a missing one", async () => {
    const id = await openTicket(ALICE);
    await assert.rejects(() => getTicketUpdates({ audience: "customer", userId: BOB, ticketId: id }), { code: "ticket_not_found" });
    await assert.rejects(() => getTicketUpdates({ audience: "customer", userId: BOB, ticketId: "TK-DOESNOTEXIST" }), { code: "ticket_not_found" });
    await assert.rejects(() => getTicketUpdates({ audience: "customer", userId: null, ticketId: id }));
  });

  test("a customer poll can never return admin-only fields or another user's id", async () => {
    const id = await openTicket(ALICE);
    await adminSays(id, "داخلی");
    const view = await getTicketUpdates({ audience: "customer", userId: ALICE, ticketId: id });
    assert.equal(view.ticket.userTelegramId, undefined);
    assert.equal(view.ticket.closedBy, undefined);
    for (const message of view.messages) assert.deepEqual(Object.keys(message).sort(), ["attachment", "author", "createdAt", "id", "text"]);
  });

  test("the admin updates endpoint requires an allowlisted admin", async () => {
    const id = await openTicket();
    await assert.rejects(() => getSupportTicketUpdates({ actorId: "123", ticketId: id }), { code: "forbidden" });
    assert.ok(await getSupportTicketUpdates({ actorId: "9001", ticketId: id }));
  });

  test("malformed ticket ids are rejected as not found", async () => {
    for (const bad of ["", "../x", "TK-1; drop", null]) {
      await assert.rejects(() => poll(bad), { code: "ticket_not_found" });
    }
  });
});
