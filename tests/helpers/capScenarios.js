/**
 * Scripted interleavings of concurrent ticket creators, shared by the
 * in-memory unit tests and the real-MongoDB integration tests so the same
 * schedules are proven against both. See interleave.js for how a schedule is
 * driven. Every scenario ends by asserting the invariant that matters:
 * the user never has more than MAX non-closed tickets, no hidden ticket
 * survives, and every stored ticket has exactly one first message.
 */
import assert from "node:assert/strict";
import { makeInterleaver } from "./interleave.js";

const MAX = 5;
let sequence = 0;
const fresh = (prefix) => `${prefix}-${process.pid}-${++sequence}`;

/**
 * `env` supplies { Ticket, Message, tickets, workflow, bot, userBase }.
 * Each scenario receives its own user id so scenarios never see each other.
 */
function build(env) {
  const { Ticket, Message, tickets, workflow, bot } = env;
  const nonClosed = async (user) => (await Ticket.find({ userTelegramId: user }).lean()).filter((t) => t.status !== "closed" && t.status !== "resolved");
  const messagesOf = (ticketId) => Message.find({ ticketId }).lean();
  const open = (user, dedupeKey) => workflow.customerOpenTicket({ bot, userId: user, text: "hello", dedupeKey, channel: "telegram" });
  const seed = async (user, n) => { for (let i = 0; i < n; i += 1) await open(user, fresh("seed")); };
  const user = () => String(env.userBase + ++sequence);

  /** Wraps the model operations the schedules gate on; returns the interleaver and an unwrap function. */
  function gated() {
    const inter = makeInterleaver();
    const restores = [];
    inter.wrap(Ticket, "create", "create", restores);
    inter.wrap(Ticket, "countDocuments", "count", restores);
    inter.wrap(Ticket, "deleteOne", "delete", restores);
    inter.wrap(Message, "create", "msg", restores);
    inter.wrap(Message, "countDocuments", "mcount", restores);
    return { inter, unwrap: () => { while (restores.length) restores.pop()(); } };
  }

  async function assertInvariant(u, label) {
    const rows = await Ticket.find({ userTelegramId: u }).lean();
    const live = rows.filter((t) => t.status !== "closed");
    assert.ok(live.length <= MAX, `${label}: ${live.length} non-closed tickets (max ${MAX})`);
    for (const t of rows) {
      assert.ok(!t.provisional, `${label}: hidden ticket ${t.ticketId} survived`);
      assert.equal((await messagesOf(t.ticketId)).length, 1, `${label}: ${t.ticketId} must have exactly one message`);
    }
    return rows;
  }

  const isSupportError = (error) => error instanceof tickets.SupportError;

  return [
    {
      name: "A withdraws before B counts: B's decision stands, A's deletion cannot invalidate it",
      async run() {
        const u = user();
        await seed(u, MAX - 1);
        const { inter, unwrap } = gated();
        const A = inter.run("A", () => open(u, "cap-a-1"));
        const B = inter.run("B", () => open(u, "cap-b-1"));
        A.catch(() => {}); B.catch(() => {});
        await inter.step("A:count#1", "B:count#1", "A:create#1", "B:create#1", "A:count#2", "A:delete#1", "B:count#2");
        const results = await inter.finish();
        unwrap();
        assert.equal(results.B.ok, true, "B counted 5 after A left, so it keeps its ticket");
        assert.equal(results.B.value.created, true);
        assert.equal(results.A.ok, false);
        assert.equal(results.A.error.code, "too_many_open_tickets");
        const rows = await assertInvariant(u, "withdraw-then-count");
        assert.equal(rows.length, MAX);
      },
    },
    {
      name: "both count before either withdraws: both back off, never over the cap, no raw errors",
      async run() {
        const u = user();
        await seed(u, MAX - 1);
        const { inter, unwrap } = gated();
        inter.run("A", () => open(u, "cap-a-2")).catch(() => {});
        inter.run("B", () => open(u, "cap-b-2")).catch(() => {});
        await inter.step("A:count#1", "B:count#1", "A:create#1", "B:create#1", "A:count#2", "B:count#2", "A:delete#1", "B:delete#1");
        const results = await inter.finish();
        unwrap();
        for (const r of Object.values(results)) if (!r.ok) assert.ok(isSupportError(r.error) && r.error.code === "too_many_open_tickets", String(r.error?.message));
        await assertInvariant(u, "both-back-off");
      },
    },
    {
      name: "a ticket verified earlier keeps its slot; a later inserter that sees it withdraws",
      async run() {
        const u = user();
        await seed(u, MAX - 1);
        const { inter, unwrap } = gated();
        inter.run("K", () => open(u, "cap-k-3")).catch(() => {});
        inter.run("A", () => open(u, "cap-a-3")).catch(() => {});
        // A passes its cheap pre-check, K completes entirely, then A inserts and must withdraw.
        await inter.step("A:count#1", "K:count#1", "K:create#1", "K:count#2", "K:msg#1", "K:mcount#1", "A:create#1", "A:count#2", "A:delete#1");
        const results = await inter.finish();
        unwrap();
        assert.equal(results.K.ok, true);
        assert.equal(results.A.ok, false);
        assert.equal(results.A.error.code, "too_many_open_tickets");
        assert.equal((await assertInvariant(u, "verified-earlier")).length, MAX);
      },
    },
    {
      name: "a twin of a ticket that is about to be withdrawn cannot make it visible past the cap",
      async run() {
        const u = user();
        await seed(u, MAX - 1);
        const { inter, unwrap } = gated();
        inter.run("C", () => open(u, "cap-c-4")).catch(() => {});
        inter.run("A", () => open(u, "cap-a-4")).catch(() => {});
        // C is verified (5 tickets) and still hidden; A inserts the 6th but has not verified yet.
        await inter.step("A:count#1", "C:count#1", "C:create#1", "C:count#2", "A:create#1");
        // A's twin arrives now. It must verify on its own (6 > 5) rather than trust a creator that has not.
        inter.run("B", () => open(u, "cap-a-4")).catch(() => {});
        // B counts 6 and withdraws A's hidden ticket; only then does A (still unverified) run its own count.
        await inter.step("B:count#1", "B:delete#1", "A:count#2");
        const results = await inter.finish();
        unwrap();
        for (const [name, r] of Object.entries(results)) {
          if (!r.ok) assert.ok(isSupportError(r.error), `${name}: ${r.error?.message}`);
        }
        assert.equal(results.B.ok, false);
        assert.equal(results.B.error.code, "too_many_open_tickets");
        assert.equal(results.C.ok, true, "the verified ticket keeps its slot");
        assert.equal((await assertInvariant(u, "twin-resume")).length, MAX);
        // A's ticket vanished under it; its retry clears the leftover message and is refused cleanly.
        await assert.rejects(open(u, "cap-a-4"), { code: "too_many_open_tickets" });
        assert.equal((await Message.find({ dedupeKey: "cap-a-4" }).lean()).length, 0, "no leftover message for the withdrawn ticket");
      },
    },
    {
      name: "a creator that crashed before verifying cannot be completed by its retry past the cap",
      async run() {
        const u = user();
        await seed(u, MAX - 1);
        const { inter, unwrap } = gated();
        inter.crashAt("A:count#2");
        inter.crashAt("A:delete#1"); // the process dies before its cleanup too
        inter.run("A", () => open(u, "cap-a-5")).catch(() => {});
        inter.run("K", () => open(u, "cap-k-5")).catch(() => {});
        await inter.step("A:count#1", "K:count#1", "K:create#1", "K:count#2", "K:msg#1", "K:mcount#1", "A:create#1", "A:count#2");
        const first = await inter.finish();
        unwrap();
        assert.equal(first.K.ok, true);
        assert.equal(first.A.error.code, "EINJECTED");
        const hidden = (await Ticket.find({ userTelegramId: u }).lean()).filter((t) => t.provisional);
        assert.equal(hidden.length, 1, "A left an unverified hidden ticket counted against the cap");
        // The retry of A's event meets the hidden ticket: it must verify (6 > 5) and withdraw it.
        await assert.rejects(open(u, "cap-a-5"), { code: "too_many_open_tickets" });
        assert.equal((await assertInvariant(u, "crash-before-verify")).length, MAX);
      },
    },
    {
      name: "the recovery sweep withdraws an abandoned ticket over the cap instead of activating it",
      async run() {
        const u = user();
        await seed(u, MAX);
        const old = new Date(Date.now() - tickets.PROVISIONAL_GRACE_MS - 5000);
        const ghost = await Ticket.create({ ticketId: "T-GHOST2", userTelegramId: u, subject: "x", status: "open", provisional: true, createKey: fresh("ghost"), createdAt: old, updatedAt: old, lastMessageAt: old });
        await Message.create({ ticketId: ghost.ticketId, author: "customer", text: "stored", dedupeKey: fresh("ghost-msg"), createdAt: old });
        await assert.rejects(open(u, fresh("next")), { code: "too_many_open_tickets" });
        const rows = await Ticket.find({ userTelegramId: u }).lean();
        assert.equal(rows.length, MAX, "the over-cap abandoned ticket was withdrawn, not activated");
        assert.ok(rows.every((t) => !t.provisional && t.ticketId !== ghost.ticketId));
      },
    },
    {
      name: "the recovery sweep activates an abandoned ticket whose message landed when the cap allows it",
      async run() {
        const u = user();
        await seed(u, MAX - 2);
        const old = new Date(Date.now() - tickets.PROVISIONAL_GRACE_MS - 5000);
        const landed = await Ticket.create({ ticketId: "T-LANDD3", userTelegramId: u, subject: "x", status: "open", provisional: true, createKey: fresh("landed"), createdAt: old, updatedAt: old, lastMessageAt: old });
        await Message.create({ ticketId: landed.ticketId, author: "customer", text: "stored", dedupeKey: fresh("landed-msg"), createdAt: old });
        const created = await open(u, fresh("next"));
        assert.equal(created.created, true);
        const rows = await assertInvariant(u, "sweep-activates");
        assert.equal(rows.length, MAX);
        assert.ok(rows.some((t) => t.ticketId === landed.ticketId));
      },
    },
  ];
}

const STUB = { Ticket: null, Message: null, tickets: null, workflow: null, bot: null, userBase: 0 };
/** Scenario titles, available before any model exists (for registering tests). */
export const CAP_SCENARIO_NAMES = build(STUB).map((scenario) => scenario.name);
export const runCapScenario = (env, index) => build(env)[index].run();

/** Shared by both suites: cleanup of a failed create racing a twin that already stored the message. */
export async function cleanupVersusTwin(env) {
  const { Ticket, Message, tickets, workflow, bot } = env;
  const userId = String(env.userBase + 9000 + (++sequence));
  const open = () => workflow.customerOpenTicket({ bot, userId, text: "hello", dedupeKey: "cleanup-twin", channel: "telegram" });
  const inter = makeInterleaver();
  const restores = [];
  inter.wrap(Ticket, "deleteOne", "delete", restores);
  inter.wrap(Message, "create", "msg", restores);
  inter.wrap(Message, "countDocuments", "mcount", restores);
  inter.crashAt("A:msg#1");
  inter.run("A", open).catch(() => {});
  // A's message write dies; A's cleanup (delete) is parked. Wait until A's ticket exists, then start the twin.
  await inter.step("A:msg#1");
  await until(async () => (await Ticket.find({ userTelegramId: userId }).lean()).length === 1);
  inter.run("B", open).catch(() => {});
  // B stores the message, then stops right before it would make the ticket visible.
  await inter.step("B:msg#1");
  // A's cleanup now runs although a message exists (A checked earlier): it withdraws the still-hidden ticket.
  await inter.step("A:delete#1");
  const results = await inter.finish();
  while (restores.length) restores.pop()();
  assert.equal(results.A.ok, false);
  assert.equal(results.A.error.code, "EINJECTED");
  assert.equal(results.B.ok, false, "B's ticket vanished under it: retryable error, never success");
  assert.ok(results.B.error instanceof tickets.SupportError, String(results.B.error?.message));
  assert.equal(results.B.error.code, "ticket_unavailable");
  assert.equal((await Ticket.find({ userTelegramId: userId }).lean()).length, 0);
  // B's retry clears the orphaned message and converges on exactly one ticket and one message.
  const retry = await open();
  assert.equal(retry.created, true);
  const rows = await Ticket.find({ userTelegramId: userId }).lean();
  assert.equal(rows.length, 1);
  assert.equal((await Message.find({ dedupeKey: "cleanup-twin" }).lean()).length, 1);
  assert.equal(rows[0].provisional, false);
}

async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
