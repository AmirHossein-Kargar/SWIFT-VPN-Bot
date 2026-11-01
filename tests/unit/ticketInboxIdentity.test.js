/**
 * The admin ticket inbox identifies a ticket by its customer. The list API joins
 * name and username from the user record, and the panel never uses the customer's
 * first message as a title. Browser coverage of the rendered row is in
 * tests/e2e/nextPanel.e2e.mjs, which is not part of `npm test`.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeSupportDeps } from "../helpers/fakeSupport.js";

process.env.ADMINS = "9001";

const tickets = await import("../../services/support/tickets.js");
const adminTickets = await import("../../services/admin/tickets.js");

const ADMIN = "9001";
let deps;
let seq = 0;

const addTicket = (userTelegramId) => {
  seq += 1;
  return deps.Ticket.create({ ticketId: `T-TEST${String(seq).padStart(2, "2")}`, userTelegramId, subject: "First message", status: "open", channel: "telegram", lastMessageAt: new Date() });
};
const customerOf = (list, telegramId) => list.tickets.find((ticket) => ticket.userTelegramId === telegramId).customer;

beforeEach(() => { deps = makeSupportDeps(); });
afterEach(() => { tickets.clearSupportModelsForTests(); });

describe("admin ticket list: customer identity", () => {
  test("carries the customer's joined name and username", async () => {
    await deps.User.create({ telegramId: "1001", firstName: "Sara", lastName: "Test", username: "sara_test" });
    await addTicket("1001");
    const list = await tickets.listAdminTickets({}, deps);
    assert.deepEqual(customerOf(list, "1001"), { name: "Sara Test", username: "sara_test" });
  });

  test("the first name alone is a name, and a username alone leaves the name empty", async () => {
    await deps.User.create({ telegramId: "1002", firstName: "Sara", lastName: null, username: null });
    await deps.User.create({ telegramId: "1003", firstName: null, lastName: null, username: "only_username" });
    await addTicket("1002");
    await addTicket("1003");
    const list = await tickets.listAdminTickets({}, deps);
    assert.deepEqual(customerOf(list, "1002"), { name: "Sara", username: null });
    assert.deepEqual(customerOf(list, "1003"), { name: null, username: "only_username" });
  });

  test("a ticket with no user record is still listed, with customer null", async () => {
    await addTicket("1004");
    const list = await tickets.listAdminTickets({}, deps);
    assert.equal(list.total, 1);
    assert.equal(customerOf(list, "1004"), null);
  });

  test("one page costs one user query, asking only for the distinct customers and the identity fields", async () => {
    await addTicket("1005");
    await addTicket("1005");
    await addTicket("1006");
    const calls = [];
    const User = { find(filter, projection) { calls.push({ filter, projection }); return { lean: async () => [] }; } };
    await tickets.listAdminTickets({}, { ...deps, User });
    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].filter.telegramId.$in].sort(), ["1005", "1006"]);
    assert.equal(calls[0].projection, "telegramId firstName lastName username");
  });

  test("an empty page does not query users", async () => {
    const User = { find() { throw new Error("must not be called"); } };
    assert.deepEqual((await tickets.listAdminTickets({}, { ...deps, User })).tickets, []);
  });

  test("a failed lookup never hides tickets, and its log carries no customer data", async (t) => {
    await addTicket("1007");
    const logged = [];
    t.mock.method(console, "warn", (line) => logged.push(line));
    const User = { find() { return { lean: async () => { throw Object.assign(new Error("Sara Test 1007"), { code: "lookup_down" }); } }; } };
    const list = await tickets.listAdminTickets({}, { ...deps, User });
    assert.equal(customerOf(list, "1007"), null);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /lookup_down/);
    assert.doesNotMatch(logged[0], /Sara|1007/);
  });

  test("reaches the admin service the API route calls", async () => {
    tickets.setSupportModelsForTests(deps);
    await deps.User.create({ telegramId: "1008", firstName: "Sara", lastName: null, username: "sara_test" });
    await addTicket("1008");
    const list = await adminTickets.listSupportTickets({ actorId: ADMIN });
    assert.deepEqual(customerOf(list, "1008"), { name: "Sara", username: "sara_test" });
  });

  test("the customer's own ticket list gains no identity fields", async () => {
    await deps.User.create({ telegramId: "1009", firstName: "Sara", lastName: null, username: "sara_test" });
    await addTicket("1009");
    const own = await tickets.listCustomerTickets({ userId: "1009" }, deps);
    const [ticket] = Array.isArray(own) ? own : own.tickets;
    assert.equal("customer" in ticket, false);
    assert.equal("userTelegramId" in ticket, false);
  });
});

describe("admin ticket panel: the first message is no title", () => {
  const read = (path) => readFileSync(new URL(`../../admin-panel/${path}`, import.meta.url), "utf8");

  test("neither the inbox row nor the conversation header renders the subject", () => {
    assert.doesNotMatch(read("components/tickets/ticket-inbox.tsx"), /ticket\.subject/);
    assert.doesNotMatch(read("components/tickets/live-ticket-thread.tsx"), /ticket\.subject/);
  });

  test("the inbox row leads with the customer's avatar and name, with the fallbacks wired in", () => {
    const inbox = read("components/tickets/ticket-inbox.tsx");
    assert.match(inbox, /<UserAvatar telegramId=\{ticket\.userTelegramId\} label=\{customerName \?\? ticket\.userTelegramId\}/);
    assert.match(inbox, /\{customerName \?\? "Unknown customer"\}/);
    for (const field of ["ticket.userTelegramId", "ticket.ticketId", "TicketStatusBadge", "ticket.lastMessageAt", "ticket.createdAt"]) {
      assert.ok(inbox.includes(field), field);
    }
  });
});
