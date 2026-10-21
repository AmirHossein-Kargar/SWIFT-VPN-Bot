/**
 * Admin workflows exercised through the REAL service code on a REAL MongoDB (no in-memory model fakes):
 * live ticket sync (cursor casting, ordering, unique dedupe index, read-state compare-and-set, ownership),
 * profile photos (real User lookup, fake Telegram bot), user list/search, dashboard and analytics aggregations,
 * and remote VPN clients against a LOCAL fake WizardXray HTTP server (success, provider error, garbage, outage).
 *
 * Telegram is always a recording fake and the provider is a local loopback server: nothing external is contacted,
 * no money moves. Needs the guarded test database (tests/helpers/db.js); skips when MongoDB is not reachable.
 */
import http from "node:http";
import { test, describe, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { makeFakeBot } from "../helpers/fakeSupport.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "-100777";
const ADMIN = "424242";
const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

// Local fake WizardXray provider (must be configured before the API client is first created).
let providerMode = "ok";
let providerHits = 0;
const provider = http.createServer((req, res) => {
  providerHits += 1;
  res.setHeader("content-type", "application/json");
  if (providerMode === "error") { res.statusCode = 500; return res.end(JSON.stringify({ ok: false, error: "boom secret-internal-detail" })); }
  if (providerMode === "garbage") return res.end("<html>not json</html>");
  return res.end(JSON.stringify({ ok: true, result: [
    { username: "svc_known_1", status: "active", traffic: 5, sub_link: "https://secret.example/sub/abc", hash: "h4sh", uuid: "u-u-i-d", token: "tkn" },
    { username: "svc_orphan_2", status: "expired", traffic: 1 },
  ] }));
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
process.env.WIZARD_API_URL = `http://127.0.0.1:${provider.address().port}`;
process.env.VPN_API_KEY = "test-key-not-real";

let User, WalletPurchase, HooshPayInvoice, SupportTicket, SupportTicketMessage;
let tickets, workflow, adminTickets, users, vpns, dashboard, analytics, photo;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js"));
  ({ default: SupportTicket } = await import("../../models/SupportTicket.js"));
  ({ default: SupportTicketMessage } = await import("../../models/SupportTicketMessage.js"));
  tickets = await import("../../services/support/tickets.js");
  workflow = await import("../../services/support/workflow.js");
  adminTickets = await import("../../services/admin/tickets.js");
  users = await import("../../services/admin/users.js");
  vpns = await import("../../services/admin/vpns.js");
  dashboard = await import("../../services/admin/dashboard.js");
  analytics = await import("../../services/admin/analyticsReport.js");
  photo = await import("../../services/admin/userPhoto.js");
  // connectTestDB() builds indexes only for models loaded BEFORE it ran; these were imported after, so wait for
  // Mongoose's own index build. Without it the first concurrent inserts can race the unique dedupeKey index.
  await Promise.all([User, WalletPurchase, HooshPayInvoice, SupportTicket, SupportTicketMessage].map((model) => model.init()));
}

after(async () => {
  provider.close();
  await disconnectTestDB();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await Promise.all([User, WalletPurchase, HooshPayInvoice, SupportTicket, SupportTicketMessage].map((model) => model.deleteMany({})));
  providerMode = "ok";
  photo.clearUserPhotoCacheForTests();
});

let seq = 0;
const key = (prefix) => `${prefix}:${++seq}`;
const bot = makeFakeBot();

describe("live ticket sync on real MongoDB (web <-> Telegram)", () => {
  async function open(userId = 900001, text = "سلام، سرویس وصل نمی‌شود") {
    const result = await workflow.customerOpenTicket({ bot, from: { id: userId }, userId, subject: "اتصال", text, dedupeKey: key("open"), channel: "telegram" });
    return result.ticket.ticketId;
  }
  const asAdmin = (ticketId, text, dedupeKey = key("web-admin")) => workflow.adminReply({ bot, adminId: ADMIN, ticketId, text, dedupeKey });
  const asCustomer = (ticketId, text, userId = 900001, dedupeKey = key("tg")) => workflow.customerReply({ bot, from: { id: userId }, userId, ticketId, text, dedupeKey });
  const poll = (ticketId, extra = {}) => adminTickets.getSupportTicketUpdates({ actorId: ADMIN, ticketId, ...extra });
  const texts = (result) => result.messages.map((message) => message.text);

  skip("a string cursor is cast to an ObjectId by Mongoose: incremental polls return exactly the new messages in insertion order", async () => {
    const id = await open();
    await asAdmin(id, "پاسخ ۱");
    const first = await poll(id);
    assert.deepEqual(texts(first), ["سلام، سرویس وصل نمی‌شود", "پاسخ ۱"]);
    assert.match(first.cursor, /^[a-f0-9]{24}$/);
    await asCustomer(id, "از تلگرام");
    await asAdmin(id, "پاسخ ۲");
    const next = await poll(id, { afterId: first.cursor });
    assert.deepEqual(texts(next), ["از تلگرام", "پاسخ ۲"]);
    assert.deepEqual((await poll(id, { afterId: next.cursor })).messages, []);
    assert.deepEqual(texts(await poll(id, { afterId: first.cursor })), ["از تلگرام", "پاسخ ۲"], "replaying a cursor returns the same rows");
  });

  skip("duplicate Telegram updates / double-submitted forms collapse on the real unique dedupeKey index", async () => {
    const id = await open();
    const results = await Promise.allSettled([
      asCustomer(id, "یک بار", 900001, "tg:777:42"), asCustomer(id, "یک بار", 900001, "tg:777:42"),
      asAdmin(id, "یک پاسخ", "web-admin:op-1"), asAdmin(id, "یک پاسخ", "web-admin:op-1"),
    ]);
    assert.ok(results.every((entry) => entry.status === "fulfilled"), JSON.stringify(results.filter((entry) => entry.status === "rejected").map((entry) => String(entry.reason))));
    const all = await poll(id);
    // The four submissions race each other, so the order of the two DIFFERENT messages is not defined; what must hold
    // is that each appears exactly once and the opening message stays first.
    assert.equal(texts(all)[0], "سلام، سرویس وصل نمی‌شود");
    assert.deepEqual([...texts(all)].sort(), ["سلام، سرویس وصل نمی‌شود", "یک بار", "یک پاسخ"].sort());
    assert.equal(all.ticket.messageCount, 3);
    assert.equal(await SupportTicketMessage.countDocuments({ ticketId: id }), 3);
  });

  skip("concurrent replies from both channels are all stored, counted atomically, and read in one consistent order", async () => {
    const id = await open();
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? asAdmin(id, `a${i}`) : asCustomer(id, `c${i}`))));
    const admin = await poll(id);
    const customer = await adminTickets && await tickets.getTicketUpdates({ audience: "customer", userId: 900001, ticketId: id });
    assert.equal(admin.messages.length, 11);
    assert.equal(admin.ticket.messageCount, 11, "$inc is atomic under concurrency");
    assert.deepEqual(texts(admin), texts(customer));
  });

  skip("read state: background polls never write; a viewing poll clears unread; a message arriving mid-poll stays unread", async () => {
    const id = await open();
    await asCustomer(id, "جدید");
    const before = await SupportTicket.findOne({ ticketId: id }).lean();
    for (let i = 0; i < 3; i += 1) await poll(id);
    const unchanged = await SupportTicket.findOne({ ticketId: id }).lean();
    assert.equal(unchanged.unreadForAdmin, before.unreadForAdmin, "plain polls do not mark read");
    assert.ok(before.unreadForAdmin > 0);

    // A new customer message lands between the poll's read and its compare-and-set write.
    const realFind = SupportTicketMessage.find.bind(SupportTicketMessage);
    let injected = false;
    SupportTicketMessage.find = (...args) => {
      const query = realFind(...args);
      if (injected) return query;
      injected = true;
      const originalLean = query.lean.bind(query);
      query.lean = async () => { const rows = await originalLean(); await asCustomer(id, "وسط poll"); return rows; };
      return query;
    };
    try { await poll(id, { markRead: true }); } finally { SupportTicketMessage.find = realFind; }
    assert.ok((await SupportTicket.findOne({ ticketId: id }).lean()).unreadForAdmin > 0, "the late message keeps the ticket unread");

    assert.equal((await poll(id, { markRead: true })).ticket.unread, 0, "a quiet viewing poll clears it");
  });

  skip("ownership: a customer reaches only their own ticket; foreign and malformed ids look like 'not found'", async () => {
    const id = await open(900001);
    await assert.rejects(() => tickets.getTicketUpdates({ audience: "customer", userId: 900002, ticketId: id }), { code: "ticket_not_found" });
    await assert.rejects(() => tickets.getTicketUpdates({ audience: "customer", userId: 900001, ticketId: "TK-NOPE" }), { code: "ticket_not_found" });
    const own = await tickets.getTicketUpdates({ audience: "customer", userId: 900001, ticketId: id });
    assert.equal(own.ticket.userTelegramId, undefined);
    await assert.rejects(() => adminTickets.getSupportTicketUpdates({ actorId: "999", ticketId: id }), { code: "forbidden" });
  });

  skip("a malformed or injected cursor never reaches the query (safe full resync)", async () => {
    const id = await open();
    for (const bad of ["x", "{$gt:''}", { $ne: null }, ["a"], "../x"]) assert.deepEqual(texts(await poll(id, { afterId: bad })), ["سلام، سرویس وصل نمی‌شود"]);
  });

  skip("a very long ticket keeps the NEWEST 500 messages on a full load", async () => {
    const id = await open();
    await SupportTicketMessage.insertMany(Array.from({ length: 520 }, (_, i) => ({ ticketId: id, author: "customer", text: `n${i}`, dedupeKey: `bulk:${id}:${i}` })));
    const full = await tickets.getAdminTicket({ ticketId: id, markRead: false });
    assert.equal(full.messages.length, 500);
    assert.equal(full.messages.at(-1).text, "n519");
  });
});

describe("profile photos with a real user lookup", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const photoBot = {
    async getUserProfilePhotos(id) { return id === 900001 ? { photos: [[{ file_id: "f", file_unique_id: "u1", width: 320 }]] } : { photos: [] }; },
    getFileStream() { return Readable.from([PNG]); },
  };
  skip("known users get their photo or a clean 'none'; unknown ids are refused before Telegram is contacted", async () => {
    await User.create({ telegramId: "900001" });
    await User.create({ telegramId: "900002" });
    const ok = await photo.getUserProfilePhoto({ actorId: ADMIN, telegramId: "900001", bot: photoBot });
    assert.equal(ok.status, "ok");
    assert.equal(ok.contentType, "image/png");
    assert.equal((await photo.getUserProfilePhoto({ actorId: ADMIN, telegramId: "900002", bot: photoBot })).status, "none");
    let called = false;
    await assert.rejects(() => photo.getUserProfilePhoto({ actorId: ADMIN, telegramId: "123456789", bot: { getUserProfilePhotos: async () => { called = true; return { photos: [] }; }, getFileStream() {} } }), { code: "user_not_found" });
    assert.equal(called, false);
  });
});

describe("users, dashboard and analytics on real aggregations", () => {
  async function seed() {
    for (let i = 1; i <= 7; i += 1) await User.create({ telegramId: String(700000 + i), username: `buyer_${i}`, firstName: i % 2 ? "Ali" : "Sara", balance: i * 1000, successfulPayments: i, totalSpent: i * 50_000 });
    await HooshPayInvoice.create({ uid: "H-REV-1", orderId: "REV1", userId: 700001, amount: 120_000, status: "paid", balanceCredited: true, balanceCreditedAt: new Date(), fulfilled: true, paidAt: new Date(), createdAt: new Date() });
    await WalletPurchase.create({ purchaseId: "wp_dash_1", telegramId: "700001", planId: "p1", planName: "Plan 30d", gig: 10, days: 30, amount: 90_000, status: "completed", completedAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 20 * 864e5) });
  }

  skip("listUsers: server-side search, filters, paging and spending sort", async () => {
    await seed();
    const page1 = await users.listUsers({ actorId: ADMIN, query: { page: 1, pageSize: 3 } });
    assert.equal(page1.total, 7);
    assert.equal(page1.items.length, 3);
    assert.equal(page1.pages, 3);
    const search = await users.listUsers({ actorId: ADMIN, query: { search: "buyer_3" } });
    assert.deepEqual(search.items.map((item) => item.telegramId), ["700003"]);
    // "spending" is computed from the real ledgers (credited top-ups + completed purchases), not from the stored
    // totalSpent counter: user 700001 is the only one with ledger records, so it must come first.
    const bySpend = await users.listUsers({ actorId: ADMIN, query: { sort: "spending", pageSize: 2 } });
    assert.equal(bySpend.items[0].telegramId, "700001");
    const regexSafe = await users.listUsers({ actorId: ADMIN, query: { search: ".*" } });
    assert.equal(regexSafe.total, 0, "search text is escaped, never a regex");
    await assert.rejects(() => users.listUsers({ actorId: "5", query: {} }), { code: "forbidden" });
  });

  skip("dashboard: real metrics reflect seeded users, revenue and orders", async () => {
    await seed();
    const result = await dashboard.getDashboardMetrics({});
    assert.equal(result.metrics.totalUsers, 7);
    assert.ok(result.metrics.revenue.month >= 90_000, JSON.stringify(result.metrics.revenue));
    assert.ok(result.metrics.orders.total >= 1);
    assert.equal(result.charts.revenue.length, 30);
  });

  skip("analytics report: real aggregation runs, is authorization-gated and includes the seeded top-up and sale", async () => {
    await seed();
    const report = await analytics.getAnalyticsReport({ actorId: ADMIN, query: { range: "30d" } });
    const serialized = JSON.stringify(report);
    assert.ok(report && typeof report === "object");
    assert.match(serialized, /120000/, "the credited HooshPay top-up appears");
    assert.match(serialized, /90000/, "the completed wallet sale appears");
    await assert.rejects(() => analytics.getAnalyticsReport({ actorId: "5", query: { range: "30d" } }), { code: "forbidden" });
  });
});

describe("remote VPN clients against a local fake provider", () => {
  skip("lists clients, strips link/hash/uuid/token fields, and flags clients unknown to the bot database", async () => {
    await User.create({ telegramId: "800001", services: [{ username: "svc_known_1" }] });
    const result = await vpns.listRemoteClients({ actorId: ADMIN, limit: 50 });
    assert.equal(result.count, 2);
    const known = result.items.find((item) => item.username === "svc_known_1");
    const orphan = result.items.find((item) => item.username === "svc_orphan_2");
    assert.equal(known.knownLocally, true);
    assert.equal(orphan.knownLocally, false);
    const serialized = JSON.stringify(result);
    for (const secret of ["secret.example", "h4sh", "u-u-i-d", "tkn"]) assert.ok(!serialized.includes(secret), `${secret} must never reach the admin UI`);
    assert.ok(result.fetchedAt);
  });

  skip("a provider 500 becomes a safe 502 with no provider text leaked", async () => {
    providerMode = "error";
    await assert.rejects(() => vpns.listRemoteClients({ actorId: ADMIN }), (error) => {
      assert.ok([502, 503].includes(error.status), `status ${error.status}`);
      assert.ok(!/secret-internal-detail|boom/.test(error.safeMessage || error.message));
      return true;
    });
  });

  skip("a non-JSON provider answer is refused safely", async () => {
    providerMode = "garbage";
    await assert.rejects(() => vpns.listRemoteClients({ actorId: ADMIN }), (error) => [502, 503].includes(error.status));
  });

  skip("a provider outage (connection refused) is a safe error, never a crash or stale data", async () => {
    providerMode = "ok";
    const url = process.env.WIZARD_API_URL;
    await new Promise((resolve) => provider.close(resolve));
    try {
      await assert.rejects(() => vpns.listRemoteClients({ actorId: ADMIN }), (error) => [502, 503].includes(error.status));
    } finally {
      await new Promise((resolve) => provider.listen(Number(new URL(url).port), "127.0.0.1", resolve));
    }
  });

  skip("only admins may list remote clients", async () => {
    await assert.rejects(() => vpns.listRemoteClients({ actorId: "5" }), { code: "forbidden" });
  });
});
