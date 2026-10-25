/**
 * Crash-recovery scenarios for ticket creation and for regular messages, shared
 * by the in-memory unit tests and the real-MongoDB integration tests. They use
 * only the model API both implement (create / find / updateOne / ...), so the
 * same assertions run against the fakes and against a real database.
 */
import assert from "node:assert/strict";

let sequence = 0;

function build(env) {
  const { Ticket, Message, tickets, workflow, bot } = env;
  const user = () => String(env.userBase + 5000 + ++sequence);
  const key = (prefix) => `${prefix}-rec-${process.pid}-${++sequence}`;
  const open = (userId, dedupeKey) => workflow.customerOpenTicket({ bot, userId, text: "hello", dedupeKey, channel: "telegram" });
  const ticketRows = (userId) => Ticket.find({ userTelegramId: userId }).lean();
  const row = async (ticketId) => (await Ticket.find({ ticketId }).lean())[0];
  const messages = (filter) => Message.find(filter).lean();

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
  const restore = () => { while (restores.length) restores.pop()(); };
  const appliesActivity = (author) => (filter, update) => update.$set?.lastMessageBy === author;

  return {
    restore,
    scenarios: [
      {
        name: "concurrent retries of a create that stored its message but never became visible converge on one ticket and one message",
        async run() {
          const u = user();
          const k = key("tg");
          failOnce(Ticket, "findOneAndUpdate", (filter, update) => update.$set?.provisional === false);
          await assert.rejects(open(u, k), { code: "EINJECTED" });
          restore();
          const [hidden] = await ticketRows(u);
          assert.equal(hidden.provisional, true);
          assert.equal((await messages({ ticketId: hidden.ticketId })).length, 1);
          const results = await Promise.allSettled(Array.from({ length: 8 }, () => open(u, k)));
          assert.ok(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected").map((r) => r.reason?.message)));
          assert.equal(results.filter((r) => r.value.created).length, 1);
          assert.equal(new Set(results.map((r) => r.value.ticket.ticketId)).size, 1);
          assert.equal(results[0].value.ticket.ticketId, hidden.ticketId);
          assert.equal((await ticketRows(u)).length, 1);
          assert.equal((await messages({ dedupeKey: k })).length, 1);
          const fixed = await row(hidden.ticketId);
          assert.deepEqual([fixed.provisional, fixed.messageCount, fixed.unreadForAdmin], [false, 1, 1]);
        },
      },
      {
        name: "concurrent retries over an orphan first message (its ticket is gone) converge on one ticket and one message",
        async run() {
          const u = user();
          const k = key("tg");
          await Message.create({ ticketId: "T-NOTICK", author: "customer", text: "orphan", dedupeKey: k });
          const results = await Promise.allSettled(Array.from({ length: 8 }, () => open(u, k)));
          const failed = results.filter((r) => r.status === "rejected");
          // A twin may hit the window between the orphan being cleared and the ticket being created: retryable, never raw.
          assert.ok(failed.every((r) => r.reason instanceof tickets.SupportError && r.reason.code === "ticket_unavailable"), JSON.stringify(failed.map((r) => r.reason?.message)));
          const retry = await open(u, k);
          assert.ok(retry.ticket.ticketId);
          const rows = await ticketRows(u);
          assert.equal(rows.length, 1);
          assert.equal((await messages({ dedupeKey: k })).length, 1);
          assert.equal((await messages({ ticketId: "T-NOTICK" })).length, 0, "the orphan is gone");
          assert.equal(rows[0].provisional, false);
        },
      },
      {
        name: "abandoned hidden tickets never block the quota: the owner's next create clears them",
        async run() {
          const u = user();
          const old = new Date(Date.now() - tickets.PROVISIONAL_GRACE_MS - 5000);
          for (let i = 0; i < tickets.MAX_OPEN_TICKETS_PER_USER; i += 1) {
            await Ticket.create({ ticketId: `T-DEAD${i}${++sequence}`, userTelegramId: u, subject: "x", status: "open", provisional: true, createKey: key("dead"), createdAt: old, updatedAt: old, lastMessageAt: old });
          }
          assert.equal((await ticketRows(u)).length, tickets.MAX_OPEN_TICKETS_PER_USER);
          const created = await open(u, key("tg"));
          assert.equal(created.created, true);
          const rows = await ticketRows(u);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].provisional, false);
        },
      },
      {
        name: "a customer message stored without its status update is repaired the next time the ticket is read, once",
        async run() {
          const u = user();
          const id = (await open(u, key("tg"))).ticket.ticketId;
          await workflow.adminReply({ bot, adminId: "9001", ticketId: id, text: "answer", dedupeKey: key("web") });
          assert.equal((await row(id)).status, "pending_customer");
          failOnce(Ticket, "updateOne", appliesActivity("customer"));
          await assert.rejects(workflow.customerReply({ userId: u, ticketId: id, text: "more", dedupeKey: key("tg") }), { code: "EINJECTED" });
          restore();
          assert.equal((await row(id)).status, "pending_customer", "stale after the crash");
          const read = await tickets.getAdminTicket({ ticketId: id, markRead: false });
          assert.equal(read.ticket.status, "open");
          assert.equal(read.ticket.lastMessageBy, "customer");
          assert.equal(read.ticket.messageCount, 3);
          assert.ok(read.ticket.unread >= 1);
          const stored = await row(id);
          assert.deepEqual([stored.status, stored.lastMessageBy, stored.messageCount], ["open", "customer", 3]);
          const again = await tickets.getAdminTicket({ ticketId: id, markRead: false });
          assert.equal(again.ticket.unread, read.ticket.unread, "a second read repairs nothing further");
        },
      },
      {
        name: "an admin reply stored without its status update is repaired when the customer reads the ticket",
        async run() {
          const u = user();
          const id = (await open(u, key("tg"))).ticket.ticketId;
          failOnce(Ticket, "updateOne", appliesActivity("admin"));
          await assert.rejects(workflow.adminReply({ bot, adminId: "9001", ticketId: id, text: "answer", dedupeKey: key("web") }), { code: "EINJECTED" });
          restore();
          assert.equal((await row(id)).status, "open");
          const read = await tickets.getCustomerTicket({ userId: u, ticketId: id, markRead: false });
          assert.equal(read.ticket.status, "pending_customer");
          assert.equal(read.ticket.unread, 1);
          assert.equal(read.ticket.messageCount, 2);
        },
      },
      {
        name: "repair never rewinds newer state: a later message wins, a manual status change is kept, a closed ticket stays closed",
        async run() {
          const u = user();
          // Later message wins over an older unapplied one.
          const a = (await open(u, key("tg"))).ticket.ticketId;
          failOnce(Ticket, "updateOne", appliesActivity("customer"));
          const oldKey = key("tg");
          await assert.rejects(workflow.customerReply({ userId: u, ticketId: a, text: "older", dedupeKey: oldKey }), { code: "EINJECTED" });
          restore();
          await workflow.adminReply({ bot, adminId: "9001", ticketId: a, text: "newer", dedupeKey: key("web") });
          assert.equal((await tickets.getAdminTicket({ ticketId: a, markRead: false })).ticket.status, "pending_customer");
          await workflow.customerReply({ userId: u, ticketId: a, text: "older", dedupeKey: oldKey });
          assert.equal((await row(a)).status, "pending_customer", "replaying the older key does not overwrite the newer admin reply");
          // A manual status change is not undone by a read.
          const b = (await open(u, key("tg"))).ticket.ticketId;
          await workflow.adminSetStatus({ bot, ticketId: b, status: "pending_customer", adminId: "9001" });
          assert.equal((await tickets.getAdminTicket({ ticketId: b, markRead: false })).ticket.status, "pending_customer");
          assert.equal((await row(b)).status, "pending_customer");
          // A closed ticket is never touched.
          const c = (await open(u, key("tg"))).ticket.ticketId;
          failOnce(Ticket, "updateOne", appliesActivity("customer"));
          await assert.rejects(workflow.customerReply({ userId: u, ticketId: c, text: "late", dedupeKey: key("tg") }), { code: "EINJECTED" });
          restore();
          await workflow.adminSetStatus({ bot, ticketId: c, status: "closed", adminId: "9001" });
          assert.equal((await tickets.getAdminTicket({ ticketId: c, markRead: false })).ticket.status, "closed");
          assert.equal((await row(c)).status, "closed");
        },
      },
    ],
  };
}

const STUB = { Ticket: null, Message: null, tickets: null, workflow: null, bot: null, userBase: 0 };
export const RECOVERY_SCENARIO_NAMES = build(STUB).scenarios.map((scenario) => scenario.name);
/** Runs one scenario and always removes the failure injections it installed. */
export async function runRecoveryScenario(env, index) {
  const built = build(env);
  try { await built.scenarios[index].run(); } finally { built.restore(); }
}
