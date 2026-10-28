/**
 * Ticket deletion: the 72-hour eligibility rule, single and bulk deletion,
 * and the owner-only "clear all history". In-memory models: no database, no
 * Telegram. Closing is final in this app (nobody reopens), so "reopened"
 * can only mean a ticket that is not closed.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSupportDeps, makeFakeBot, makeSessionClient, makeFakeModel } from "../helpers/fakeSupport.js";
import { makeAuditModel } from "../helpers/fakeAuditModel.js";

process.env.ADMINS = "9001,9002";
delete process.env.OWNER_TELEGRAM_ID; // owner = first ADMINS entry = 9001
delete process.env.SUPPORT_GROUP_ALERTS;

const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const retention = await import("../../services/support/retention.js");
const deletion = await import("../../services/support/deletion.js");
const adminTickets = await import("../../services/admin/tickets.js");
const { setSessionClientForTests, clearSessionClientForTests } = await import("../../config/sessionStore.js");

const OWNER = "9001";
const OTHER_ADMIN = "9002";
const HOUR = 3_600_000;
const PHRASE = deletion.CLEAR_CONFIRMATION_PHRASE;
let deps;
let bot;
let audit;
let seq = 0;
const key = (prefix) => `${prefix}:${++seq}`;
const OP = () => `op-${String(++seq).padStart(16, "0")}`;
const row = (ticketId) => deps.Ticket.docs.find((t) => t.ticketId === ticketId);
const messagesOf = (ticketId) => deps.Message.docs.filter((m) => m.ticketId === ticketId);

beforeEach(() => {
  deps = makeSupportDeps();
  tickets.setSupportModelsForTests(deps);
  setSessionClientForTests(makeSessionClient());
  bot = makeFakeBot();
  audit = makeAuditModel();
  delete process.env.SUPPORT_GROUP_ALERTS;
});
afterEach(() => {
  tickets.clearSupportModelsForTests();
  clearSessionClientForTests();
});

let userSeq = 2000;
const openTicket = async (userId = ++userSeq) =>
  (await workflow.customerOpenTicket({ bot, userId, text: "private customer text", dedupeKey: key("open"), channel: "telegram" })).ticket.ticketId;

/** A ticket closed through the real code path, then back-dated so its closing time is `hoursAgo` ago. */
async function closedTicket(hoursAgo) {
  const id = await openTicket();
  await workflow.adminReply({ bot, adminId: OWNER, ticketId: id, text: "reply", dedupeKey: key("web") });
  await workflow.adminSetStatus({ bot, ticketId: id, status: "closed", adminId: OWNER });
  row(id).closedAt = new Date(Date.now() - hoursAgo * HOUR);
  return id;
}
const del = (ticketIds, actorId = OTHER_ADMIN, operationId = OP()) => adminTickets.deleteSupportTickets({ actorId, operationId, ticketIds, auditModel: audit });
const clear = (overrides = {}) => adminTickets.clearSupportHistory({ actorId: OWNER, operationId: OP(), confirmation: PHRASE, auditModel: audit, ...overrides });

describe("eligibility", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  const closedAt = (ms) => new Date(now.getTime() - ms);
  const verdict = (ticket) => retention.ticketDeletionEligibility({ status: "closed", ...ticket }, now);

  test("closed 71h59m ago is not eligible", () => {
    const v = verdict({ closedAt: closedAt(72 * HOUR - 60_000) });
    assert.equal(v.eligible, false);
    assert.equal(v.reason, "retention_not_elapsed");
    assert.equal(v.eligibleAt.getTime(), now.getTime() + 60_000);
  });
  test("closed exactly 72h ago is eligible", () => {
    assert.equal(verdict({ closedAt: closedAt(72 * HOUR) }).eligible, true);
  });
  test("one millisecond short is not eligible; days later is", () => {
    assert.equal(verdict({ closedAt: closedAt(72 * HOUR - 1) }).eligible, false);
    assert.equal(verdict({ closedAt: closedAt(30 * 24 * HOUR) }).eligible, true);
  });
  test("open and pending tickets are never eligible, however old", () => {
    for (const status of ["open", "pending_customer"]) {
      const v = retention.ticketDeletionEligibility({ status, closedAt: closedAt(999 * HOUR) }, now);
      assert.deepEqual([v.eligible, v.reason], [false, "not_closed"]);
    }
  });
  test("a closed ticket with no closing time is never guessed eligible (legacy data)", () => {
    for (const closed of [null, undefined, "garbage"]) {
      const v = verdict({ closedAt: closed, createdAt: closedAt(999 * HOUR), lastMessageAt: closedAt(999 * HOUR) });
      assert.deepEqual([v.eligible, v.reason], [false, "closed_time_unknown"]);
    }
  });
  test("the legacy alias 'resolved' counts as closed", () => {
    assert.equal(verdict({ status: "resolved", closedAt: closedAt(100 * HOUR) }).eligible, true);
  });
  test("admin views expose deletable/deletableAt; customer views do not", async () => {
    const id = await closedTicket(80);
    const admin = await tickets.getAdminTicket({ ticketId: id });
    assert.equal(admin.ticket.deletable, true);
    assert.ok(admin.ticket.deletableAt);
    const fresh = await closedTicket(1);
    assert.equal((await tickets.getAdminTicket({ ticketId: fresh })).ticket.deletable, false);
  });
  test("closing records closedAt (the clock the rule uses)", async () => {
    const id = await openTicket();
    assert.equal(row(id).closedAt, null);
    await workflow.adminSetStatus({ bot, ticketId: id, status: "closed", adminId: OWNER });
    assert.ok(row(id).closedAt instanceof Date);
  });
});

describe("single and bulk deletion", () => {
  test("an old closed ticket and all its messages are deleted; other tickets are untouched", async () => {
    const id = await closedTicket(73);
    const keep = await closedTicket(1);
    assert.ok(messagesOf(id).length >= 2);
    const result = await del([id]);
    assert.deepEqual([result.deleted, result.deletedIds], [1, [id]]);
    assert.equal(row(id), undefined);
    assert.equal(messagesOf(id).length, 0);
    assert.ok(row(keep));
    assert.ok(messagesOf(keep).length >= 2);
  });

  test("a ticket closed 71h59m ago cannot be deleted (409, nothing removed)", async () => {
    const id = await closedTicket(72 - 1 / 60);
    await assert.rejects(del([id]), (error) => error.status === 409 && /72 hours/.test(error.message));
    assert.ok(row(id));
    assert.ok(messagesOf(id).length > 0);
  });

  test("an open ticket cannot be deleted singly or in bulk", async () => {
    const id = await openTicket();
    await assert.rejects(del([id]), (error) => error.status === 409);
    const bulk = await del([id, await closedTicket(100)]);
    assert.equal(bulk.deleted, 1);
    assert.deepEqual(bulk.skipped.map((s) => [s.ticketId, s.reason]), [[id, "not_closed"]]);
    assert.ok(row(id));
  });

  test("a closed ticket with no closing time is refused", async () => {
    const id = await closedTicket(500);
    row(id).closedAt = null;
    await assert.rejects(del([id]), (error) => error.status === 409 && /no recorded closing time/.test(error.message));
    assert.ok(row(id));
  });

  test("stale selection: eligibility is re-read at delete time, not trusted from the client", async () => {
    const id = await closedTicket(73);
    assert.equal((await tickets.getAdminTicket({ ticketId: id })).ticket.deletable, true);
    // Between listing and confirming, the ticket stops qualifying (e.g. its closing time is corrected/moved).
    row(id).closedAt = new Date();
    await assert.rejects(del([id]), (error) => error.status === 409);
    assert.ok(row(id));
  });

  test("the conditional delete itself refuses when the ticket changes after the check", async () => {
    const id = await closedTicket(73);
    const original = deps.Ticket.deleteOne;
    deps.Ticket.deleteOne = async (filter) => { row(id).closedAt = new Date(); return original(filter); };
    const result = await deletion.deleteTickets({ ticketIds: [id] });
    assert.deepEqual(result.skipped, [{ ticketId: id, reason: "changed" }]);
    assert.ok(row(id));
    assert.ok(messagesOf(id).length > 0);
  });

  test("bulk: eligible deleted, ineligible/missing/invalid/duplicate reported, counts add up", async () => {
    const a = await closedTicket(100);
    const b = await closedTicket(200);
    const young = await closedTicket(2);
    const result = await del([a, b, young, "T-ZZZZZZ", "not-an-id", a]);
    assert.equal(result.requested, 5); // the duplicate is collapsed
    assert.deepEqual(result.deletedIds.sort(), [a, b].sort());
    assert.deepEqual(result.skipped.map((s) => s.reason).sort(), ["invalid_id", "not_found", "retention_not_elapsed"]);
    assert.deepEqual(result.failed, []);
    assert.ok(row(young));
  });

  test("bulk requests are bounded and must name tickets: empty, oversized, non-array and non-string are rejected", async () => {
    for (const bad of [undefined, null, [], "T-AAAAAA", [{}], [null], Array.from({ length: deletion.MAX_BULK_DELETE + 1 }, (_, i) => `T-${i}`)]) {
      await assert.rejects(del(bad), (error) => error.status === 400);
    }
    // An empty/odd selection never reaches the clear-all path.
    await openTicket();
    assert.equal(deps.Ticket.docs.length, 1);
  });

  test("a failing message delete is reported as failed, and a retry cleans the orphans", async () => {
    const id = await closedTicket(100);
    const original = deps.Message.deleteMany;
    deps.Message.deleteMany = async () => { throw new Error("db down"); };
    const first = await deletion.deleteTickets({ ticketIds: [id] });
    assert.equal(first.deleted, 0);
    assert.deepEqual(first.failed, [{ ticketId: id }]);
    deps.Message.deleteMany = original;
    assert.ok(messagesOf(id).length > 0); // orphaned: ticket row gone
    const retry = await deletion.deleteTickets({ ticketIds: [id] });
    assert.equal(retry.skipped[0].reason, "not_found");
    assert.equal(messagesOf(id).length, 0);
  });

  test("single delete with a database failure surfaces an error, not success", async () => {
    const id = await closedTicket(100);
    deps.Ticket.deleteOne = async () => { throw new Error("db down"); };
    await assert.rejects(del([id]), (error) => error.status === 503 && error.code === "delete_failed");
  });

  test("authorization: users and non-admins cannot delete; nothing is removed or audited", async () => {
    const id = await closedTicket(100);
    for (const actorId of ["1001", "", null, undefined, "abc", "9003"]) {
      await assert.rejects(adminTickets.deleteSupportTickets({ actorId, operationId: OP(), ticketIds: [id], auditModel: audit }), (error) => error.status === 403);
    }
    assert.ok(row(id));
    assert.equal(audit.docs.size, 0);
  });

  test("duplicate submission with the same operation id is replayed, not re-executed", async () => {
    const id = await closedTicket(100);
    const operationId = OP();
    const first = await del([id], OTHER_ADMIN, operationId);
    const again = await del([id], OTHER_ADMIN, operationId);
    assert.equal(first.deleted, 1);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.deletedIds, [id]);
  });

  test("audit: records actor/type/ids, never message text; failures are audited as failed", async () => {
    const id = await closedTicket(100);
    const young = await closedTicket(1);
    await del([id, young]);
    await assert.rejects(del([young]));
    const rows = [...audit.docs.values()];
    const bulk = rows.find((r) => r.action === "TICKET_BULK_DELETE");
    const single = rows.find((r) => r.action === "TICKET_DELETE");
    assert.equal(bulk.actorTelegramId, OTHER_ADMIN);
    assert.equal(bulk.status, "succeeded");
    assert.deepEqual(bulk.result.deletedIds, [id]);
    assert.equal(single.status, "failed");
    assert.equal(single.targetId, young);
    assert.ok(!JSON.stringify(rows).includes("private customer text"));
  });

  test("audit unavailable: nothing is deleted", async () => {
    const id = await closedTicket(100);
    audit.state.failCreate = true;
    await assert.rejects(del([id]), (error) => error.code === "audit_unavailable");
    assert.ok(row(id));
  });

  test("normal ticket flows are unchanged: reply, close, and closed-is-final still behave", async () => {
    const id = await openTicket();
    await workflow.adminReply({ bot, adminId: OWNER, ticketId: id, text: "hi", dedupeKey: key("web") });
    assert.equal(row(id).status, "pending_customer");
    await workflow.adminSetStatus({ bot, ticketId: id, status: "closed", adminId: OWNER });
    await assert.rejects(workflow.adminSetStatus({ bot, ticketId: id, status: "open", adminId: OWNER }), (error) => error.code === "reopen_not_allowed");
    assert.equal(row(id).status, "closed");
    const list = await adminTickets.listSupportTickets({ actorId: OTHER_ADMIN });
    assert.equal(list.canClearHistory, false);
    assert.equal((await adminTickets.listSupportTickets({ actorId: OWNER })).canClearHistory, true);
  });
});

describe("clear all ticket history", () => {
  /** Stand-ins for collections that must survive. */
  const bystanders = () => ({ users: makeFakeModel(), payments: makeFakeModel(), wallets: makeFakeModel() });

  test("removes every ticket (open and closed) and message, keeps unrelated data and audit logs", async () => {
    const other = bystanders();
    for (const model of Object.values(other)) await model.create({ keep: true });
    await openTicket();
    await closedTicket(1);
    await closedTicket(500);
    await adminTickets.deleteSupportTickets({ actorId: OWNER, operationId: OP(), ticketIds: [await closedTicket(100)], auditModel: audit });
    const auditBefore = audit.docs.size;

    const result = await clear();
    assert.equal(result.complete, true);
    assert.equal(result.remaining, 0);
    assert.equal(result.deletedTickets, 3);
    assert.equal(deps.Ticket.docs.length, 0);
    assert.equal(deps.Message.docs.length, 0);
    for (const model of Object.values(other)) assert.equal(model.docs.length, 1);
    assert.equal(audit.docs.size, auditBefore + 1);
    const entry = [...audit.docs.values()].find((r) => r.action === "TICKET_HISTORY_CLEAR");
    assert.equal(entry.actorTelegramId, OWNER);
    assert.equal(entry.status, "succeeded");
    assert.equal(entry.result.complete, true);
  });

  test("works across many batches and sweeps orphaned messages", async () => {
    for (let i = 0; i < deletion.CLEAR_BATCH_SIZE * 2 + 5; i += 1) {
      await deps.Ticket.create({ ticketId: `T-${i}`, userTelegramId: "1", subject: "s", status: "open" });
      await deps.Message.create({ ticketId: `T-${i}`, author: "customer", dedupeKey: `k${i}` });
    }
    await deps.Message.create({ ticketId: "T-GONE", author: "customer", dedupeKey: "orphan" });
    const result = await clear();
    assert.equal(result.complete, true);
    assert.equal(deps.Ticket.docs.length + deps.Message.docs.length, 0);
  });

  test("owner only: ordinary admins, outsiders and unauthenticated callers are refused", async () => {
    await openTicket();
    for (const actorId of [OTHER_ADMIN, "1001", null, undefined, ""]) {
      await assert.rejects(clear({ actorId }), (error) => error.status === 403);
    }
    assert.equal(deps.Ticket.docs.length, 1);
    assert.equal(audit.docs.size, 0);
  });

  test("missing or malformed confirmation never deletes", async () => {
    await openTicket();
    const bad = [undefined, null, "", "clear all ticket history", " CLEAR ALL TICKET HISTORY", "CLEAR ALL TICKET HISTORY ", true, 1, {}, [PHRASE], "yes"];
    for (const confirmation of bad) {
      await assert.rejects(clear({ confirmation }), (error) => error.status === 400 && error.code === "confirmation_required");
    }
    assert.equal(deps.Ticket.docs.length, 1);
    assert.equal(audit.docs.size, 0);
  });

  test("an ordinary bulk delete (even with an empty or hostile selection) cannot clear history", async () => {
    await openTicket();
    await closedTicket(100);
    for (const ticketIds of [[], undefined, ["*"], [{ $ne: null }], "all"]) await assert.rejects(del(ticketIds, OWNER));
    assert.equal(deps.Ticket.docs.length, 2);
  });

  test("a database failure mid-way is reported as incomplete, never as success; a rerun finishes", async () => {
    for (let i = 0; i < deletion.CLEAR_BATCH_SIZE + 10; i += 1) {
      await deps.Ticket.create({ ticketId: `T-${i}`, userTelegramId: "1", subject: "s", status: "open" });
    }
    const original = deps.Ticket.deleteMany;
    let calls = 0;
    deps.Ticket.deleteMany = async (filter) => { calls += 1; if (calls === 2) throw Object.assign(new Error("db down"), { code: "net_error" }); return original(filter); };
    const first = await clear();
    assert.equal(first.complete, false);
    assert.equal(first.errorCode, "net_error");
    assert.equal(first.remaining, 10);
    assert.equal(first.deletedTickets, deletion.CLEAR_BATCH_SIZE);
    const second = await clear();
    assert.equal(second.complete, true);
    assert.equal(deps.Ticket.docs.length, 0);
  });

  test("a failing verification count is not reported as success", async () => {
    await openTicket();
    deps.Ticket.countDocuments = async () => { throw new Error("db down"); };
    const result = await clear();
    assert.equal(result.complete, false);
    assert.equal(result.remaining, null);
  });

  test("tickets created while it runs are kept and counted, not silently deleted", async () => {
    await openTicket();
    const startedAt = new Date(Date.now() - 1);
    deps.Ticket.docs.push({ _id: "ffffffffffffffffffffffff", ticketId: "T-NEWONE", userTelegramId: "1", subject: "new", status: "open", createdAt: new Date(Date.now() + 60_000) });
    const result = await deletion.clearAllTickets({ startedAt: new Date(Date.now() + 1000) });
    assert.equal(result.complete, true);
    assert.equal(result.newerKept, 1);
    assert.deepEqual(deps.Ticket.docs.map((t) => t.ticketId), ["T-NEWONE"]);
    assert.ok(startedAt);
  });

  test("a second clear while one is running is refused; a replayed operation id does not re-run", async () => {
    await openTicket();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = deps.Ticket.find;
    deps.Ticket.find = (filter) => { const cursor = original.call(deps.Ticket, filter); return { ...cursor, sort: (s) => ({ ...cursor.sort(s), limit: (n) => ({ lean: async () => { await gate; return cursor.sort(s).limit(n).lean(); } }) }) }; };
    const operationId = OP();
    const running = clear({ operationId });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(clear(), (error) => error.status === 409);
    release();
    const done = await running;
    assert.equal(done.complete, true);
    const replay = await clear({ operationId });
    assert.equal(replay.replayed, true);
  });
});
