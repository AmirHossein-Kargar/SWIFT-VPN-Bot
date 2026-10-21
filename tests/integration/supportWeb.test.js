/**
 * Support tickets over REAL HTTP: customer sign-in, CSRF, ownership isolation,
 * admin visibility, session separation, attachment authorization, the old
 * panel path redirect — plus the audited admin reply/status services.
 * Uses in-memory Redis and ticket models, so it needs no MongoDB.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { makeFakeRedis } from "../helpers/fakeRedis.js";
import { makeSupportDeps, makeFakeBot } from "../helpers/fakeSupport.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "-100777";

const { setAdminSessionRedisForTests, issueAdminLoginCode } = await import("../../services/admin/auth.js");
const { setCustomerSessionRedisForTests, issueCustomerLoginCode } = await import("../../services/support/customerAuth.js");
const { resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js");
const tickets = await import("../../services/support/tickets.js");
const { setBotInstance } = await import("../../config/botInstance.js");
const { streamAttachment, contentTypeFor } = await import("../../services/support/attachments.js");
const { replyToSupportTicket, setSupportTicketStatus } = await import("../../services/admin/tickets.js");

const redis = makeFakeRedis();
setAdminSessionRedisForTests(redis);
setCustomerSessionRedisForTests(redis);

const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let deps;
let bot;
beforeEach(() => {
  resetAdminRateLimitsForTests();
  deps = makeSupportDeps();
  tickets.setSupportModelsForTests(deps);
  bot = makeFakeBot();
  setBotInstance(bot);
});
after(async () => {
  tickets.clearSupportModelsForTests();
  setBotInstance(null);
  await new Promise((resolve) => server.close(resolve));
});

async function call(method, path, { body, cookie, csrf, redirect = "follow" } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect });
  let data = null;
  try { data = await response.json(); } catch { /* not JSON */ }
  return { status: response.status, data, headers: response.headers };
}

function cookieFor(response, path) {
  const entry = response.headers.getSetCookie().find((item) => new RegExp(`Path=${path.replace("/", "\\/")}(;|$)`, "i").test(item));
  return entry ? entry.split(";")[0] : null;
}

async function customerLogin(telegramId) {
  await redis.del(`support:web:mint-rate:${telegramId}`);
  const { code } = await issueCustomerLoginCode(telegramId, redis);
  const response = await call("POST", "/api/support/auth/verify", { body: { code } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return { cookie: cookieFor(response, "/api/support"), csrf: response.data.csrfToken, response };
}

async function adminLogin() {
  await redis.del("admin:web:login-rate:424242");
  const { code } = await issueAdminLoginCode("424242", redis);
  const response = await call("POST", "/api/admin/auth/verify", { body: { code } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return { cookie: cookieFor(response, "/api/admin"), csrf: response.data.csrfToken };
}

const OP = (n) => `operation-id-${String(n).padStart(8, "0")}`;

async function createTicket(session, n = 1, text = "سلام، کمک می‌خواهم") {
  return call("POST", "/api/support/tickets", { body: { operationId: OP(n), subject: `موضوع ${n}`, text }, cookie: session.cookie, csrf: session.csrf });
}

describe("customer authentication", () => {
  test("API access without a session is rejected", async () => {
    assert.equal((await call("GET", "/api/support/tickets")).status, 401);
    assert.equal((await call("POST", "/api/support/tickets", { body: {} })).status, 401);
  });

  test("a login code works once, is bound to the Telegram account that minted it, and sets narrow cookies", async () => {
    const { code } = await issueCustomerLoginCode("1001", redis);
    const first = await call("POST", "/api/support/auth/verify", { body: { code } });
    assert.equal(first.status, 200);
    assert.ok(cookieFor(first, "/api/support") && cookieFor(first, "/panel"), "api + panel scoped cookies");
    assert.ok(first.headers.getSetCookie().every((c) => /HttpOnly/i.test(c) && /Secure/i.test(c) && /SameSite=Lax/i.test(c)));
    assert.equal((await call("POST", "/api/support/auth/verify", { body: { code } })).status, 401, "single use");
    assert.equal((await call("POST", "/api/support/auth/verify", { body: { code: "x".repeat(32) } })).status, 401);
    assert.equal((await call("POST", "/api/support/auth/verify", { body: {} })).status, 401);
  });

  test("minting a code is rate limited per Telegram account", async () => {
    await issueCustomerLoginCode("1002", redis);
    await assert.rejects(issueCustomerLoginCode("1002", redis), { code: "LOGIN_RATE_LIMITED" });
  });

  test("logout destroys the session server-side", async () => {
    const session = await customerLogin("1001");
    assert.equal((await call("GET", "/api/support/tickets", session)).status, 200);
    assert.equal((await call("POST", "/api/support/auth/logout", { cookie: session.cookie, csrf: session.csrf, body: {} })).status, 200);
    assert.equal((await call("GET", "/api/support/tickets", session)).status, 401);
  });

  test("admin and customer sessions are not interchangeable", async () => {
    const admin = await adminLogin();
    const customer = await customerLogin("1001");
    assert.equal((await call("GET", "/api/support/tickets", { cookie: admin.cookie })).status, 401);
    assert.equal((await call("GET", "/api/admin/tickets", { cookie: customer.cookie })).status, 401);
  });
});

describe("customer ticket API", () => {
  test("mutations require the CSRF token", async () => {
    const session = await customerLogin("1001");
    const noCsrf = await call("POST", "/api/support/tickets", { cookie: session.cookie, body: { operationId: OP(1), subject: "s", text: "t" } });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.data.error, "csrf_token_invalid");
    assert.equal(deps.Ticket.docs.length, 0);
  });

  test("creates a ticket, forwards it to the admin group, and replays the same operationId without duplicating", async () => {
    const session = await customerLogin("1001");
    const created = await createTicket(session, 1);
    assert.equal(created.status, 201);
    assert.match(created.data.data.ticket.ticketId, /^T-/);
    assert.equal(created.data.data.forwarded, true);
    const groupPosts = bot.of("sendMessage").filter((c) => String(c.args[0]) === "-100777");
    assert.equal(groupPosts.length, 1);
    assert.ok(groupPosts[0].args[1].includes(created.data.data.ticket.ticketId));

    const replay = await createTicket(session, 1);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.data.replayed, true);
    assert.equal(deps.Ticket.docs.length, 1);
    assert.equal(bot.of("sendMessage").filter((c) => String(c.args[0]) === "-100777").length, 1, "no second forward");
  });

  test("validates input and rejects bad operation ids", async () => {
    const session = await customerLogin("1001");
    const badOp = await call("POST", "/api/support/tickets", { cookie: session.cookie, csrf: session.csrf, body: { operationId: "short", subject: "s", text: "t" } });
    assert.equal(badOp.status, 400);
    const empty = await call("POST", "/api/support/tickets", { cookie: session.cookie, csrf: session.csrf, body: { operationId: OP(2), subject: "s", text: "   " } });
    assert.equal(empty.status, 400);
    const tooLong = await call("POST", "/api/support/tickets", { cookie: session.cookie, csrf: session.csrf, body: { operationId: OP(3), subject: "s", text: "x".repeat(4000) } });
    assert.ok([400, 413].includes(tooLong.status));
    assert.equal(deps.Ticket.docs.length, 0);
  });

  test("a customer cannot read, reply to, close, or download from another customer's ticket", async () => {
    const alice = await customerLogin("1001");
    const mallory = await customerLogin("2002");
    const { data } = await createTicket(alice, 1);
    const id = data.data.ticket.ticketId;
    const messageId = String(deps.Message.docs[0]._id);

    assert.equal((await call("GET", `/api/support/tickets/${id}`, mallory)).status, 404);
    assert.equal((await call("POST", `/api/support/tickets/${id}/messages`, { ...mallory, body: { operationId: OP(9), text: "hi" } })).status, 404);
    assert.equal((await call("POST", `/api/support/tickets/${id}/status`, { ...mallory, body: { status: "closed" } })).status, 404);
    assert.equal((await call("GET", `/api/support/attachments/${messageId}`, mallory)).status, 404);
    assert.deepEqual((await call("GET", "/api/support/tickets", mallory)).data.data.tickets, []);
    assert.equal(deps.Ticket.docs[0].status, "open");
    assert.equal(deps.Message.docs.length, 1);
  });

  test("conversation order, customer view hides internal fields, and closed tickets refuse replies", async () => {
    const session = await customerLogin("1001");
    const id = (await createTicket(session, 1)).data.data.ticket.ticketId;
    const reply = await call("POST", `/api/support/tickets/${id}/messages`, { ...session, body: { operationId: OP(5), text: "پیام دوم" } });
    assert.equal(reply.status, 200);
    const dup = await call("POST", `/api/support/tickets/${id}/messages`, { ...session, body: { operationId: OP(5), text: "پیام دوم" } });
    assert.equal(dup.data.data.replayed, true);

    const detail = (await call("GET", `/api/support/tickets/${id}`, session)).data.data;
    assert.deepEqual(detail.messages.map((m) => m.text), ["سلام، کمک می‌خواهم", "پیام دوم"]);
    assert.equal("userTelegramId" in detail.ticket, false);
    assert.ok(detail.messages.every((m) => !("dedupeKey" in m) && !("groupMessageIds" in m) && !("authorAdminId" in m)));

    assert.equal((await call("POST", `/api/support/tickets/${id}/status`, { ...session, body: { status: "closed" } })).status, 200);
    const closed = await call("POST", `/api/support/tickets/${id}/messages`, { ...session, body: { operationId: OP(6), text: "هنوز هستید؟" } });
    assert.equal(closed.status, 409);
    assert.equal(closed.data.error, "ticket_closed");
    assert.equal((await call("POST", `/api/support/tickets/${id}/status`, { ...session, body: { status: "resolved" } })).status, 400, "customers cannot pick arbitrary statuses");
    assert.equal((await call("POST", `/api/support/tickets/${id}/status`, { ...session, body: { status: "open" } })).status, 200, "reopen");
  });

  test("Telegram being down does not lose the ticket: it is saved and the API says forwarding failed", async () => {
    setBotInstance(makeFakeBot({ failOn: ["sendMessage"] }));
    const session = await customerLogin("1001");
    const created = await createTicket(session, 1);
    assert.equal(created.status, 201);
    assert.equal(created.data.data.forwarded, false);
    assert.equal(deps.Message.docs[0].delivery, "failed");
  });

  test("responses are never cacheable and errors do not leak internals", async () => {
    const session = await customerLogin("1001");
    const response = await call("GET", "/api/support/tickets", session);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const missing = await call("GET", "/api/support/tickets/T-AAAAAA", session);
    assert.equal(JSON.stringify(missing.data).includes("stack"), false);
  });
});

describe("admin ticket API", () => {
  test("requires an admin session", async () => {
    assert.equal((await call("GET", "/api/admin/tickets")).status, 401);
    assert.equal((await call("POST", "/api/admin/tickets/T-AAAAAA/reply", { body: {} })).status, 401);
  });

  test("lists, filters, searches, and exposes the customer id only to admins", async () => {
    const customer = await customerLogin("1001");
    const id = (await createTicket(customer, 1)).data.data.ticket.ticketId;
    await createTicket(await customerLogin("2002"), 2, "اتصال قطع است");
    const admin = await adminLogin();

    const list = (await call("GET", "/api/admin/tickets", admin)).data.data;
    assert.equal(list.total, 2);
    assert.equal(list.needsAttention, 2);
    assert.ok(list.tickets.every((t) => typeof t.userTelegramId === "string"));
    assert.equal((await call("GET", `/api/admin/tickets?q=${id}`, admin)).data.data.total, 1);
    assert.equal((await call("GET", "/api/admin/tickets?status=closed", admin)).data.data.total, 0);
    assert.equal((await call("GET", "/api/admin/tickets?status=bogus", admin)).status, 400);

    const detail = (await call("GET", `/api/admin/tickets/${id}`, admin)).data.data;
    assert.equal(detail.ticket.userTelegramId, "1001");
    assert.equal((await call("GET", "/api/admin/tickets?unread=1", admin)).data.data.total, 1, "opened ticket is no longer unread");
    assert.equal((await call("GET", "/api/admin/tickets/T-ZZZZZZ", admin)).status, 404);
  });

  test("reply and status mutations require CSRF and a valid operationId", async () => {
    const customer = await customerLogin("1001");
    const id = (await createTicket(customer, 1)).data.data.ticket.ticketId;
    const admin = await adminLogin();
    assert.equal((await call("POST", `/api/admin/tickets/${id}/reply`, { cookie: admin.cookie, body: { operationId: OP(1), text: "x" } })).status, 403);
    assert.equal((await call("POST", `/api/admin/tickets/${id}/reply`, { ...admin, body: { text: "x" } })).status, 400);
    assert.equal((await call("POST", `/api/admin/tickets/${id}/status`, { cookie: admin.cookie, body: { operationId: OP(1), status: "closed" } })).status, 403);
    assert.equal(deps.Message.docs.length, 1);
  });
});

describe("audited admin services (idempotency)", () => {
  function makeAuditModel() {
    const docs = new Map();
    return {
      async create(fields) {
        if (docs.has(fields.operationId)) throw Object.assign(new Error("dup"), { code: 11000 });
        const doc = { ...fields, status: "started", async save() { docs.set(this.operationId, this); } };
        docs.set(fields.operationId, doc);
        return doc;
      },
      async findOne({ operationId }) { return docs.get(operationId) || null; },
    };
  }

  async function seed() {
    const created = await tickets.createTicket({ userId: "1001", text: "کمک", dedupeKey: "seed" });
    return created.ticket.ticketId;
  }

  test("a double-submitted reply is delivered to the customer exactly once", async () => {
    const ticketId = await seed();
    const auditModel = makeAuditModel();
    const input = { actorId: "424242", operationId: OP(1), ticketId, text: "در حال بررسی", bot, auditModel };
    const first = await replyToSupportTicket(input);
    const second = await replyToSupportTicket(input);
    assert.equal(first.delivered, true);
    assert.equal(second.replayed, true);
    assert.equal(bot.of("sendMessage").filter((c) => String(c.args[0]) === "1001").length, 1);
    assert.equal(deps.Message.docs.filter((m) => m.author === "admin").length, 1);
  });

  test("the same operationId cannot be reused for a different ticket or action", async () => {
    const ticketId = await seed();
    const auditModel = makeAuditModel();
    await replyToSupportTicket({ actorId: "424242", operationId: OP(1), ticketId, text: "a", bot, auditModel });
    await assert.rejects(setSupportTicketStatus({ actorId: "424242", operationId: OP(1), ticketId, status: "closed", bot, auditModel }), { code: "idempotency_conflict" });
  });

  test("non-admins are refused before anything is read or sent", async () => {
    const ticketId = await seed();
    await assert.rejects(replyToSupportTicket({ actorId: "999", operationId: OP(2), ticketId, text: "x", bot, auditModel: makeAuditModel() }), { code: "forbidden" });
    assert.equal(bot.calls.length, 0);
  });

  test("a reply that Telegram cannot deliver is stored and reported as undelivered", async () => {
    const ticketId = await seed();
    const result = await replyToSupportTicket({ actorId: "424242", operationId: OP(3), ticketId, text: "x", bot: makeFakeBot({ failOn: ["sendMessage"] }), auditModel: makeAuditModel() });
    assert.equal(result.delivered, false);
    assert.equal(deps.Message.docs.find((m) => m.author === "admin").delivery, "failed");
  });

  test("closing a ticket notifies the customer", async () => {
    const ticketId = await seed();
    await setSupportTicketStatus({ actorId: "424242", operationId: OP(4), ticketId, status: "closed", bot, auditModel: makeAuditModel() });
    assert.ok(bot.of("sendMessage").some((c) => String(c.args[0]) === "1001" && c.args[1].includes("بسته")));
  });
});

describe("attachment streaming", () => {
  function makeRes() {
    const res = new Writable({ write(chunk, _enc, done) { res.chunks.push(chunk); done(); } });
    res.headers = {};
    res.chunks = [];
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (headers) => { Object.assign(res.headers, headers); return res; };
    return res;
  }
  const fileBot = (extra = {}) => ({
    async getFile() { return { file_path: "photos/file_1.jpg", file_size: 10, ...extra }; },
    async getFileLink() { return "https://api.telegram.org/file/botSECRET/photos/file_1.jpg"; },
  });

  test("streams with defensive headers and never exposes the Telegram URL", async () => {
    const res = makeRes();
    await streamAttachment({
      bot: fileBot(),
      attachment: { kind: "photo", fileId: "F" },
      res,
      http: { get: async () => ({ data: Readable.from([Buffer.from("IMG")]) }) },
    });
    assert.equal(res.headers["Content-Type"], "image/jpeg");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.match(res.headers["Content-Security-Policy"], /sandbox/);
    assert.equal(res.headers["Cache-Control"], "private, no-store");
    assert.ok(!JSON.stringify(res.headers).includes("SECRET"));
    assert.equal(Buffer.concat(res.chunks).toString(), "IMG");
  });

  test("oversized files and Telegram failures become clean errors", async () => {
    await assert.rejects(streamAttachment({ bot: fileBot({ file_size: 50 * 1024 * 1024 }), attachment: { kind: "video", fileId: "F" }, res: makeRes() }), { code: "attachment_too_large" });
    await assert.rejects(streamAttachment({ bot: { getFile: async () => { throw new Error("boom"); } }, attachment: { kind: "photo", fileId: "F" }, res: makeRes() }), { code: "attachment_unavailable" });
    await assert.rejects(streamAttachment({ bot: fileBot(), attachment: { kind: "photo", fileId: "F" }, res: makeRes(), http: { get: async () => { throw new Error("net"); } } }), { code: "attachment_unavailable" });
  });

  test("content types are limited to a known media allowlist", () => {
    assert.equal(contentTypeFor("photo", "a/b.PNG"), "image/png");
    assert.equal(contentTypeFor("video", "a/b.mp4"), "video/mp4");
    assert.equal(contentTypeFor("photo", "a/b.html"), "image/jpeg", "unknown extensions fall back to the kind, never text/html");
    assert.equal(contentTypeFor("video", ""), "video/mp4");
  });
});

describe("canonical panel route", () => {
  test("the previous /panel-next and /next-panel paths permanently redirect to /panel, preserving the sub-path and query", async () => {
    for (const previous of ["/panel-next", "/next-panel"]) {
      const root = await fetch(`${baseUrl}${previous}`, { redirect: "manual" });
      assert.equal(root.status, 308, previous);
      assert.equal(root.headers.get("location"), "/panel", previous);
      const nested = await fetch(`${baseUrl}${previous}/tickets?status=open`, { redirect: "manual" });
      assert.equal(nested.headers.get("location"), "/panel/tickets?status=open", previous);
      const evil = await fetch(`${baseUrl}${previous}//example.org`, { redirect: "manual" });
      assert.equal(evil.headers.get("location"), "/panel/example.org", `${previous}: never an off-site redirect`);
    }
  });

  test("an old customer login link keeps working: /next-panel/support/login redirects to /panel/support/login", async () => {
    const response = await fetch(`${baseUrl}/next-panel/support/login`, { redirect: "manual" });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "/panel/support/login");
  });

  test("/admin pages redirect temporarily to /panel while /api/admin is untouched", async () => {
    for (const path of ["/admin", "/admin/", "/admin/users?x=1"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      assert.equal(response.status, 307, path);
      assert.equal(response.headers.get("location"), "/panel", path);
    }
    const api = await fetch(`${baseUrl}/api/admin/auth/session`, { redirect: "manual" });
    assert.equal(api.status, 200, "the admin API is not redirected");
    const lookalike = await fetch(`${baseUrl}/administrator`, { redirect: "manual" });
    assert.notEqual(lookalike.status, 307, "only /admin itself is redirected");
  });
});
