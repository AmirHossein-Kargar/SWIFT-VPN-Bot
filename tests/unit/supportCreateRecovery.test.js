/**
 * Ticket creation under failure and concurrency: a ticket is hidden until its
 * first message exists, twins converge on one ticket, the per-user cap holds,
 * and an interrupted create or message is always recoverable by a retry of the
 * same event. Failures are injected deterministically between every write.
 * In-memory models; tests/integration/supportTicketsMongo.test.js repeats the
 * key scenarios against a real MongoDB.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSupportDeps, makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";

process.env.ADMINS = "9001";
delete process.env.SUPPORT_GROUP_ALERTS;

const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const { setSessionClientForTests, clearSessionClientForTests } = await import("../../config/sessionStore.js");

const ALICE = "1001";
const BOB = "1002";
const ADMIN = "9001";
let deps;
let bot;
let seq = 0;
const key = (prefix) => `${prefix}:${++seq}`;
const restores = [];

beforeEach(() => {
  deps = makeSupportDeps();
  tickets.setSupportModelsForTests(deps);
  setSessionClientForTests(makeSessionClient());
  bot = makeFakeBot();
});
afterEach(() => {
  while (restores.length) restores.pop()();
  tickets.clearSupportModelsForTests();
  clearSessionClientForTests();
});

/** Makes the first call matching `matcher` throw an injected failure; later calls run normally. */
function failOnce(model, method, matcher = () => true) {
  const real = model[method];
  restores.push(() => { model[method] = real; });
  let fired = false;
  model[method] = function patched(...args) {
    if (!fired && matcher(...args)) { fired = true; throw Object.assign(new Error("injected failure"), { code: "EINJECTED" }); }
    return real.apply(this, args);
  };
}

const open = (userId, dedupeKey, text = "hello") => workflow.customerOpenTicket({ bot, userId, text, dedupeKey, channel: "telegram" });
const visible = (userId) => tickets.listCustomerTickets({ userId });
const rowsOf = (userId) => deps.Ticket.docs.filter((t) => t.userTelegramId === userId);
const messagesOf = (ticketId) => deps.Message.docs.filter((m) => m.ticketId === ticketId);
const activates = (filter, update) => update.$set?.provisional === false;

describe("a ticket is invisible until its first message exists", () => {
  test("a failure writing the first message leaves nothing visible, nothing hidden, and the cap untouched", async () => {
    const k = key("tg");
    failOnce(deps.Message, "create");
    await assert.rejects(open(ALICE, k), { code: "EINJECTED" });
    assert.equal(rowsOf(ALICE).length, 0, "the hidden ticket is removed because no message exists for it");
    assert.deepEqual(await visible(ALICE), []);
    const retry = await open(ALICE, k);
    assert.equal(retry.created, true);
    assert.equal(rowsOf(ALICE).length, 1);
    assert.equal(messagesOf(retry.ticket.ticketId).length, 1);
  });

  test("a crash that also loses the cleanup leaves a hidden ticket that no reader, list or counter sees", async () => {
    const k = key("tg");
    failOnce(deps.Message, "create");
    failOnce(deps.Ticket, "deleteOne");
    await assert.rejects(open(ALICE, k), { code: "EINJECTED" });
    const [hidden] = rowsOf(ALICE);
    assert.equal(hidden.provisional, true);
    assert.deepEqual(await visible(ALICE), []);
    const list = await tickets.listAdminTickets({});
    assert.equal(list.total, 0);
    assert.equal(list.unreadTotal, 0);
    assert.equal(list.needsAttention, 0);
    await assert.rejects(tickets.getCustomerTicket({ userId: ALICE, ticketId: hidden.ticketId }), { code: "ticket_not_found" });
    await assert.rejects(tickets.getAdminTicket({ ticketId: hidden.ticketId }), { code: "ticket_not_found" });
    await assert.rejects(tickets.addAdminReply({ ticketId: hidden.ticketId, adminId: ADMIN, text: "x", dedupeKey: key("a") }), { code: "ticket_not_found" });
    await assert.rejects(tickets.addCustomerMessage({ ticketId: hidden.ticketId, userId: ALICE, text: "x", dedupeKey: key("c") }), { code: "ticket_not_found" });
    await assert.rejects(tickets.changeStatus({ ticketId: hidden.ticketId, status: "closed", actor: { role: "admin", id: ADMIN } }), { code: "ticket_not_found" });
  });

  test("the retry of the same event finishes the hidden ticket instead of creating a second one", async () => {
    const k = key("tg");
    failOnce(deps.Message, "create");
    failOnce(deps.Ticket, "deleteOne");
    await assert.rejects(open(ALICE, k), { code: "EINJECTED" });
    const [hidden] = rowsOf(ALICE);
    const retry = await open(ALICE, k);
    assert.equal(retry.created, true);
    assert.equal(retry.ticket.ticketId, hidden.ticketId);
    assert.equal(rowsOf(ALICE).length, 1);
    assert.equal(messagesOf(hidden.ticketId).length, 1);
    const row = rowsOf(ALICE)[0];
    assert.deepEqual([row.provisional, row.messageCount, row.unreadForAdmin], [false, 1, 1]);
    const again = await open(ALICE, k);
    assert.equal(again.duplicate, true);
    assert.equal(again.created, false);
    assert.equal(rowsOf(ALICE).length, 1);
    assert.equal(messagesOf(hidden.ticketId).length, 1);
  });

  test("a crash after the message row but before the ticket becomes visible is completed by the retry", async () => {
    const k = key("tg");
    failOnce(deps.Ticket, "findOneAndUpdate", activates);
    await assert.rejects(open(ALICE, k), { code: "EINJECTED" });
    const [hidden] = rowsOf(ALICE);
    assert.equal(hidden.provisional, true, "the message landed, the ticket is still hidden");
    assert.equal(messagesOf(hidden.ticketId).length, 1);
    assert.deepEqual(await visible(ALICE), []);
    const retry = await open(ALICE, k);
    assert.equal(retry.ticket.ticketId, hidden.ticketId);
    assert.equal(retry.created, true);
    assert.equal(messagesOf(hidden.ticketId).length, 1, "the stored message is reused, never duplicated");
    assert.equal(rowsOf(ALICE)[0].messageCount, 1);
  });

  test("a hidden ticket abandoned past the grace period does not hold the cap and is removed", async () => {
    for (let i = 0; i < tickets.MAX_OPEN_TICKETS_PER_USER - 1; i += 1) await open(ALICE, key("tg"));
    const old = new Date(Date.now() - tickets.PROVISIONAL_GRACE_MS - 1000);
    await deps.Ticket.create({ ticketId: "T-ABANDN", userTelegramId: ALICE, subject: "x", status: "open", provisional: true, createKey: "dead", createdAt: old });
    const fresh = await open(ALICE, key("tg"));
    assert.equal(fresh.created, true);
    assert.equal(deps.Ticket.docs.some((t) => t.ticketId === "T-ABANDN"), false, "the abandoned ticket (no message) is removed");
    assert.equal((await visible(ALICE)).length, tickets.MAX_OPEN_TICKETS_PER_USER);
  });

  test("an abandoned hidden ticket whose message did land is activated, not lost", async () => {
    const old = new Date(Date.now() - tickets.PROVISIONAL_GRACE_MS - 1000);
    await deps.Ticket.create({ ticketId: "T-LANDED", userTelegramId: ALICE, subject: "x", status: "open", provisional: true, createKey: "landed", createdAt: old });
    await deps.Message.create({ ticketId: "T-LANDED", author: "customer", text: "stored", dedupeKey: "landed", createdAt: old });
    await open(ALICE, key("tg"));
    const row = deps.Ticket.docs.find((t) => t.ticketId === "T-LANDED");
    assert.deepEqual([row.provisional, row.messageCount, row.unreadForAdmin], [false, 1, 1]);
    assert.equal((await visible(ALICE)).length, 2);
  });

  test("a stored first message whose ticket no longer exists is cleared and the event can be retried", async () => {
    const k = key("tg");
    await deps.Message.create({ ticketId: "T-GONE22", author: "customer", text: "orphan", dedupeKey: k });
    const result = await open(ALICE, k);
    assert.equal(result.created, true);
    assert.equal(deps.Message.docs.filter((m) => m.dedupeKey === k).length, 1);
    assert.notEqual(result.ticket.ticketId, "T-GONE22");
  });
});

describe("duplicate create events", () => {
  test("simultaneous twins produce exactly one ticket, one message, one 'created' and no raw errors", async () => {
    const k = key("tg");
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => open(ALICE, k)));
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message)));
    assert.equal(rowsOf(ALICE).length, 1);
    assert.equal(deps.Message.docs.filter((m) => m.dedupeKey === k).length, 1);
    assert.equal(results.filter((r) => r.value.created).length, 1);
    assert.equal(new Set(results.map((r) => r.value.ticket.ticketId)).size, 1);
    assert.equal(rowsOf(ALICE)[0].unreadForAdmin, 1);
    assert.equal(rowsOf(ALICE)[0].messageCount, 1);
  });

  test("twins racing an injected failure converge on one ticket after the retry", async () => {
    const k = key("tg");
    failOnce(deps.Message, "create");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => open(ALICE, k)));
    const retry = await open(ALICE, k);
    assert.equal(rowsOf(ALICE).length, 1);
    assert.equal(deps.Message.docs.filter((m) => m.dedupeKey === k).length, 1);
    assert.equal(retry.ticket.ticketId, rowsOf(ALICE)[0].ticketId);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason.code === "EINJECTED" || r.reason instanceof tickets.SupportError, `unexpected ${r.reason?.message}`);
  });

  test("the same event from a different user never reaches the first user's ticket and leaks no duplicate-key error", async () => {
    const k = key("tg");
    const results = await Promise.allSettled([open(ALICE, k), open(BOB, k)]);
    const failures = results.filter((r) => r.status === "rejected");
    assert.ok(failures.every((r) => r.reason instanceof tickets.SupportError && r.reason.code === "ticket_not_found"));
    assert.equal(rowsOf(ALICE).length + rowsOf(BOB).length, 1, "one ticket in total, owned by whoever won");
    assert.equal(deps.Message.docs.filter((m) => m.dedupeKey === k).length, 1);
  });

  test("different users creating simultaneously each get their own ticket", async () => {
    const users = Array.from({ length: 6 }, (_, i) => String(2000 + i));
    const results = await Promise.all(users.map((u) => open(u, key("tg"))));
    assert.ok(results.every((r) => r.created));
    for (const u of users) assert.equal((await visible(u)).length, 1);
  });
});

describe("per-user open-ticket cap", () => {
  const CAP = tickets.MAX_OPEN_TICKETS_PER_USER;

  test("the cap refuses the next ticket and a closed ticket frees a slot", async () => {
    const ids = [];
    for (let i = 0; i < CAP; i += 1) ids.push((await open(ALICE, key("tg"))).ticket.ticketId);
    await assert.rejects(open(ALICE, key("tg")), { code: "too_many_open_tickets" });
    assert.equal(rowsOf(ALICE).length, CAP, "the refused attempt left nothing behind");
    await workflow.adminSetStatus({ bot, ticketId: ids[0], status: "closed", adminId: ADMIN });
    assert.equal((await open(ALICE, key("tg"))).created, true);
  });

  test("simultaneous creates by one user can never exceed the cap and leave no hidden leftovers", async () => {
    const results = await Promise.allSettled(Array.from({ length: CAP * 3 }, () => open(ALICE, key("tg"))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    assert.ok(failed.every((r) => r.reason?.code === "too_many_open_tickets"), JSON.stringify(failed.map((r) => r.reason?.message)));
    assert.ok(ok.length >= 1 && ok.length <= CAP);
    assert.equal(rowsOf(ALICE).length, ok.length, "every stored ticket belongs to a successful create");
    assert.ok(rowsOf(ALICE).every((t) => !t.provisional && messagesOf(t.ticketId).length === 1));
  });

  test("simultaneous creates at the edge (one slot left) admit at most one", async () => {
    for (let i = 0; i < CAP - 1; i += 1) await open(ALICE, key("tg"));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => open(ALICE, key("tg"))));
    assert.ok(results.filter((r) => r.status === "fulfilled").length <= 1);
    assert.ok(rowsOf(ALICE).length <= CAP);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason?.code === "too_many_open_tickets"));
  });

  test("a twin of the event that filled the cap resolves to that ticket instead of being refused", async () => {
    for (let i = 0; i < CAP - 1; i += 1) await open(ALICE, key("tg"));
    const k = key("tg");
    const results = await Promise.all([open(ALICE, k), open(ALICE, k), open(ALICE, k)]);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(rowsOf(ALICE).length, CAP);
  });

  test("a hidden ticket from a failed create does not consume the cap", async () => {
    for (let i = 0; i < CAP - 1; i += 1) await open(ALICE, key("tg"));
    failOnce(deps.Message, "create");
    failOnce(deps.Ticket, "deleteOne");
    await assert.rejects(open(ALICE, key("tg")), { code: "EINJECTED" });
    assert.equal((await visible(ALICE)).length, CAP - 1);
  });
});

describe("a message is accepted only once it is stored", () => {
  const setup = async () => {
    const created = await open(ALICE, key("tg"));
    return created.ticket.ticketId;
  };
  const row = (id) => deps.Ticket.docs.find((t) => t.ticketId === id);

  test("a failed insert leaves status, activity and unread counters exactly as they were", async () => {
    const id = await setup();
    const before = structuredClone(row(id));
    failOnce(deps.Message, "create");
    await assert.rejects(workflow.adminReply({ bot, adminId: ADMIN, ticketId: id, text: "answer", dedupeKey: key("web") }), { code: "EINJECTED" });
    const after = row(id);
    for (const field of ["status", "lastMessageBy", "unreadForAdmin", "unreadForCustomer", "messageCount", "lastMessageAt"]) {
      assert.deepEqual(after[field], before[field], field);
    }
    assert.equal(bot.of("sendMessage").length, 0);
  });

  test("a failed insert of a customer message does not flip a pending ticket back to open", async () => {
    const id = await setup();
    await workflow.adminReply({ bot, adminId: ADMIN, ticketId: id, text: "answer", dedupeKey: key("web") });
    assert.equal(row(id).status, "pending_customer");
    failOnce(deps.Message, "create");
    await assert.rejects(workflow.customerReply({ userId: ALICE, ticketId: id, text: "more", dedupeKey: key("tg") }), { code: "EINJECTED" });
    assert.equal(row(id).status, "pending_customer");
    assert.equal(row(id).lastMessageBy, "admin");
  });

  test("a crash between the insert and the status update is repaired by the retry of the same message", async () => {
    const id = await setup();
    const k = key("web");
    failOnce(deps.Ticket, "updateOne", (filter, update) => update.$set?.lastMessageBy === "admin");
    await assert.rejects(workflow.adminReply({ bot, adminId: ADMIN, ticketId: id, text: "answer", dedupeKey: k }), { code: "EINJECTED" });
    assert.equal(messagesOf(id).length, 2, "the row is stored");
    assert.equal(row(id).status, "open", "but the status has not moved yet");
    const retry = await workflow.adminReply({ bot, adminId: ADMIN, ticketId: id, text: "answer", dedupeKey: k });
    assert.equal(retry.duplicate, true);
    assert.equal(messagesOf(id).length, 2);
    assert.equal(row(id).status, "pending_customer");
    assert.equal(row(id).lastMessageBy, "admin");
    assert.equal(row(id).messageCount, 2);
  });

  test("a replay of an older message never rewinds the status set by a newer one", async () => {
    const id = await setup();
    const k = key("web");
    await workflow.adminReply({ bot, adminId: ADMIN, ticketId: id, text: "answer", dedupeKey: k });
    await workflow.customerReply({ userId: ALICE, ticketId: id, text: "thanks", dedupeKey: key("tg") });
    assert.equal(row(id).status, "open");
    await workflow.adminReply({ bot, adminId: ADMIN, ticketId: id, text: "answer", dedupeKey: k });
    assert.equal(row(id).status, "open");
    assert.equal(row(id).lastMessageBy, "customer");
  });

  test("a message key already stored under another ticket is refused as a retryable error, not a raw duplicate-key error", async () => {
    const id = await setup();
    const k = key("tg");
    const other = await open(ALICE, key("tg"));
    await tickets.addCustomerMessage({ ticketId: other.ticket.ticketId, userId: ALICE, text: "x", dedupeKey: k });
    await assert.rejects(tickets.addCustomerMessage({ ticketId: id, userId: ALICE, text: "x", dedupeKey: k }), { code: "ticket_not_found" });
  });
});
