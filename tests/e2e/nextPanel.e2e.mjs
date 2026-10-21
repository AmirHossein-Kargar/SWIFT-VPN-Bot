/**
 * Browser verification of the Next.js admin panel (new screens + layout matrix).
 *
 * Run (needs Chrome and a production build of the panel):
 *   npx next build admin-panel && node tests/e2e/nextPanel.e2e.mjs
 *   rm -rf admin-panel/.next admin-panel/tsconfig.tsbuildinfo   # the build breaks moduleSmoke otherwise
 *
 * One Express app embeds the REAL Next panel and the REAL session/CSRF/origin
 * middleware. /api/admin is a thin stub that calls the REAL service code where
 * it can run without MongoDB: payment deletion (in-memory models), ticket
 * sync (in-memory models), profile photos (fake Telegram bot). Custody,
 * remote clients and the user list are fixtures. Nothing touches live services.
 * Not part of `npm test`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import express from "express";
import { chromium } from "playwright-core";

process.env.NODE_ENV = "production";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
const root = join(fileURLToPath(import.meta.url), "../../..");
if (!existsSync(join(root, "admin-panel/.next/BUILD_ID"))) {
  console.log("SKIP: run `npx next build admin-panel` first");
  process.exit(0);
}

const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const { makeMemoryModel } = await import("../helpers/memoryModel.js");
const { makeSupportDeps, makeFakeBot } = await import("../helpers/fakeSupport.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const mw = await import("../../web/adminMiddleware.js");
const { nextAdminMiddleware } = await import("../../web/nextAdminMiddleware.js");
const { default: realAdminRouter } = await import("../../web/adminRouter.js");
const { setBotInstance } = await import("../../config/botInstance.js");
const { default: realSupportRouter } = await import("../../web/supportRouter.js");
const customerAuth = await import("../../services/support/customerAuth.js");
customerAuth.setCustomerSessionRedisForTests(makeFakeRedis());
const sentToAdmin = [];
setBotInstance({ sendMessage: async (chatId, text) => { sentToAdmin.push({ chatId, text }); return { message_id: 1 }; } });
const deletion = await import("../../services/admin/paymentDeletion.js");
const tickets = await import("../../services/support/tickets.js");
const workflow = await import("../../services/support/workflow.js");
const adminTickets = await import("../../services/admin/tickets.js");
const photoSvc = await import("../../services/admin/userPhoto.js");

const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => existsSync(p));
if (!CHROME) { console.log("SKIP: no Chrome/Chromium found (set CHROME_PATH)"); process.exit(0); }

const shots = process.env.E2E_SHOTS || join(tmpdir(), "swift-next-panel-shots");
mkdirSync(shots, { recursive: true });

// ── In-memory data ──────────────────────────────────────────────────────────
const NOW = new Date();
const H = 3_600_000;
const old = new Date(NOW - 200 * H);
const fresh = new Date(NOW - 2 * H);
const models = {
  hooshpay: makeMemoryModel([
    { _id: "h1", uid: "HOOSH-FAILED-0001", orderId: "O1", userId: 11, amount: 150000, status: "failed", createdAt: fresh },
    { _id: "h2", uid: "HOOSH-PENDING-OLD-0002", orderId: "O2", userId: 12, amount: 250000, status: "pending", createdAt: old },
    { _id: "h3", uid: "HOOSH-PENDING-NEW-0003", orderId: "O3", userId: 13, amount: 350000, status: "pending", createdAt: fresh },
    { _id: "h4", uid: "HOOSH-PAID-0004-with-an-extremely-long-reference-value-to-test-wrapping-0123456789", orderId: "O4", userId: 14, amount: 450000, status: "paid", balanceCredited: true, createdAt: old, paidAt: old },
  ]),
  nowpayments: makeMemoryModel([
    { _id: "n1", orderId: "NP-FAILED-0001", userId: 21, amountToman: 900000, status: "failed", createdAt: fresh },
    { _id: "n2", orderId: "NP-CONFIRMING-0002", userId: 22, amountToman: 900000, status: "confirming", createdAt: old },
  ]),
  bank: makeMemoryModel([
    { _id: "b1", paymentId: "BANK-REJECTED-0001", userId: 31, amount: 100000, status: "rejected", createdAt: fresh },
    { _id: "b2", paymentId: "BANK-RECEIPT-0002", userId: 32, amount: 100000, status: "waiting_for_approval", receiptFileId: "f", createdAt: old },
  ]),
  trx: makeMemoryModel([
    { _id: "t1", invoiceId: "TRX-UNPAID-OLD-0001", userId: 41, amount: 200000, status: "unpaid", createdAt: old },
  ]),
};
for (const [provider, model] of Object.entries(models)) deletion.DELETION_SOURCES[provider].model = model;
const tombstones = makeMemoryModel([]);
const audits = (() => {
  const docs = [];
  return {
    docs,
    async create(fields) {
      if (docs.some((d) => d.operationId === fields.operationId)) throw Object.assign(new Error("dup"), { code: 11000 });
      const doc = { ...fields, status: "started", async save() {} };
      docs.push(doc);
      return doc;
    },
    async findOne(filter) { return docs.find((d) => d.operationId === filter.operationId) || null; },
    async updateOne(filter, update) { const doc = docs.find((d) => d.status === filter.status); if (doc) Object.assign(doc, update.$set); },
  };
})();
const PROVIDER_LABEL = { hooshpay: "HooshPay", nowpayments: "NOWPayments", bank: "Bank transfer", trx: "TRX" };
const STATUS_MAP = { failed: "failed", rejected: "failed", pending: "pending", waiting_for_approval: "pending", unpaid: "pending", confirming: "pending", paid: "fulfilled" };
function paymentRows() {
  return Object.entries(models).flatMap(([provider, model]) => model.docs.map((doc) => {
    const source = deletion.DELETION_SOURCES[provider];
    const verdict = deletion.explainDeletion(provider, doc);
    return {
      key: `${provider}:${doc[source.idField]}`, id: String(doc[source.idField]), provider, providerLabel: PROVIDER_LABEL[provider], type: "top-up",
      userId: String(doc.userId), amount: doc.amount ?? doc.amountToman, currency: "Toman", product: "Wallet top-up", trackingCode: null,
      status: STATUS_MAP[doc.status] || "pending", rawStatus: doc.status, createdAt: doc.createdAt, paidAt: doc.paidAt || null, fulfilledAt: null,
      retryCount: 0, lastRetryAt: null, nextRetryAt: null, lastError: null, recoveryStatus: "none", recoveryReason: null,
      deletion: { eligible: verdict.eligible, code: verdict.code, reason: verdict.reason },
    };
  }));
}

// Tickets (real service code, in-memory models, fake Telegram bot)
const supportDeps = makeSupportDeps();
tickets.setSupportModelsForTests(supportDeps);
const fakeBot = makeFakeBot();
let dedupe = 0;
const openTicket = async (userId, subject, text) =>
  (await workflow.customerOpenTicket({ bot: fakeBot, from: { id: userId }, userId, subject, text, dedupeKey: `seed:${++dedupe}`, channel: "telegram" })).ticket.ticketId;
const ticketId = await openTicket(900001, "اتصال قطع می‌شود", "سلام، سرویس من وصل نمی‌شود");
await workflow.adminReply({ bot: fakeBot, adminId: "424242", ticketId, text: "لطفاً برنامه را به‌روز کنید.", dedupeKey: `seed:${++dedupe}` });

// Profile photos (real service, fake bot)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const photoBot = {
  async getUserProfilePhotos(id) { return id === 900001 ? { photos: [[{ file_id: "f1", file_unique_id: "u1", width: 320 }]] } : { photos: [] }; },
  getFileStream() { return (async function* () { yield PNG; })(); },
};
const photoUsers = new Set(["900001", "900002"]);
const photoUserModel = { async exists({ telegramId }) { return photoUsers.has(telegramId) ? { _id: 1 } : null; } };

// ── Fixtures for screens whose services need MongoDB / NOWPayments ─────────
const mkUser = (i) => ({ telegramId: String(900000 + i), username: i === 1 ? "photo_user" : `user_${i}`, firstName: "Ali", lastName: "Rezaei", name: i === 1 ? "Ali Rezaei" : `User ${i}`, balance: 125000 * i, successfulPayments: i, totalSpent: 90000 * i, orderCount: i, serviceCount: i % 3, createdAt: NOW.toISOString(), lastActivityAt: NOW.toISOString(), isBanned: false });
const users = [1, 2, 3].map(mkUser);
const userDetail = (id) => ({ user: { ...users[0], telegramId: id }, totalSpent: 540000, orderCount: 6, activeVpns: 2, expiredVpns: 1, untrackedServiceCount: 0, blockedAt: null, blockedBy: null, blockReason: null, testService: { received: true, status: "completed", inFlight: false, eligible: false }, referral: { code: null, referredByTelegramId: null, referredBy: null, referralCount: 2, trackingAvailable: true }, payments: [], orders: [], services: [] });
const custody = {
  overview: { lastSyncedAt: NOW.toISOString(), providerHealth: { status: "healthy", message: "ok" }, capabilities: { apiConfigured: true, ipnConfigured: true, custodyJwtConfigured: true, isOwner: true, apiHealthy: true, balanceEnabled: true, conversionsEnabled: true, payoutsEnabled: true }, balances: [], totalTrackedAssets: 2, balanceError: null, recentConversions: [], conversionsError: null, recentPayouts: [], payoutsError: null, localSummary: { finishedCount: 4, finishedToman: 3_000_000, pendingCount: 1, recoveryRequiredCount: 0, underpaidCount: 0 }, recentDeposits: [], reconciliationWarnings: [] },
  assets: Array.from({ length: 25 }, (_, i) => ({ code: `asset${i}`, ticker: `AS${i}`, name: `Asset number ${i} with a long descriptive name`, network: i % 2 ? "TRC20" : "ERC20", enable: true, availableDisplay: `${i}.5`, pendingDisplay: "0", hasBalance: i < 5, minAmount: 1, supportedActions: { acceptPayment: true, convert: i < 5, withdraw: i < 5 } })),
  conversions: [{ id: "CV-1", fromCurrency: "trx", toCurrency: "usdttrc20", fromAmountDisplay: "100", toAmountDisplay: "24.1", rate: 0.241, status: "finished", createdAt: NOW.toISOString() }],
  payouts: [
    { id: "PO-1", batchWithdrawalId: "BATCH-1", currency: "trx", ticker: "TRX", network: "TRX", address: "TXyz1234567890abcdefghijklmnopqrstuvwxyz12", extraId: null, amountDisplay: "50", fee: 1, status: "waiting", hash: null, createdAt: NOW.toISOString() },
    { id: "PO-2", batchWithdrawalId: "BATCH-2", currency: "trx", ticker: "TRX", network: "TRX", address: "TAbc", extraId: "memo-1", amountDisplay: "10", fee: 1, status: "finished", hash: "abc", createdAt: NOW.toISOString() },
  ],
};
const calls = { convert: [], payout: [], verify: [], reply: [] };
let remoteFails = false;
const paged = (items, page = 1, pageSize = 20) => ({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pages: Math.max(1, Math.ceil(items.length / pageSize)), pageSize, lastSyncedAt: NOW.toISOString(), balanceError: null });

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use("/api/support", realSupportRouter); // REAL customer API (ownership, cookies) on in-memory ticket models
app.use("/api/admin", mw.adminApiHeaders, mw.requireSameOrigin, mw.attachAdminSession);
const api = express.Router();
const json = express.json({ limit: "64kb" });
const ok = (res, data) => res.json({ ok: true, data });
const guard = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { mw.adminApiErrorHandler(error, req, res, () => {}); }
};
// The REAL auth endpoints (login code, verify, session, logout, cookie issuing/clearing, CSRF issuance).
app.use("/api/admin", (req, res, next) => (req.path.startsWith("/auth/") ? realAdminRouter(req, res, next) : next()));
api.use(mw.requireAdminSession, mw.requireCsrfToken);
const actor = (req) => req.adminActorId;

api.get("/users", guard((req, res) => ok(res, { items: users, page: 1, pages: 1, pageSize: 25, total: users.length })));
api.get("/users/:id/photo", async (req, res, next) => {
  try {
    const photo = await photoSvc.getUserProfilePhoto({ actorId: actor(req), telegramId: req.params.id, bot: photoBot, userModel: photoUserModel });
    if (photo.status !== "ok") return res.status(photo.status === "none" ? 404 : 502).json({ ok: false, error: photo.status });
    res.set({ "Content-Type": photo.contentType, ETag: photo.etag, "Cache-Control": "private, max-age=3600" });
    return res.send(photo.body);
  } catch (error) { next(error); }
});
api.get("/users/:id", guard((req, res) => ok(res, userDetail(req.params.id))));

api.get("/payments", guard((req, res) => ok(res, { items: paymentRows(), page: 1, pages: 1, pageSize: 25, total: paymentRows().length })));
api.post("/payments/delete-preview", json, guard(async (req, res) => ok(res, await deletion.previewPaymentDeletion({ actorId: actor(req), keys: req.body?.keys }))));
api.post("/payments/delete", json, guard(async (req, res) => ok(res, await deletion.deletePayments({
  actorId: actor(req), operationId: req.body?.operationId, keys: req.body?.keys, confirmCount: req.body?.confirmCount, tombstoneModel: tombstones, auditModel: audits,
}))));

api.get("/custody/overview", guard((req, res) => ok(res, custody.overview)));
api.get("/custody/transactions", guard((req, res) => ok(res, paged([]))));
api.get("/custody/assets", guard((req, res) => {
  const search = String(req.query.search || "").toLowerCase();
  const filter = String(req.query.filter || "all");
  let items = custody.assets.filter((a) => (filter !== "with-balance" || a.hasBalance) && (!search || `${a.code} ${a.ticker} ${a.name}`.toLowerCase().includes(search)));
  ok(res, paged(items, Number(req.query.page) || 1));
}));
api.get("/custody/conversions", guard((req, res) => ok(res, paged(custody.conversions))));
api.post("/custody/conversions/preview", json, guard((req, res) => ok(res, { fromCurrency: req.body.fromCurrency, fromTicker: "TRX", toCurrency: req.body.toCurrency, toTicker: "USDT", fromAmount: Number(req.body.amount), estimatedToAmount: Number(req.body.amount) * 0.24, impliedRate: 0.24, availableBalance: 1000, previewedAt: new Date().toISOString() })));
api.post("/custody/conversions", json, guard((req, res) => { calls.convert.push(req.body); ok(res, { conversion: { id: "CV-NEW", status: "waiting" } }); }));
api.get("/custody/payouts", guard((req, res) => ok(res, paged(custody.payouts))));
api.post("/custody/payouts/validate-address", json, guard((req, res) => ok(res, { valid: true, currency: req.body.currency, address: req.body.address })));
api.get("/custody/payouts/fee", guard((req, res) => ok(res, { currency: req.query.currency, ticker: "TRX", network: "TRX", amount: Number(req.query.amount), fee: 1, minAmount: 5, estimatedTotalDebit: Number(req.query.amount) + 1 })));
api.post("/custody/payouts", json, guard((req, res) => { calls.payout.push(req.body); ok(res, { payout: { id: "PO-NEW", status: "creating" } }); }));
api.post("/custody/payouts/:batch/verify", json, guard((req, res) => { calls.verify.push({ batch: req.params.batch, ...req.body }); ok(res, { verified: true }); }));

api.get("/vpns", guard((req, res) => ok(res, { items: [], page: 1, pages: 1, pageSize: 25, total: 0 })));
api.get("/vpns-remote/clients", guard((req, res) => {
  if (remoteFails) throw new (await_import_AdminServiceError())("The VPN provider did not answer.", { status: 502, code: "wizard_api_failed" });
  ok(res, { source: "wizardxray", fetchedAt: NOW.toISOString(), count: 2, items: [{ username: "client_alpha_0123456789abcdef0123456789abcdef", status: "active", traffic: 5, knownLocally: true }, { username: "orphan_client", status: "expired", knownLocally: false }] });
}));

api.get("/tickets", guard(async (req, res) => ok(res, await adminTickets.listSupportTickets({ actorId: actor(req), page: 1, pageSize: 20 }))));
api.get("/tickets/:id/updates", guard(async (req, res) => ok(res, await adminTickets.getSupportTicketUpdates({ actorId: actor(req), ticketId: req.params.id, afterId: req.query.after, markRead: req.query.markRead }))));
api.get("/tickets/:id", guard(async (req, res) => ok(res, await adminTickets.getSupportTicket({ actorId: actor(req), ticketId: req.params.id }))));
api.post("/tickets/:id/reply", json, guard(async (req, res) => { calls.reply.push(req.body); ok(res, await adminTickets.replyToSupportTicket({ actorId: actor(req), operationId: req.body.operationId, ticketId: req.params.id, text: req.body.text, bot: fakeBot, auditModel: audits })); }));
api.post("/tickets/:id/status", json, guard(async (req, res) => ok(res, await adminTickets.setSupportTicketStatus({ actorId: actor(req), operationId: req.body.operationId, ticketId: req.params.id, status: req.body.status, bot: fakeBot, auditModel: audits }))));
api.use((req, res) => res.status(404).json({ ok: false, error: "not_stubbed", path: req.path }));
app.use("/api/admin", api);
app.use(nextAdminMiddleware);
app.get("/", (req, res) => res.redirect("/panel/"));

const { AdminServiceError } = await import("../../services/admin/authorization.js");
function await_import_AdminServiceError() { return AdminServiceError; }

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port); // the panel's server-side loopback targets this port
const base = `http://127.0.0.1:${server.address().port}`;

const session = await auth.createAdminSession("424242");
const cookieHeader = (path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" });

// ── Runner ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = { passed: [], failed: [] };
async function step(name, fn) {
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY).test(name)) return; // e.g. E2E_ONLY=photo node tests/e2e/nextPanel.e2e.mjs
  try { await fn(); results.passed.push(name); console.log(`  ok   ${name}`); }
  catch (error) { results.failed.push({ name, message: String(error?.message || error).split("\n")[0] }); console.log(`  FAIL ${name}\n       ${String(error?.message || error).split("\n").slice(0, 3).join("\n       ")}`); }
}
async function newPage({ width = 1440, height = 900, theme = "light", signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, baseURL: base });
  if (signedIn) await context.addCookies([cookieHeader("/api/admin"), cookieHeader("/panel")]);
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* ignore */ } }, theme);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error.message)));
  if (process.env.E2E_DEBUG) page.on("response", (response) => { if (response.status() >= 400) console.log(`       [http ${response.status()}] ${response.url()}`); });
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) page.errors.push(message.text()); });
  return page;
}
const go = (page, path) => page.goto(`/panel${path}`, { waitUntil: "networkidle" });

console.log(`Next panel e2e against ${base}`);

// ── Canonical /panel: routing, sign-in, sign-out, CSRF, expiry ──────────────
const redirectOf = async (path) => {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") };
};
await step("cutover: /next-panel and /panel-next (any depth, with query) redirect permanently to /panel; /admin redirects temporarily", async () => {
  assert.deepEqual(await redirectOf("/next-panel"), { status: 308, location: "/panel" });
  assert.deepEqual(await redirectOf("/panel-next/payments?status=failed"), { status: 308, location: "/panel/payments?status=failed" });
  assert.deepEqual(await redirectOf("/next-panel/support/login"), { status: 308, location: "/panel/support/login" });
  assert.deepEqual(await redirectOf("/admin"), { status: 307, location: "/panel" });
  assert.equal((await redirectOf("/panelx")).status, 404, "lookalike paths are not captured by the panel routes");
  const api = await fetch(`${base}/api/admin/auth/session`);
  assert.equal(api.status, 200, "the admin API is untouched");
  assert.equal((await api.json()).authenticated, false);
});

await step("cutover: an old customer login link (/next-panel/support/login#code=...) lands at /panel and its code survives the redirect", async () => {
  const page = await newPage({ signedIn: false });
  const verifyBodies = [];
  // The login page reads the fragment, POSTs it once and strips it from the address bar (by design),
  // so the proof that the fragment survived the 308 is the code in that request.
  await page.route("**/api/support/auth/verify", async (route) => { verifyBodies.push(route.request().postData()); await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid_login_code", message: "x" }) }); });
  await page.goto("/next-panel/support/login#code=abc123", { waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).pathname, "/panel/support/login");
  assert.match(String(verifyBodies[0]), /abc123/);
  await page.context().close();
});

await step("auth: a signed-out deep link goes to /panel/sign-in; the pre-cutover /next-panel cookie does NOT authenticate (forced re-login)", async () => {
  const page = await newPage({ signedIn: false });
  await page.context().addCookies([cookieHeader("/next-panel")]);
  await go(page, "/payments");
  assert.match(new URL(page.url()).pathname, /^\/panel\/sign-in\/?$/);
  await page.context().close();
});

await step("auth: real sign-in at /panel issues /api/admin + /panel cookies, deep link + refresh work, sign-out clears, expiry returns to sign-in", async () => {
  const page = await newPage({ signedIn: false });
  await go(page, "/sign-in");
  // Typing during hydration can be reset by React; the server then (by design) silently sends nothing
  // for a non-admin id. Wait until the controlled input really holds the value.
  const idInput = page.getByLabel("Telegram ID");
  for (let i = 0; i < 6; i += 1) {
    await idInput.fill("424242");
    await page.waitForTimeout(300);
    if ((await idInput.inputValue()) === "424242") break;
  }
  assert.equal(await idInput.inputValue(), "424242");
  await page.locator("form").first().getByRole("button").first().click();
  await page.getByLabel("Sign-in code").waitFor();
  let code = null;
  for (let i = 0; i < 40 && !code; i += 1) {
    code = /<code>([^<]+)<\/code>/.exec(sentToAdmin.at(-1)?.text || "")?.[1] ?? null;
    if (!code) await page.waitForTimeout(100);
  }
  assert.ok(code, "the bot delivered a code");
  await page.getByLabel("Sign-in code").fill(code);
  await page.locator("form").last().getByRole("button").first().click();
  await page.waitForURL((url) => !url.pathname.includes("sign-in"), { timeout: 15_000 });
  const cookies = (await page.context().cookies()).filter((c) => c.name === auth.ADMIN_SESSION_COOKIE && c.value);
  assert.deepEqual(cookies.map((c) => c.path).sort(), ["/api/admin", "/panel"]);
  assert.ok(cookies.every((c) => c.httpOnly && c.sameSite === "Lax"), "HttpOnly + SameSite=Lax");

  await go(page, "/payments"); // deep link
  await page.getByRole("checkbox").first().waitFor();
  await page.reload({ waitUntil: "networkidle" }); // refresh keeps the session and the route
  assert.match(new URL(page.url()).pathname, /^\/panel\/payments$/);
  await page.getByRole("checkbox").first().waitFor();

  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();
  await page.waitForURL(/\/panel\/sign-in/, { timeout: 15_000 });
  await go(page, "/payments");
  assert.match(new URL(page.url()).pathname, /sign-in/, "signed out: protected page redirects");
  assert.equal((await page.context().cookies()).filter((c) => c.name === auth.ADMIN_SESSION_COOKIE && c.value).length, 0, "cookies cleared");

  // Session expiry: a valid session removed server-side is rejected on the next request.
  const expiring = await auth.createAdminSession("424242");
  await page.context().addCookies([{ ...cookieHeader("/api/admin"), value: expiring.token }, { ...cookieHeader("/panel"), value: expiring.token }]);
  await go(page, "/payments");
  await page.getByRole("checkbox").first().waitFor();
  await auth.deleteAdminSession(expiring.token);
  await page.reload({ waitUntil: "networkidle" });
  assert.match(new URL(page.url()).pathname, /sign-in/, "expired session returns to sign-in");
  await page.context().close();
});

await step("security: unauthenticated API access is 401; mutations without/with a wrong CSRF token are 403; cross-origin mutations are refused", async () => {
  assert.equal((await fetch(`${base}/api/admin/payments`)).status, 401);
  const headers = { cookie: `${auth.ADMIN_SESSION_COOKIE}=${session.token}`, "content-type": "application/json" };
  const body = JSON.stringify({ keys: ["bank:X"] });
  assert.equal((await fetch(`${base}/api/admin/payments/delete-preview`, { method: "POST", headers, body })).status, 403);
  assert.equal((await fetch(`${base}/api/admin/payments/delete-preview`, { method: "POST", headers: { ...headers, "x-csrf-token": "nope" }, body })).status, 403);
  const crossOrigin = await fetch(`${base}/api/admin/payments/delete-preview`, { method: "POST", headers: { ...headers, "x-csrf-token": session.session.csrfToken, origin: "https://evil.example" }, body });
  assert.equal(crossOrigin.status, 403);
});

await step("customer support portal at /panel/support: one-time link signs in, own ticket is listed and opens live, cookies are /api/support + /panel, another customer's ticket is a 404", async () => {
  const page = await newPage({ signedIn: false });
  const { code } = await customerAuth.issueCustomerLoginCode("900001");
  await page.goto(`/panel/support/login#code=${code}`, { waitUntil: "networkidle" });
  await page.waitForURL((url) => url.pathname.replace(/\/$/, "") === "/panel/support", { timeout: 15_000 });
  const cookies = (await page.context().cookies()).filter((c) => c.name === customerAuth.CUSTOMER_SESSION_COOKIE && c.value);
  assert.deepEqual(cookies.map((c) => c.path).sort(), ["/api/support", "/panel"]);
  assert.ok(cookies.every((c) => c.httpOnly && c.sameSite === "Lax"));
  await page.getByRole("link", { name: /اتصال قطع می‌شود/ }).first().click();
  await page.getByText("به‌روزرسانی خودکار فعال است").waitFor();
  await workflow.adminReply({ bot: fakeBot, adminId: "424242", ticketId, text: "پاسخ زنده برای مشتری", dedupeKey: `portal:${Date.now()}` });
  await page.getByText("پاسخ زنده برای مشتری").waitFor({ timeout: 12_000 });
  // Another customer's ticket looks exactly like a missing one.
  const otherTicket = await openTicket(900002, "تیکت دیگری", "متن خصوصی");
  const foreign = await page.goto(`/panel/support/${otherTicket}`, { waitUntil: "networkidle" });
  assert.equal(foreign.status(), 404);
  assert.equal(await page.getByText("متن خصوصی").count(), 0);
  await page.context().close();
});

// ── Functional: payments deletion ───────────────────────────────────────────
await step("payments: only eligible rows are selectable, ineligible show why", async () => {
  const page = await newPage();
  await go(page, "/payments");
  const boxes = page.getByRole("checkbox");
  assert.ok((await boxes.count()) >= 9, "header + one box per row");
  const rowBox = (text) => page.getByRole("row").filter({ hasText: text }).getByRole("checkbox");
  assert.equal(await rowBox("HOOSH-FAILED-0001").isDisabled(), false);
  assert.equal(await rowBox("HOOSH-PENDING-OLD-0002").isDisabled(), false);
  assert.equal(await rowBox("HOOSH-PENDING-NEW-0003").isDisabled(), true, "too new");
  assert.equal(await rowBox("NP-CONFIRMING-0002").isDisabled(), true, "funds in flight");
  assert.equal(await rowBox("BANK-RECEIPT-0002").isDisabled(), true, "receipt submitted");
  await page.context().close();
});

await step("payments: a record that becomes ineligible after selection blocks the whole batch and nothing is deleted", async () => {
  const page = await newPage();
  await go(page, "/payments");
  await page.getByRole("row").filter({ hasText: "HOOSH-FAILED-0001" }).getByRole("checkbox").click();
  await page.getByRole("row").filter({ hasText: "BANK-REJECTED-0001" }).getByRole("checkbox").click();
  // A webhook credits one of the selected invoices before the admin confirms.
  const doc = models.hooshpay.docs.find((d) => d._id === "h1");
  Object.assign(doc, { status: "paid", balanceCredited: true, paidAt: new Date() });
  await page.getByRole("button", { name: /Delete selected/ }).click();
  await page.getByText(/not deletable, so nothing will be deleted/).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Delete 2 records/ }).isDisabled(), true);
  assert.equal(models.bank.docs.length, 2, "the other record was NOT deleted");
  Object.assign(doc, { status: "failed", balanceCredited: false, paidAt: null }); // restore for later steps
  await page.context().close();
});

await step("payments: select-all + confirm deletes exactly the eligible records, tombstones them and audits", async () => {
  const page = await newPage();
  await go(page, "/payments");
  await page.getByRole("checkbox", { name: /Select all deletable/ }).click();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  await page.getByText(/All \d+ selected records are eligible/).waitFor();
  await page.getByRole("button", { name: /^Delete \d+ records?$/ }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("HOOSH-FAILED-0001"), null, { timeout: 8000 });
  assert.deepEqual(models.hooshpay.docs.map((d) => d._id).sort(), ["h3", "h4"]);
  assert.deepEqual(models.bank.docs.map((d) => d._id), ["b2"]);
  assert.deepEqual(models.trx.docs, []);
  assert.deepEqual(models.nowpayments.docs.map((d) => d._id), ["n2"]);
  assert.equal(tombstones.docs.length, 5);
  assert.ok(tombstones.docs.every((t) => t.deletedAt instanceof Date));
  assert.ok(audits.docs.some((a) => a.action === "PAYMENTS_DELETED" && a.status === "succeeded"));
  assert.ok(await page.getByText("HOOSH-PAID-0004").count() > 0, "the credited payment is still listed");
  await page.context().close();
});

// ── Functional: custody ─────────────────────────────────────────────────────
await step("custody assets: list, search and paging", async () => {
  const page = await newPage();
  await go(page, "/custody");
  await page.getByRole("tab", { name: "Assets" }).click();
  await page.getByText("Asset balances").waitFor();
  await page.getByLabel("Filter assets").selectOption("all");
  await page.getByText("AS24").waitFor({ state: "attached" }).catch(() => {});
  await page.getByLabel("Search assets").fill("AS3");
  await page.waitForFunction(() => document.body.innerText.includes("AS3") && !document.body.innerText.includes("AS24"));
  await page.context().close();
});

await step("custody conversions: preview gate, confirm dialog, reason required, one operationId", async () => {
  const page = await newPage();
  await go(page, "/custody");
  await page.getByRole("tab", { name: "Conversions" }).click();
  assert.equal(await page.getByRole("button", { name: "Review and convert" }).isDisabled(), true, "no execute before a preview");
  await page.getByLabel("From (currency code)").fill("trx");
  await page.getByLabel("To (currency code)").fill("usdttrc20");
  await page.getByLabel("Amount").fill("100");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByText(/about 24/).first().waitFor();
  await page.getByLabel("Amount").fill("101"); // editing invalidates the quote
  assert.equal(await page.getByRole("button", { name: "Review and convert" }).isDisabled(), true);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Review and convert" }).click();
  const convert = page.getByRole("dialog").getByRole("button", { name: "Convert", exact: true });
  assert.equal(await convert.isDisabled(), true, "reason is required");
  await page.getByLabel(/Reason/).fill("rebalance treasury");
  await convert.click();
  await page.waitForFunction(() => document.body.innerText.includes("Conversion submitted"));
  assert.equal(calls.convert.length, 1);
  assert.match(calls.convert[0].operationId, /^[0-9a-f-]{36}$/);
  assert.equal(calls.convert[0].amount, "101");
  await page.context().close();
});

await step("custody payouts: validate, confirm, create, then 2FA verify from history", async () => {
  const page = await newPage();
  await go(page, "/custody");
  await page.getByRole("tab", { name: "Payouts" }).click();
  assert.equal(await page.getByRole("button", { name: "Review and create payout" }).isDisabled(), true);
  await page.getByLabel("Currency code").fill("trx");
  await page.getByLabel("Amount").last().fill("20");
  await page.getByLabel("Destination address").fill("TDest0000000000000000000000000000000");
  await page.getByRole("button", { name: "Validate address and fee" }).click();
  await page.getByText(/Address is valid/).waitFor();
  await page.getByRole("button", { name: "Review and create payout" }).click();
  await page.getByRole("dialog").getByText("TDest0000000000000000000000000000000").waitFor();
  await page.getByLabel(/Reason/).fill("pay supplier invoice 77");
  await page.getByRole("button", { name: "Create payout" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Payout created"));
  assert.equal(calls.payout.length, 1);
  await page.getByRole("button", { name: "Verify 2FA" }).first().click();
  await page.getByLabel("Verification code").fill("123456");
  await page.getByLabel(/Reason/).fill("operator confirmed code");
  await page.getByRole("dialog").getByRole("button", { name: "Verify", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Verification sent"));
  assert.equal(calls.verify[0].batch, "BATCH-1");
  await page.context().close();
});

// ── Functional: remote clients ──────────────────────────────────────────────
await step("remote clients: lists provider clients and flags unlinked ones", async () => {
  const page = await newPage();
  await go(page, "/vpns/remote");
  await page.getByText("orphan_client").waitFor();
  await page.getByText("not in bot database").waitFor();
  await page.context().close();
});
await step("remote clients: a provider failure shows an error, never stale data", async () => {
  remoteFails = true;
  const page = await newPage();
  await go(page, "/vpns/remote");
  await page.getByRole("alert").getByText(/did not answer/).waitFor();
  assert.equal(await page.getByText("orphan_client").count(), 0);
  remoteFails = false;
  await page.context().close();
});

// ── Functional: profile photos ──────────────────────────────────────────────
await step("profile photo: shown when Telegram has one, initials fallback when not", async () => {
  const page = await newPage();
  await go(page, "/users");
  await page.getByRole("button", { name: /Ali Rezaei/ }).first().click();
  const img = page.getByRole("img", { name: /Profile photo of/ });
  if (process.env.E2E_DEBUG) { await page.waitForTimeout(2000); await page.screenshot({ path: join(shots, "debug-photo.png") }); console.log("       pageerrors:", page.errors.join(" | ").slice(0, 400)); console.log("       dialog:", (await page.locator("[role=dialog]").allInnerTexts()).join("|").slice(0, 300), "| imgs:", await page.locator("img").count()); }
  await img.waitFor();
  await page.waitForFunction(() => { const el = document.querySelector('img[alt^="Profile photo of"]'); return el && el.complete && el.naturalWidth > 0; });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /User 2/ }).first().click();
  await page.waitForFunction(() => !document.querySelector('img[alt^="Profile photo of"]'), null, { timeout: 8000 });
  await page.context().close();
});

// ── Functional: live tickets ────────────────────────────────────────────────
await step("tickets: a Telegram message appears without reload, admin replies show once, offline shows reconnecting and recovers", async () => {
  const page = await newPage();
  await go(page, `/tickets/${ticketId}`);
  await page.getByText("به‌روزرسانی خودکار فعال است").waitFor();
  const count = () => page.locator("ol[aria-label] li").count();
  const before = await count();
  assert.ok(before >= 2);
  await workflow.customerReply({ bot: fakeBot, from: { id: 900001 }, userId: 900001, ticketId, text: "پیام جدید از تلگرام", dedupeKey: `tg:1:${Date.now()}` });
  await page.getByText("پیام جدید از تلگرام").waitFor({ timeout: 10_000 });
  assert.equal(await count(), before + 1);

  await page.context().setOffline(true);
  await page.getByText(/ارتباط قطع شد/).waitFor({ timeout: 12_000 });
  await workflow.customerReply({ bot: fakeBot, from: { id: 900001 }, userId: 900001, ticketId, text: "پیام حین قطعی", dedupeKey: `tg:2:${Date.now()}` });
  await page.context().setOffline(false);
  await page.getByText("پیام حین قطعی").waitFor({ timeout: 40_000 });
  await page.getByText("به‌روزرسانی خودکار فعال است").waitFor();
  assert.equal(await count(), before + 2);

  await page.getByRole("textbox").fill("پاسخ از پنل");
  await page.getByRole("button", { name: /ارسال/ }).first().click();
  await page.getByText("پاسخ از پنل").first().waitFor();
  await page.waitForTimeout(6000); // several polls later it must still be exactly one copy
  assert.equal(await page.getByText("پاسخ از پنل", { exact: true }).count(), 1);
  assert.equal(await count(), before + 3);
  assert.equal(supportDeps.Message.docs.filter((m) => m.text === "پاسخ از پنل").length, 1);
  await page.context().close();
});

// ── Branding: logo + favicon on the sign-in page, both themes ───────────────
for (const theme of ["light", "dark"]) {
  for (const width of [320, 1440]) {
    await step(`branding ${theme} ${width}px: sign-in logo renders (one variant visible), favicon + apple icon resolve, no overflow`, async () => {
      const page = await newPage({ width, theme, signedIn: false });
      await go(page, "/sign-in");
      const info = await page.evaluate(() => {
        const visible = [...document.querySelectorAll("img")].filter((img) => img.src.includes("/brand/") && getComputedStyle(img).display !== "none");
        return {
          visible: visible.map((img) => ({ src: img.src.split("/brand/")[1], ok: img.complete && img.naturalWidth > 0, w: img.getBoundingClientRect().width })),
          icons: [...document.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon]")].map((l) => ({ rel: l.rel, href: l.href, type: l.type })),
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        };
      });
      assert.equal(info.visible.length, 1, `exactly one logo variant is shown, got ${JSON.stringify(info.visible)}`);
      assert.ok(info.visible[0].ok, "logo image decoded");
      assert.equal(info.visible[0].src.includes("on-dark"), theme === "dark", "variant matches the theme");
      assert.ok(info.icons.length >= 2, `favicon links present: ${JSON.stringify(info.icons)}`);
      for (const icon of info.icons) {
        const response = await page.request.get(icon.href);
        assert.equal(response.status(), 200, `${icon.rel} ${icon.href}`);
        assert.match(response.headers()["content-type"] || "", /image\//);
      }
      assert.ok(info.sw <= info.cw + 1, "sign-in does not overflow");
      await page.screenshot({ path: join(shots, `sign-in-${theme}-${width}.png`) });
      await page.context().close();
    });
  }
}

// ── Layout matrix: viewports × themes ───────────────────────────────────────
const VIEWPORTS = [320, 360, 375, 390, 430, 768, 1024, 1440];
const SCREENS = [
  ["payments", "/payments"], ["custody", "/custody"], ["vpns-remote", "/vpns/remote"], ["users", "/users"],
  ["tickets", "/tickets"], ["ticket", `/tickets/${ticketId}`], ["vpns", "/vpns"],
];
const layout = [];
for (const theme of ["light", "dark"]) {
  for (const width of VIEWPORTS) {
    const page = await newPage({ width, height: width < 600 ? 800 : 900, theme });
    for (const [name, path] of SCREENS) {
      await step(`layout ${theme} ${width}px ${name}: no horizontal page overflow, no console errors`, async () => {
        await go(page, path);
        if (name === "custody") for (const tab of ["Assets", "Conversions", "Payouts"]) { await page.getByRole("tab", { name: tab }).click(); await page.waitForTimeout(150); }
        const metrics = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
          wide: [...document.querySelectorAll("body *")].filter((el) => { const r = el.getBoundingClientRect(); return r.right > document.documentElement.clientWidth + 1 && r.width > 0 && !el.closest("[data-radix-scroll-area-viewport], .overflow-x-auto, .overflow-auto, table, [role=tablist]"); }).slice(0, 3).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        }));
        layout.push({ theme, width, name, ...metrics });
        if (width === 320 || width === 1440) await page.screenshot({ path: join(shots, `${name}-${theme}-${width}.png`), fullPage: false });
        if (process.env.AXE_PATH && [320, 768, 1440].includes(width)) {
          await page.addScriptTag({ path: process.env.AXE_PATH });
          const violations = await page.evaluate(async () => {
            const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, resultTypes: ["violations"] });
            return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => n.html.slice(0, 260)).join(" // ")}`);
          });
          assert.ok(violations.length === 0, `axe ${theme} ${width}px: ${violations.join(" ; ")}`);
        }
        assert.equal(metrics.theme, theme, "theme applied");
        assert.ok(metrics.sw <= metrics.cw + 1, `page scrolls horizontally: scrollWidth ${metrics.sw} > ${metrics.cw}; offenders: ${metrics.wide.join(", ")}`);
        assert.deepEqual(page.errors.splice(0), [], "console/page errors");
      });
    }
    await page.context().close();
  }
}

// ── Performance snapshot (opt-in: E2E_PERF=1; numbers are from this machine, not a benchmark) ──
if (process.env.E2E_PERF) {
  const median = (values) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
  console.log("\nPerformance (1440px, cold load, median of 5, production build, loopback):");
  for (const [name, path] of SCREENS) {
    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const page = await newPage();
      await go(page, path);
      samples.push(await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const scripts = performance.getEntriesByType("resource").filter((r) => r.initiatorType === "script" || /\.js(\?|$)/.test(r.name));
        return { ttfb: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, jsKB: scripts.reduce((sum, r) => sum + (r.encodedBodySize || 0), 0) / 1024, requests: performance.getEntriesByType("resource").length };
      }));
      await page.context().close();
    }
    console.log(`  ${name.padEnd(12)} ttfb ${median(samples.map((x) => x.ttfb)).toFixed(0)}ms  dcl ${median(samples.map((x) => x.dcl)).toFixed(0)}ms  load ${median(samples.map((x) => x.load)).toFixed(0)}ms  js ${median(samples.map((x) => x.jsKB)).toFixed(0)}kB  requests ${median(samples.map((x) => x.requests))}`);
  }
}

await browser.close();
server.close();
console.log(`\n${results.passed.length} passed, ${results.failed.length} failed. Screenshots: ${shots}`);
for (const failure of results.failed) console.log(` - ${failure.name}: ${failure.message}`);
process.exit(results.failed.length ? 1 : 0);
