/**
 * Support tickets against a REAL MongoDB: the in-memory fakes elsewhere emulate
 * the operators the service uses, this file proves the real ones behave the
 * same (string cursors cast to ObjectId, $nin/$in filters, the $ifNull pipeline
 * migration, unique-index races, and real concurrency between a close and a
 * message). Skipped when no database is reachable; use a disposable one on a
 * non-default port (TEST_MONGO_URL), never the default 27017.
 */
import { test, describe, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CAP_SCENARIO_NAMES, runCapScenario, cleanupVersusTwin } from "../helpers/capScenarios.js";
import { RECOVERY_SCENARIO_NAMES, runRecoveryScenario } from "../helpers/recoveryScenarios.js";

process.env.ADMINS = "9001";
delete process.env.SUPPORT_GROUP_ALERTS;

// Models first: connectTestDB() syncs indexes for the models registered by then.
const { default: SupportTicket } = await import("../../models/SupportTicket.js");
const { default: SupportTicketMessage } = await import("../../models/SupportTicketMessage.js");
const { default: AdminAuditLog } = await import("../../models/AdminAuditLog.js");
const { connectTestDB, disconnectTestDB } = await import("../helpers/db.js");
const { makeFakeBot } = await import("../helpers/fakeSupport.js");

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const adminTickets = await import("../../services/admin/tickets.js");

const ALICE = "1001";
const ADMIN = "9001";
const PERSIAN = new RegExp(`[${String.fromCharCode(0x600)}-${String.fromCharCode(0x6ff)}]`);
let seq = 0;
const key = (prefix) => `${prefix}:${process.pid}:${++seq}`;
const OP = () => `op-mongo-${String(++seq).padStart(12, "0")}`;
let bot;

const openTicket = async (userId = ALICE, text = "Hello") =>
  (await workflow.customerOpenTicket({ bot, userId, text, dedupeKey: key("open"), channel: "telegram" })).ticket.ticketId;
const customerSays = (ticketId, text = "msg", userId = ALICE, dedupeKey = key("tg")) => workflow.customerReply({ userId, ticketId, text, dedupeKey });
const adminSays = (ticketId, text = "reply", dedupeKey = key("web")) => workflow.adminReply({ bot, adminId: ADMIN, ticketId, text, dedupeKey });
const closeAsAdmin = (ticketId) => workflow.adminSetStatus({ bot, ticketId, status: "closed", adminId: ADMIN });
const row = (ticketId) => SupportTicket.findOne({ ticketId }).lean();
const count = (ticketId) => SupportTicketMessage.countDocuments({ ticketId });

before(() => { bot = makeFakeBot(); });
// Every test starts from an empty ticket collection (the per-open-ticket cap is per user).
beforeEach(async () => {
  if (!dbAvailable) return;
  await SupportTicket.deleteMany({});
  await SupportTicketMessage.deleteMany({});
});
after(async () => { await disconnectTestDB(); });

describe("lifecycle on real Mongo", () => {
  skip("open → pending_customer → open → closed, with audit fields", async () => {
    const id = await openTicket();
    assert.equal((await row(id)).status, "open");
    await adminSays(id);
    assert.equal((await row(id)).status, "pending_customer");
    await customerSays(id);
    assert.equal((await row(id)).status, "open");
    const closed = await closeAsAdmin(id);
    assert.equal(closed.changed, true);
    const saved = await row(id);
    assert.deepEqual([saved.status, saved.closedBy, saved.closedByAdminId], ["closed", "admin", ADMIN]);
    assert.ok(saved.closedAt instanceof Date);
    assert.equal(saved.messageCount, await count(id));
  });

  skip("a closed ticket rejects both sides, refuses every reopen, and a retried close is a no-op", async () => {
    const id = await openTicket();
    await closeAsAdmin(id);
    const closedAt = (await row(id)).closedAt;
    await assert.rejects(customerSays(id), { code: "ticket_closed" });
    await assert.rejects(adminSays(id), { code: "ticket_closed" });
    await assert.rejects(workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "open" }), { code: "reopen_not_allowed" });
    await assert.rejects(workflow.adminSetStatus({ bot, ticketId: id, status: "open", adminId: ADMIN }), { code: "reopen_not_allowed" });
    assert.equal((await closeAsAdmin(id)).changed, false);
    assert.deepEqual((await row(id)).closedAt, closedAt);
    assert.equal(await count(id), 1);
  });

  skip("another customer cannot touch the ticket", async () => {
    const id = await openTicket(ALICE);
    await assert.rejects(customerSays(id, "x", "2002"), { code: "ticket_not_found" });
    await assert.rejects(workflow.customerSetStatus({ userId: "2002", ticketId: id, status: "closed" }), { code: "ticket_not_found" });
    assert.equal((await row(id)).status, "open");
  });
});

describe("real concurrency", () => {
  skip("closes racing messages always end consistent (stored messages == messageCount, ticket closed, only ticket_closed failures)", async () => {
    for (let round = 0; round < 40; round += 1) {
      const id = await openTicket();
      const results = await Promise.allSettled([
        customerSays(id, "a"), adminSays(id, "b"), closeAsAdmin(id), closeAsAdmin(id),
        workflow.customerSetStatus({ userId: ALICE, ticketId: id, status: "closed" }), customerSays(id, "c"),
      ]);
      const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason?.code ?? r.reason?.message);
      assert.ok(failures.every((code) => code === "ticket_closed"), `round ${round}: ${failures}`);
      const saved = await row(id);
      assert.equal(saved.status, "closed");
      assert.equal(await count(id), saved.messageCount, `round ${round}: no orphaned or uncounted message`);
    }
  });

  skip("every accepted message is persisted, counted and (for replies) notified once; every rejected key left no row", async () => {
    for (let round = 0; round < 40; round += 1) {
      const id = await openTicket();
      const sentBefore = bot.of("sendMessage").length;
      const attempts = [];
      const attempt = (kind, run) => { const dedupeKey = key(kind); attempts.push({ kind, dedupeKey, done: run(dedupeKey).then((value) => ({ value }), (error) => ({ error })) }); };
      attempt("tg", (k) => customerSays(id, "a", ALICE, k));
      attempt("web", (k) => adminSays(id, "b", k));
      attempt("tg", (k) => customerSays(id, "c", ALICE, k));
      attempt("web", (k) => adminSays(id, "d", k));
      const closer = closeAsAdmin(id);
      await Promise.all(attempts.map((a) => a.done));
      await closer;
      let acceptedReplies = 0;
      for (const a of attempts) {
        const { value, error } = await a.done;
        const rows = await SupportTicketMessage.countDocuments({ dedupeKey: a.dedupeKey });
        if (error) {
          assert.equal(error.code, "ticket_closed", `round ${round}`);
          assert.equal(rows, 0, `round ${round}: a rejected message left a row`);
        } else {
          assert.equal(rows, 1, `round ${round}: an accepted message must be persisted`);
          assert.equal(String((await SupportTicketMessage.findOne({ dedupeKey: a.dedupeKey }).lean())._id), String(value.message._id));
          if (a.kind === "web") acceptedReplies += 1;
        }
      }
      const saved = await row(id);
      assert.equal(saved.status, "closed");
      assert.equal(await count(id), saved.messageCount, `round ${round}: messageCount matches persisted messages`);
      assert.equal(bot.of("sendMessage").length - sentBefore, acceptedReplies + 1, `round ${round}: one notice per accepted reply plus the close notice`);
    }
  });

  skip("duplicate submissions racing a close are stored at most once and never both accepted and rejected inconsistently", async () => {
    for (let round = 0; round < 30; round += 1) {
      const id = await openTicket();
      const dedupeKey = key("twin");
      const results = await Promise.allSettled([
        ...Array.from({ length: 5 }, () => customerSays(id, "twin", ALICE, dedupeKey)),
        closeAsAdmin(id),
      ]);
      const twins = results.slice(0, 5);
      const rows = await SupportTicketMessage.countDocuments({ dedupeKey });
      assert.ok(rows <= 1, `round ${round}: ${rows} rows`);
      assert.ok(twins.filter((r) => r.status === "rejected").every((r) => r.reason.code === "ticket_closed"));
      const accepted = twins.filter((r) => r.status === "fulfilled");
      assert.equal(rows === 1, accepted.length > 0, `round ${round}: accepted iff stored`);
      assert.equal(accepted.filter((r) => !r.value.duplicate).length, rows, `round ${round}: exactly one original`);
      const saved = await row(id);
      assert.equal(await count(id), saved.messageCount);
      // Whatever a twin was told, a later retry of the same key agrees with what is stored.
      if (rows === 1) assert.equal((await customerSays(id, "twin", ALICE, dedupeKey)).duplicate, true);
      else await assert.rejects(customerSays(id, "twin", ALICE, dedupeKey), { code: "ticket_closed" });
    }
  });

  describe("failure injection", () => {
    const originals = [];
    const failOnce = (model, method, matcher) => {
      const real = model[method];
      originals.push(() => { model[method] = real; });
      let fired = false;
      model[method] = function patched(...args) {
        if (!fired && matcher(...args)) { fired = true; throw Object.assign(new Error("injected failure"), { code: "EINJECTED" }); }
        return real.apply(this, args);
      };
    };
    afterEach(() => { while (originals.length) originals.pop()(); });

    skip("a failure before the message row is written stores nothing; the retry of the same key completes once", async () => {
      const id = await openTicket();
      const dedupeKey = key("web");
      const sent = bot.of("sendMessage").length;
      failOnce(SupportTicketMessage, "create", () => true);
      await assert.rejects(adminSays(id, "reply", dedupeKey), { code: "EINJECTED" });
      assert.equal(await count(id), 1);
      assert.equal((await row(id)).messageCount, 1);
      assert.equal(bot.of("sendMessage").length, sent, "nothing delivered for an unsaved reply");
      assert.equal((await adminSays(id, "reply", dedupeKey)).duplicate, false);
      assert.equal(await count(id), 2);
      assert.equal((await row(id)).messageCount, 2);
      assert.equal(bot.of("sendMessage").length, sent + 1);
      assert.equal((await adminSays(id, "reply", dedupeKey)).duplicate, true);
      assert.equal(await count(id), 2);
      assert.equal(bot.of("sendMessage").length, sent + 1);
    });

    skip("a failure after the row is written leaves no duplicate; the retry repairs the count and the ticket can still be closed", async () => {
      const id = await openTicket();
      const dedupeKey = key("tg");
      failOnce(SupportTicket, "findOneAndUpdate", (filter, update) => Boolean(update.$max));
      await assert.rejects(customerSays(id, "hello", ALICE, dedupeKey), { code: "EINJECTED" });
      assert.equal(await count(id), 2);
      assert.equal((await row(id)).messageCount, 1, "short until settled");
      const retry = await customerSays(id, "hello", ALICE, dedupeKey);
      assert.equal(retry.duplicate, true);
      assert.equal(await count(id), 2);
      assert.equal((await row(id)).messageCount, 2);
      await closeAsAdmin(id);
      await assert.rejects(customerSays(id, "hello", ALICE, dedupeKey).then((r) => { if (!r.duplicate) throw new Error("must be a replay"); throw Object.assign(new Error("replay"), { code: "replay_ok" }); }), { code: "replay_ok" });
    });
  });

  skip("the same Telegram update delivered concurrently creates exactly one ticket and one message", async () => {
    const dedupeKey = key("race-open");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => workflow.customerOpenTicket({ bot, userId: "7001", text: "once", dedupeKey, channel: "telegram" })));
    assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message)));
    assert.equal(await SupportTicket.countDocuments({ userTelegramId: "7001" }), 1);
    assert.equal(await SupportTicketMessage.countDocuments({ dedupeKey }), 1);
    assert.equal(new Set(results.map((r) => r.value.ticket.ticketId)).size, 1, "every twin resolves to the same ticket");
  });

  skip("the same reply submitted concurrently is stored and counted once", async () => {
    const id = await openTicket();
    const dedupeKey = key("web-twin");
    const results = await Promise.all(Array.from({ length: 5 }, () => adminSays(id, "twin", dedupeKey)));
    assert.equal(results.filter((r) => !r.duplicate).length, 1);
    assert.equal(await SupportTicketMessage.countDocuments({ dedupeKey }), 1);
    assert.equal((await row(id)).messageCount, 2);
  });
});

describe("history and live cursors with real ObjectIds", () => {
  skip("newest page first, older pages continue without gaps or overlap, live cursor returns only what is new", async () => {
    const id = await openTicket(ALICE, "m0");
    for (let i = 1; i < 55; i += 1) await (i % 2 ? adminSays(id, `m${i}`) : customerSays(id, `m${i}`));
    const first = await tickets.getAdminTicket({ ticketId: id, limit: 20, markRead: false });
    assert.equal(first.messages.length, 20);
    assert.equal(first.hasOlder, true);
    assert.equal(first.messages.at(-1).text, "m54");
    const second = await tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: first.oldestCursor, limit: 20 });
    const third = await tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: second.oldestCursor, limit: 20 });
    assert.equal(second.hasOlder, true);
    assert.equal(third.messages.length, 15);
    assert.equal(third.hasOlder, false);
    const all = [...third.messages, ...second.messages, ...first.messages];
    assert.deepEqual(all.map((m) => m.text), Array.from({ length: 55 }, (_, i) => `m${i}`));
    assert.equal(new Set(all.map((m) => m.id)).size, 55);

    await customerSays(id, "late");
    const live = await tickets.getTicketUpdates({ audience: "admin", ticketId: id, afterId: first.cursor });
    assert.deepEqual(live.messages.map((m) => m.text), ["late"]);
    assert.deepEqual((await tickets.getTicketUpdates({ audience: "admin", ticketId: id, afterId: live.cursor })).messages, []);
  });

  skip("a malformed cursor is refused, never interpreted as a query", async () => {
    const id = await openTicket();
    await assert.rejects(tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: { $ne: null } }), { code: "invalid_cursor" });
    await assert.rejects(tickets.listTicketMessages({ audience: "admin", ticketId: id, beforeId: "zz" }), { code: "invalid_cursor" });
  });

  skip("marking read is compare-and-set: unread is cleared on screen, a message arriving mid-way stays unread", async () => {
    const id = await openTicket();
    const snapshot = await tickets.getTicketUpdates({ audience: "admin", ticketId: id });
    assert.equal(snapshot.ticket.unread, 1);
    const cleared = await tickets.getTicketUpdates({ audience: "admin", ticketId: id, markRead: true });
    assert.equal(cleared.ticket.unread, 0);
    await customerSays(id, "new");
    assert.equal((await row(id)).unreadForAdmin, 1);
  });
});

describe("legacy statuses on real Mongo", () => {
  skip("pending / resolved rows read as the canonical statuses, resolved is closed, and the migration rewrites them once", async () => {
    const base = (extra) => ({
      ticketId: `T-L${[...String(++seq)].map((d) => "ABCDEFGHJK"[Number(d)]).join("").padStart(5, "A")}`, userTelegramId: "8001", subject: "legacy", channel: "telegram",
      lastMessageAt: new Date(), lastMessageBy: "customer", unreadForAdmin: 0, unreadForCustomer: 0, messageCount: 0,
      closedAt: null, closedBy: null, createdAt: new Date(), updatedAt: new Date("2026-01-02T03:04:05Z"), ...extra,
    });
    const pending = base({ status: "pending" });
    const resolved = base({ status: "resolved" });
    // Bypass schema validation: these values predate the enum.
    await SupportTicket.collection.insertMany([pending, resolved]);

    const detail = await tickets.getAdminTicket({ ticketId: pending.ticketId, markRead: false });
    assert.equal(detail.ticket.status, "pending_customer");
    assert.equal((await tickets.getAdminTicket({ ticketId: resolved.ticketId, markRead: false })).ticket.status, "closed");
    const byStatus = async (status) => (await tickets.listAdminTickets({ status, query: "8001" })).tickets.map((t) => t.ticketId);
    assert.deepEqual(await byStatus("pending_customer"), [pending.ticketId]);
    assert.deepEqual(await byStatus("closed"), [resolved.ticketId]);
    await assert.rejects(workflow.customerReply({ userId: "8001", ticketId: resolved.ticketId, text: "hi", dedupeKey: key("legacy") }), { code: "ticket_closed" });
    await assert.rejects(workflow.customerSetStatus({ userId: "8001", ticketId: resolved.ticketId, status: "open" }), { code: "reopen_not_allowed" });

    const first = await tickets.migrateLegacyTicketStatuses();
    assert.ok(first.pending >= 1 && first.resolved >= 1, JSON.stringify(first));
    const migrated = await SupportTicket.collection.findOne({ ticketId: resolved.ticketId });
    assert.equal(migrated.status, "closed");
    assert.deepEqual(migrated.closedAt, new Date("2026-01-02T03:04:05Z"), "closedAt back-filled from the last update");
    assert.equal(migrated.closedBy, "admin");
    assert.equal((await SupportTicket.collection.findOne({ ticketId: pending.ticketId })).status, "pending_customer");
    assert.deepEqual(await tickets.migrateLegacyTicketStatuses(), { pending: 0, resolved: 0 });
  });
});

describe("admin service with the real audit log", () => {
  skip("close is idempotent across operations, replays by operationId, and failures are English", async () => {
    const id = await openTicket();
    const ctx = { actorId: ADMIN, ticketId: id, bot };
    const first = await adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "closed" });
    const second = await adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "closed" });
    assert.deepEqual([first.status, first.changed, second.status, second.changed], ["closed", true, "closed", false]);
    const sameOp = OP();
    const other = await openTicket();
    await adminTickets.setSupportTicketStatus({ ...ctx, ticketId: other, operationId: sameOp, status: "closed" });
    assert.equal((await adminTickets.setSupportTicketStatus({ ...ctx, ticketId: other, operationId: sameOp, status: "closed" })).replayed, true);
    assert.equal(await AdminAuditLog.countDocuments({ operationId: sameOp }), 1);

    for (const [work, code] of [
      [async () => adminTickets.replyToSupportTicket({ ...ctx, operationId: OP(), text: "late" }), "ticket_closed"],
      [async () => adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "open" }), "reopen_not_allowed"],
      [async () => adminTickets.setSupportTicketStatus({ ...ctx, operationId: OP(), status: "resolved" }), "invalid_status"],
    ]) {
      await assert.rejects(work(), (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.safeMessage, PERSIAN, `${code}: ${error.safeMessage}`);
        return true;
      });
    }
    assert.equal(await count(id), 1);
  });
});

describe("listing", () => {
  skip("unread totals, attention count and ordering (newest activity first)", async () => {
    const a = await openTicket("6001", "first");
    const b = await openTicket("6001", "second");
    await customerSays(a, "bump", "6001");
    const list = await tickets.listAdminTickets({ query: "6001" });
    assert.deepEqual(list.tickets.map((t) => t.ticketId), [a, b]);
    assert.equal(list.total, 2);
    assert.ok(list.unreadTotal >= 2 && list.needsAttention >= 2);
    await tickets.getAdminTicket({ ticketId: a });
    const after = await tickets.listAdminTickets({ query: "6001", unreadOnly: true });
    assert.deepEqual(after.tickets.map((t) => t.ticketId), [b]);
  });
});

describe("ticket creation on real Mongo", () => {
  const restores = [];
  const failOnce = (model, method, matcher = () => true) => {
    const real = model[method];
    restores.push(() => { model[method] = real; });
    let fired = false;
    model[method] = function patched(...args) {
      if (!fired && matcher(...args)) { fired = true; throw Object.assign(new Error("injected failure"), { code: "EINJECTED" }); }
      return real.apply(this, args);
    };
  };
  afterEach(() => { while (restores.length) restores.pop()(); });
  const open = (userId, dedupeKey, text = "hello") => workflow.customerOpenTicket({ bot, userId, text, dedupeKey, channel: "telegram" });
  const rowsOf = (userId) => SupportTicket.find({ userTelegramId: userId }).lean();

  skip("the createKey index is unique and sparse, so legacy tickets without it coexist", async () => {
    const indexes = await SupportTicket.collection.indexes();
    const index = indexes.find((entry) => entry.name === "idx_ticket_create_key");
    assert.ok(index?.unique && index?.sparse);
    await SupportTicket.collection.insertMany([
      { ticketId: "T-LEGAC1", userTelegramId: "5", subject: "a", status: "open" },
      { ticketId: "T-LEGAC2", userTelegramId: "5", subject: "b", status: "open" },
    ]);
    assert.equal(await SupportTicket.countDocuments({ userTelegramId: "5" }), 2);
  });

  skip("a failed first-message write leaves nothing, and the retry creates exactly one ticket", async () => {
    const dedupeKey = key("tg");
    failOnce(SupportTicketMessage, "create");
    await assert.rejects(open("6001", dedupeKey), { code: "EINJECTED" });
    assert.equal((await rowsOf("6001")).length, 0);
    const retry = await open("6001", dedupeKey);
    assert.equal(retry.created, true);
    assert.equal(await count(retry.ticket.ticketId), 1);
  });

  skip("a crash that loses the cleanup leaves an invisible ticket; the retry finishes that same ticket", async () => {
    const dedupeKey = key("tg");
    failOnce(SupportTicketMessage, "create");
    failOnce(SupportTicket, "deleteOne");
    await assert.rejects(open("6002", dedupeKey), { code: "EINJECTED" });
    const [hidden] = await rowsOf("6002");
    assert.equal(hidden.provisional, true);
    assert.deepEqual(await tickets.listCustomerTickets({ userId: "6002" }), []);
    assert.equal((await tickets.listAdminTickets({})).total, 0);
    const retry = await open("6002", dedupeKey);
    assert.equal(retry.ticket.ticketId, hidden.ticketId);
    assert.equal(retry.created, true);
    assert.equal((await rowsOf("6002")).length, 1);
    assert.equal(await count(hidden.ticketId), 1);
    const fixed = await row(hidden.ticketId);
    assert.deepEqual([fixed.provisional, fixed.messageCount, fixed.unreadForAdmin], [false, 1, 1]);
  });

  skip("a crash after the message row but before the ticket is visible is completed without a duplicate", async () => {
    const dedupeKey = key("tg");
    failOnce(SupportTicket, "findOneAndUpdate", (filter, update) => update.$set?.provisional === false);
    await assert.rejects(open("6003", dedupeKey), { code: "EINJECTED" });
    const [hidden] = await rowsOf("6003");
    assert.equal(await count(hidden.ticketId), 1);
    assert.deepEqual(await tickets.listCustomerTickets({ userId: "6003" }), []);
    const retry = await open("6003", dedupeKey);
    assert.equal(retry.ticket.ticketId, hidden.ticketId);
    assert.equal(await count(hidden.ticketId), 1);
    assert.equal((await row(hidden.ticketId)).messageCount, 1);
  });

  skip("an abandoned hidden ticket past the grace period is removed (or activated if its message landed)", async () => {
    const old = new Date(Date.now() - tickets.PROVISIONAL_GRACE_MS - 5000);
    await SupportTicket.collection.insertMany([
      { ticketId: "T-ABAND1", userTelegramId: "6004", subject: "x", status: "open", provisional: true, createKey: "k-abandoned", createdAt: old },
      { ticketId: "T-LANDE1", userTelegramId: "6004", subject: "y", status: "open", provisional: true, createKey: "k-landed", createdAt: old },
    ]);
    await SupportTicketMessage.collection.insertOne({ ticketId: "T-LANDE1", author: "customer", text: "stored", dedupeKey: "k-landed", createdAt: old });
    await open("6004", key("tg"));
    assert.equal(await row("T-ABAND1"), null);
    const landed = await row("T-LANDE1");
    assert.deepEqual([landed.provisional, landed.messageCount, landed.unreadForAdmin], [false, 1, 1]);
  });

  skip("simultaneous twins converge on one ticket and one message, with exactly one creator and no duplicate-key error", async () => {
    for (let round = 0; round < 5; round += 1) {
      const dedupeKey = key("race");
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => open("6005", dedupeKey)));
      assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message)));
      assert.equal(results.filter((r) => r.value.created).length, 1);
      assert.equal(new Set(results.map((r) => r.value.ticket.ticketId)).size, 1);
      assert.equal(await SupportTicketMessage.countDocuments({ dedupeKey }), 1);
    }
    assert.equal((await rowsOf("6005")).length, 5);
    assert.ok((await rowsOf("6005")).every((t) => !t.provisional && t.messageCount === 1 && t.unreadForAdmin === 1));
  });

  skip("the same event from two users yields one ticket for the winner and ticket_not_found for the other", async () => {
    const dedupeKey = key("shared");
    const results = await Promise.allSettled([open("6006", dedupeKey), open("6007", dedupeKey)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason?.code === "ticket_not_found"));
    assert.equal((await rowsOf("6006")).length + (await rowsOf("6007")).length, 1);
  });

  skip("different users creating simultaneously each get exactly one ticket", async () => {
    const users = Array.from({ length: 12 }, (_, i) => String(6100 + i));
    const results = await Promise.all(users.map((u) => open(u, key("tg"))));
    assert.ok(results.every((r) => r.created));
    for (const u of users) assert.equal((await rowsOf(u)).length, 1);
  });

  skip("simultaneous creates by one user never exceed the open-ticket cap and leave no hidden tickets", async () => {
    const cap = tickets.MAX_OPEN_TICKETS_PER_USER;
    for (let round = 0; round < 4; round += 1) {
      const user = String(6200 + round);
      const results = await Promise.allSettled(Array.from({ length: cap * 3 }, () => open(user, key("tg"))));
      const failed = results.filter((r) => r.status === "rejected");
      assert.ok(failed.every((r) => r.reason?.code === "too_many_open_tickets"), JSON.stringify(failed.map((r) => r.reason?.message)));
      const stored = await rowsOf(user);
      assert.ok(stored.length >= 1 && stored.length <= cap, `stored ${stored.length}`);
      assert.equal(stored.length, results.length - failed.length);
      for (const t of stored) { assert.equal(t.provisional, false); assert.equal(await count(t.ticketId), 1); }
    }
  });

  skip("the cap still refuses the next ticket when full and frees a slot when one closes", async () => {
    const ids = [];
    for (let i = 0; i < tickets.MAX_OPEN_TICKETS_PER_USER; i += 1) ids.push((await open("6300", key("tg"))).ticket.ticketId);
    await assert.rejects(open("6300", key("tg")), { code: "too_many_open_tickets" });
    assert.equal((await rowsOf("6300")).length, tickets.MAX_OPEN_TICKETS_PER_USER);
    await closeAsAdmin(ids[0]);
    assert.equal((await open("6300", key("tg"))).created, true);
  });

  skip("a failed message insert leaves status and counters untouched; a crash before the status update is repaired by the retry", async () => {
    const id = await openTicket();
    const before = await row(id);
    failOnce(SupportTicketMessage, "create");
    await assert.rejects(adminSays(id, "answer"), { code: "EINJECTED" });
    const after = await row(id);
    for (const field of ["status", "lastMessageBy", "unreadForAdmin", "unreadForCustomer", "messageCount"]) assert.deepEqual(after[field], before[field], field);
    const dedupeKey = key("web");
    failOnce(SupportTicket, "updateOne", (filter, update) => update.$set?.lastMessageBy === "admin");
    await assert.rejects(adminSays(id, "answer", dedupeKey), { code: "EINJECTED" });
    assert.equal((await row(id)).status, "open");
    assert.equal(await count(id), 2);
    assert.equal((await adminSays(id, "answer", dedupeKey)).duplicate, true);
    const repaired = await row(id);
    assert.deepEqual([repaired.status, repaired.lastMessageBy, repaired.messageCount], ["pending_customer", "admin", 2]);
    assert.equal(await count(id), 2);
  });
});

describe("cap and crash recovery on real Mongo (scripted interleavings)", () => {
  const realEnv = () => ({ Ticket: SupportTicket, Message: SupportTicketMessage, tickets, workflow, bot, userBase: 8_000_000 });
  for (const [index, name] of CAP_SCENARIO_NAMES.entries()) skip(name, () => runCapScenario(realEnv(), index));
  skip("a failed-create cleanup racing a twin that stored the message loses nothing acknowledged", () => cleanupVersusTwin(realEnv()));
  for (const [index, name] of RECOVERY_SCENARIO_NAMES.entries()) skip(name, () => runRecoveryScenario(realEnv(), index));
});

describe("indexes and existing tickets on real Mongo", () => {
  skip("tickets created before this change (no provisional / createKey / lastMessageId) are listed, read, answered and closed unchanged", async () => {
    const at = new Date(Date.now() - 3600_000);
    await SupportTicket.collection.insertOne({ ticketId: "T-LEGACY", userTelegramId: "9101", subject: "legacy", status: "open", channel: "telegram", lastMessageAt: at, lastMessageBy: "customer", unreadForAdmin: 1, unreadForCustomer: 0, messageCount: 1, createdAt: at, updatedAt: at });
    await SupportTicketMessage.collection.insertOne({ ticketId: "T-LEGACY", author: "customer", text: "old message", dedupeKey: "legacy-1", createdAt: at });
    assert.equal((await tickets.listCustomerTickets({ userId: "9101" })).length, 1);
    assert.equal((await tickets.listAdminTickets({})).total, 1);
    const read = await tickets.getAdminTicket({ ticketId: "T-LEGACY", markRead: false });
    assert.equal(read.ticket.status, "open", "a read never rewrites a ticket that has no lastMessageId");
    assert.equal(read.messages.length, 1);
    await customerSays("T-LEGACY", "still me", "9101");
    const answered = await adminSays("T-LEGACY", "answer");
    assert.equal(answered.ticket.status, "pending_customer");
    assert.equal((await row("T-LEGACY")).messageCount, 3);
    await closeAsAdmin("T-LEGACY");
    assert.equal((await row("T-LEGACY")).status, "closed");
    // They still count toward the cap like any other open ticket.
    for (let i = 0; i < tickets.MAX_OPEN_TICKETS_PER_USER - 1; i += 1) await workflow.customerOpenTicket({ bot, userId: "9102", text: "x", dedupeKey: key("fill"), channel: "telegram" });
    await SupportTicket.collection.insertOne({ ticketId: "T-OLDTWO", userTelegramId: "9102", subject: "legacy", status: "open", createdAt: at, updatedAt: at, lastMessageAt: at });
    await assert.rejects(workflow.customerOpenTicket({ bot, userId: "9102", text: "x", dedupeKey: key("over"), channel: "telegram" }), { code: "too_many_open_tickets" });
  });

  skip("the cap count is pinned to the owner index and still works when that index is missing", async () => {
    const hints = [];
    const real = SupportTicket.countDocuments;
    SupportTicket.countDocuments = function spy(filter, options) { hints.push(options?.hint); return real.call(this, filter, options); };
    try {
      await workflow.customerOpenTicket({ bot, userId: "9201", text: "x", dedupeKey: key("hint"), channel: "telegram" });
    } finally { SupportTicket.countDocuments = real; }
    assert.ok(hints.length > 0 && hints.every((hint) => hint === "userTelegramId_1"));
    await SupportTicket.collection.dropIndex("userTelegramId_1");
    try {
      const created = await workflow.customerOpenTicket({ bot, userId: "9201", text: "y", dedupeKey: key("nohint"), channel: "telegram" });
      assert.equal(created.created, true, "the hint is rejected by MongoDB and the plain count is used");
      await assert.rejects(SupportTicket.countDocuments({ userTelegramId: "9201" }, { hint: "userTelegramId_1" }), (error) => error?.code === 2 || error?.codeName === "BadValue");
    } finally {
      await SupportTicket.syncIndexes();
    }
    assert.ok((await SupportTicket.collection.indexes()).some((entry) => entry.name === "userTelegramId_1"));
  });

  skip("without the createKey index duplicates still cannot produce two messages or two visible tickets, and the index can be rebuilt", async () => {
    await SupportTicket.collection.dropIndex("idx_ticket_create_key");
    const dedupeKey = key("noindex");
    try {
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => workflow.customerOpenTicket({ bot, userId: "9301", text: "once", dedupeKey, channel: "telegram" })));
      for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof tickets.SupportError, `raw error leaked: ${r.reason?.message}`);
      // Degraded mode has no single-winner guarantee for the race itself (every twin may get a retryable error),
      // so convergence is asserted on retry: a few retries must end in exactly one ticket and one message.
      let retry = null;
      for (let attempt = 0; attempt < 5 && !retry; attempt += 1) {
        retry = await workflow.customerOpenTicket({ bot, userId: "9301", text: "once", dedupeKey, channel: "telegram" }).catch((error) => {
          assert.ok(error instanceof tickets.SupportError, `raw error leaked: ${error?.message}`);
          return null;
        });
      }
      assert.ok(retry, "retries converge");
      assert.equal(await SupportTicketMessage.countDocuments({ dedupeKey }), 1);
      const rows = await SupportTicket.find({ userTelegramId: "9301" }).lean();
      const visible = rows.filter((t) => !t.provisional);
      assert.equal(visible.length, 1, "exactly one visible ticket");
      assert.equal(retry.ticket.ticketId, visible[0].ticketId);
      await SupportTicket.deleteMany({ userTelegramId: "9301", provisional: true });
    } finally {
      await SupportTicket.syncIndexes();
    }
    const index = (await SupportTicket.collection.indexes()).find((entry) => entry.name === "idx_ticket_create_key");
    assert.ok(index?.unique && index?.sparse, "the unique sparse index was rebuilt");
  });

  skip("a duplicate createKey is rejected by the index itself, never stored", async () => {
    await SupportTicket.create({ ticketId: "T-DUPKEY", userTelegramId: "9401", subject: "x", provisional: true, createKey: "same-key" });
    await assert.rejects(SupportTicket.create({ ticketId: "T-DUPKE2", userTelegramId: "9401", subject: "x", provisional: true, createKey: "same-key" }), (error) => error?.code === 11000);
  });
});
