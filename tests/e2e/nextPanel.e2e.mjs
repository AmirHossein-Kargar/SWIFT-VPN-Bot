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
import { basename, join } from "node:path";
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
// A NOWPayments order whose invoice outcome is unknown. Present only while a scenario enables it, so other
// scenarios (row counts, screen matrix) are unaffected. `releases` records every release request the browser sends.
const UNKNOWN_KEY = "nowpayments:NP-UNKNOWN-0001";
let unknownStub = null;
function unknownRow() {
  return {
    key: UNKNOWN_KEY, id: "NP-UNKNOWN-0001", provider: "nowpayments", providerLabel: "NOWPayments", type: "top-up", userId: "77", amount: 500000,
    currency: "Toman", product: "Wallet top-up", trackingCode: null, status: "recovery-required", rawStatus: "creation_unknown",
    createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(), paidAt: null, fulfilledAt: null, retryCount: 0, lastRetryAt: null, nextRetryAt: null,
    lastError: null, recoveryStatus: "required", recoveryReason: "provider_creation_outcome_unknown",
    deletion: { eligible: false, code: "recovery_required", reason: "needs review" },
  };
}
function unknownDetail() {
  return {
    ...unknownRow(),
    timeline: [{ name: "Invoice creation result unknown", at: null, status: "warning", detail: "The provider may hold an invoice for this order." }],
    fulfilled: false, webhookEvents: [], purchase: null,
    actions: {
      retryVerification: false, retryFulfillment: false, manualResolve: false, checkProvider: true, releaseCreationLock: true,
      releaseAvailableAt: new Date(NOW.getTime() - 60_000).toISOString(), providerLookupConfigured: unknownStub.lookupConfigured,
    },
  };
}
function paymentRows() {
  return [...paymentRowsFromModels(), ...(unknownStub ? [unknownRow()] : [])];
}
function paymentRowsFromModels() {
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
const calls = { convert: [], payout: [], verify: [], reply: [], product: [], broadcastPreview: [], broadcast: [] };
const productFixture = { id: "P-1", name: "1-month · 50GB", durationDays: 30, trafficGb: 50, priceToman: 100000, costToman: 60000, profitToman: 40000, enabled: true, published: true, archived: false, archivedAt: null, revision: 3, supportedDuration: true, system: false, references: 0, displayOrder: 0, createdAt: null, updatedAt: null };
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

// Money and list scenarios: `delayMs` holds a response open and `failNext` fails one, so the UI can be observed before the server has answered.
const stub = { delayMs: 0, failNext: false, balance: [], bank: [], recovery: [], usersDelayMs: 0, bankConfirmed: false };
const settle = async () => {
  if (stub.delayMs) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
  if (stub.failNext) { stub.failNext = false; throw new (await_import_AdminServiceError())("The provider did not answer.", { status: 502, code: "provider_unavailable" }); }
};
const BANK_KEY = "bank:BANK-RECEIPT-0002";
const bankDetail = () => {
  const row = paymentRows().find((item) => item.key === BANK_KEY);
  return { ...row, status: stub.bankConfirmed ? "fulfilled" : row.status, rawStatus: stub.bankConfirmed ? "confirmed" : row.rawStatus, timeline: [], fulfilled: stub.bankConfirmed, webhookEvents: [], purchase: null, actions: {} };
};
const recoveryItem = { key: "hooshpay:H-STUCK", provider: "hooshpay", userId: "51", amount: 120000, kind: "verification-pending", retrySafe: true, lastEventAt: NOW.toISOString(), retryCount: 0, lastRetryAt: null };
const analyticsReport = {
  generatedAt: NOW.toISOString(),
  range: { key: "7d", from: new Date(NOW - 7 * 24 * H).toISOString(), to: NOW.toISOString(), days: 7, previous: { from: NOW.toISOString(), to: NOW.toISOString() } },
  granularity: { bucketMs: 24 * H, label: "day" },
  kpis: [],
  series: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ start: new Date(NOW - (6 - i) * 24 * H).toISOString(), topups: 100000 * (i + 1), sales: 50000 * (i + 1), orders: i, newUsers: i })),
  distributions: { providers: [], crypto: [], plans: [] },
  definitions: {},
  unavailable: [],
};
api.get("/users", guard(async (req, res) => {
  if (stub.usersDelayMs) await new Promise((resolve) => setTimeout(resolve, stub.usersDelayMs));
  const search = String(req.query.search || "").toLowerCase();
  const items = search ? users.filter((user) => user.name.toLowerCase().includes(search)) : users;
  ok(res, { items, page: 1, pages: 1, pageSize: 25, total: items.length });
}));
api.post("/users/:id/balance", json, guard(async (req, res) => {
  stub.balance.push(req.body);
  await settle();
  const user = users.find((entry) => entry.telegramId === req.params.id);
  user.balance += req.body.amount;
  ok(res, { balance: user.balance });
}));
api.post("/payments/bank/:paymentId/confirm", json, guard(async (req, res) => {
  stub.bank.push(req.body);
  await settle();
  stub.bankConfirmed = true;
  ok(res, { confirmed: true });
}));
api.get("/recovery", guard((req, res) => ok(res, { items: [recoveryItem], counts: { "verification-pending": 1 }, page: 1, pages: 1, pageSize: 25, total: 1 })));
api.post("/recovery/retry-safe", json, guard(async (req, res) => {
  stub.recovery.push(req.body);
  await settle();
  ok(res, { attempted: 1, succeeded: 1, failed: [] });
}));
api.get("/analytics/report", guard((req, res) => ok(res, analyticsReport)));
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
api.get("/payments/:key", guard((req, res) => {
  if (unknownStub && req.params.key === UNKNOWN_KEY) return ok(res, unknownDetail());
  if (req.params.key === BANK_KEY) return ok(res, bankDetail());
  throw new (await_import_AdminServiceError())("Payment not found.", { status: 404, code: "payment_not_found" });
}));
api.post("/payments/:key/retry", json, guard(async (req, res) => {
  if (!unknownStub || req.params.key !== UNKNOWN_KEY) throw new (await_import_AdminServiceError())("Payment not found.", { status: 404, code: "payment_not_found" });
  unknownStub.retries.push(req.body);
  ok(res, { ok: true, status: "no-payment-found" });
}));
api.post("/payments/:key/release-creation-lock", json, guard(async (req, res) => {
  if (!unknownStub || req.params.key !== UNKNOWN_KEY) throw new (await_import_AdminServiceError())("Payment not found.", { status: 404, code: "payment_not_found" });
  unknownStub.releases.push({ ...req.body, actor: actor(req) });
  await new Promise((resolve) => setTimeout(resolve, 400)); // a window in which a second click would be possible
  // Same contract as the real service: without a usable provider lookup the release needs the explicit attestation.
  if (!unknownStub.lookupConfigured && req.body?.acceptUnverified !== true) {
    throw new (await_import_AdminServiceError())("Provider lookup is not possible; confirm after checking the NOWPayments dashboard.", { status: 409, code: "provider_lookup_required" });
  }
  unknownStub.released = true;
  ok(res, { ok: true, released: true, verifiedWithProvider: unknownStub.lookupConfigured, financialMutation: false });
}));
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

api.get("/tickets", guard(async (req, res) => ok(res, await adminTickets.listSupportTickets({ actorId: actor(req), status: req.query.status, query: req.query.q, unreadOnly: req.query.unread, page: req.query.page, pageSize: req.query.pageSize }))));
api.get("/tickets/:id/updates", guard(async (req, res) => ok(res, await adminTickets.getSupportTicketUpdates({ actorId: actor(req), ticketId: req.params.id, afterId: req.query.after, markRead: req.query.markRead }))));
api.get("/tickets/:id/messages", guard(async (req, res) => ok(res, await adminTickets.getSupportTicketHistory({ actorId: actor(req), ticketId: req.params.id, beforeId: req.query.before, limit: req.query.limit }))));
api.get("/tickets/:id", guard(async (req, res) => ok(res, await adminTickets.getSupportTicket({ actorId: actor(req), ticketId: req.params.id, limit: req.query.limit }))));
api.post("/tickets/:id/reply", json, guard(async (req, res) => { calls.reply.push(req.body); ok(res, await adminTickets.replyToSupportTicket({ actorId: actor(req), operationId: req.body.operationId, ticketId: req.params.id, text: req.body.text, bot: fakeBot, auditModel: audits })); }));
api.post("/tickets/:id/status", json, guard(async (req, res) => ok(res, await adminTickets.setSupportTicketStatus({ actorId: actor(req), operationId: req.body.operationId, ticketId: req.params.id, status: req.body.status, bot: fakeBot, auditModel: audits }))));
// Plans and broadcasts: fixtures only; the point is the browser-side form validation and what the forms submit.
// System health: a controlled fixture (the page reads GET /api/admin/system/health), swapped per test via `healthFixture`.
const healthFixture = { overall: "healthy", services: [], fail: false };
api.get("/system/health", guard((req, res) => {
  if (healthFixture.fail) return res.status(500).json({ ok: false, error: "internal_error" });
  return ok(res, { generatedAt: NOW.toISOString(), overall: healthFixture.overall, services: healthFixture.services, notes: {} });
}));
api.get("/products", guard((req, res) => ok(res, { items: [productFixture], page: 1, pageSize: 20, total: 1, filteredTotal: 1, pages: 1 })));
api.post("/products", json, guard((req, res) => { calls.product.push({ method: "POST", body: req.body }); ok(res, { product: { ...productFixture, ...req.body, id: "P-NEW" } }); }));
api.patch("/products/:id", json, guard((req, res) => { calls.product.push({ method: "PATCH", id: req.params.id, body: req.body }); ok(res, { product: { ...productFixture, ...req.body } }); }));
api.get("/broadcasts", guard((req, res) => ok(res, paged([]))));
api.post("/broadcast/preview", json, guard((req, res) => {
  calls.broadcastPreview.push(req.body);
  ok(res, { preview: { message: req.body.message, lineCount: 1, characterCount: String(req.body.message).length, buttons: req.body.buttons || [] }, warnings: [], validationErrors: [] });
}));
api.post("/broadcast", json, guard((req, res) => { calls.broadcast.push(req.body); ok(res, { started: true }); }));
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

// ── Functional: NOWPayments order with an unknown invoice outcome ───────────
async function openUnknownOrder(page) {
  await go(page, "/payments");
  await page.getByRole("row").filter({ hasText: "NP-UNKNOWN-0001" }).getByRole("button", { name: "View" }).click();
  await page.getByText("Payment detail").waitFor();
}

await step("unknown-outcome order: offers a read-only provider check and its own release, never the generic 'Mark resolved'", async () => {
  unknownStub = { lookupConfigured: true, releases: [], retries: [], released: false };
  try {
    const page = await newPage();
    await openUnknownOrder(page);
    await page.getByRole("button", { name: "Check provider (read-only)" }).waitFor();
    await page.getByRole("button", { name: /Release create-lock/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Mark resolved" }).count(), 0, "the generic resolve is not offered here");
    assert.equal(await page.getByRole("button", { name: /^Retry$/ }).count(), 0);
    await page.getByRole("button", { name: "Check provider (read-only)" }).click();
    await page.getByText(/still locked; release it explicitly/).waitFor();
    assert.equal(unknownStub.retries.length, 1);
    assert.equal(unknownStub.released, false, "an empty lookup result never releases anything");
    assert.equal(unknownStub.releases.length, 0);
    await page.context().close();
  } finally { unknownStub = null; }
});

await step("unknown-outcome release (provider lookup available): reason is mandatory and a double click sends one request", async () => {
  unknownStub = { lookupConfigured: true, releases: [], retries: [], released: false };
  try {
    const page = await newPage();
    await openUnknownOrder(page);
    await page.getByRole("button", { name: /Release create-lock/ }).click();
    const submit = page.getByRole("button", { name: "Check provider and release" });
    assert.equal(await submit.isDisabled(), true, "no reason yet");
    assert.equal(await page.getByText(/Provider lookup is not configured/).count(), 0);
    await page.getByPlaceholder(/Reason, recorded in the audit log/).fill("too short");
    assert.equal(await submit.isDisabled(), true, "9 characters is not enough");
    await page.getByPlaceholder(/Reason, recorded in the audit log/).fill("customer never received the link; checked");
    assert.equal(await submit.isDisabled(), false);
    await submit.dblclick();
    await page.getByText(/Create-lock released \(the provider found no payment\)/).waitFor();
    assert.equal(unknownStub.releases.length, 1, "double click = one request");
    assert.equal(unknownStub.releases[0].acceptUnverified, false);
    assert.equal(unknownStub.releases[0].actor, "424242");
    assert.match(unknownStub.releases[0].reason, /customer never received the link/);
    assert.match(unknownStub.releases[0].operationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(page.errors.splice(0), [], "console/page errors");
    await page.context().close();
  } finally { unknownStub = null; }
});

await step("unknown-outcome release (lookup impossible): needs a written confirmation before an unverified release", async () => {
  unknownStub = { lookupConfigured: false, releases: [], retries: [], released: false };
  try {
    const page = await newPage();
    await openUnknownOrder(page);
    await page.getByRole("button", { name: /Release create-lock/ }).click();
    await page.getByText(/Provider lookup is not configured/).waitFor();
    await page.getByPlaceholder(/Reason, recorded in the audit log/).fill("verified in the NOWPayments dashboard: nothing paid");
    await page.getByRole("button", { name: "Check provider and release" }).click();
    // The server refuses without an attestation; the UI now asks for it explicitly.
    const attest = page.getByRole("checkbox");
    await attest.waitFor();
    await page.getByText(/Provider lookup is not possible/).waitFor();
    const unverified = page.getByRole("button", { name: "Release without provider verification" });
    assert.equal(await unverified.isDisabled(), true, "disabled until the box is ticked");
    assert.equal(unknownStub.releases.length, 1);
    assert.equal(unknownStub.releases[0].acceptUnverified, false, "the first attempt never self-attests");
    assert.equal(unknownStub.released, false);
    await attest.click();
    assert.equal(await unverified.isDisabled(), false);
    await unverified.click();
    await page.getByText(/released on your written confirmation/).waitFor();
    assert.equal(unknownStub.releases.length, 2);
    assert.equal(unknownStub.releases[1].acceptUnverified, true);
    assert.notEqual(unknownStub.releases[1].operationId, unknownStub.releases[0].operationId, "a new operation id per attempt");
    assert.equal(unknownStub.released, true);
    await page.screenshot({ path: join(shots, "unknown-outcome-release.png") });
    assert.deepEqual(page.errors.splice(0), [], "console/page errors");
    await page.context().close();
  } finally { unknownStub = null; }
});

await step("unknown-outcome release is session-, CSRF- and origin-protected", async () => {
  unknownStub = { lookupConfigured: true, releases: [], retries: [], released: false };
  try {
    const url = `${base}/api/admin/payments/${encodeURIComponent(UNKNOWN_KEY)}/release-creation-lock`;
    const body = JSON.stringify({ operationId: "x".repeat(20), reason: "customer never received the link" });
    const headers = { cookie: `${auth.ADMIN_SESSION_COOKIE}=${session.token}`, "content-type": "application/json" };
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401, "no session");
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 403, "no CSRF token");
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "x-csrf-token": "nope" }, body })).status, 403, "wrong CSRF token");
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "x-csrf-token": session.session.csrfToken, origin: "https://evil.example" }, body })).status, 403, "cross-origin");
    assert.equal(unknownStub.releases.length, 0, "none of the refused requests reached the handler");
  } finally { unknownStub = null; }
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

// ── Functional: admin ticket inbox + chat ───────────────────────────────────
const arabicScript = new RegExp(`[${String.fromCharCode(0x600)}-${String.fromCharCode(0x6ff)}]`);
const conversation = (page) => page.getByRole("region", { name: "Conversation" });
const logItems = (page) => conversation(page).locator('[role="log"] li');
const adminMessages = (id, text) => supportDeps.Message.docs.filter((m) => m.ticketId === id && m.author === "admin" && (!text || m.text === text));
let seedKey = 0;
const customerSays = (id, userId, text) => workflow.customerReply({ userId, ticketId: id, text, dedupeKey: `e2e:${++seedKey}:${Date.now()}` });

await step("tickets: English inbox + chat; a Telegram message appears live, offline shows reconnecting and recovers; Enter sends once, Shift+Enter adds a line", async () => {
  const live = await openTicket(910001, "Cannot connect", "Hello, my service does not connect");
  const page = await newPage();
  await go(page, `/tickets?t=${live}`);
  await conversation(page).getByText("Live").waitFor();
  await logItems(page).first().waitFor();
  const before = await logItems(page).count();
  assert.equal(before, 1);

  // Layout: conversation on the left, ticket list on the right; the header names the real customer.
  const convBox = await page.getByRole("region", { name: "Conversation" }).boundingBox();
  const inboxBox = await page.getByRole("region", { name: "Ticket inbox" }).boundingBox();
  assert.ok(convBox.x < inboxBox.x, "conversation is left of the inbox");
  const customer = page.getByTestId("ticket-customer");
  await customer.getByText("Ali Rezaei").waitFor();
  await customer.getByText("@photo_user").waitFor();
  await customer.getByText("910001").waitFor();

  await customerSays(live, 910001, "New message from Telegram");
  await conversation(page).getByText("New message from Telegram").waitFor({ timeout: 10_000 });
  assert.equal(await logItems(page).count(), before + 1);

  await page.context().setOffline(true);
  await conversation(page).getByText("Reconnecting…").waitFor({ timeout: 15_000 });
  await customerSays(live, 910001, "Message during the outage");
  await page.context().setOffline(false);
  await conversation(page).getByText("Message during the outage").waitFor({ timeout: 40_000 });
  await conversation(page).getByText("Live").waitFor();
  assert.equal(await logItems(page).count(), before + 2);

  const box = conversation(page).getByRole("textbox", { name: "Reply to customer" });
  await box.fill("Line one");
  await box.press("Shift+Enter");
  await box.pressSequentially("line two");
  assert.equal(adminMessages(live).length, 0, "Shift+Enter must not send");
  assert.equal(await box.inputValue(), "Line one\nline two");
  await box.press("Enter");
  await conversation(page).getByText("line two").first().waitFor();
  await conversation(page).getByText("Customer notified").waitFor();
  await page.waitForTimeout(7000); // several polls later it must still be exactly one copy
  assert.equal(await logItems(page).count(), before + 3);
  assert.equal(adminMessages(live, "Line one\nline two").length, 1);
  assert.equal(await box.inputValue(), "", "the composer is cleared only after the server accepted the reply");
  assert.equal(fakeBot.calls.filter((c) => c.method === "sendMessage" && String(c.args[0]) === "910001").length >= 1, true, "customer notified in Telegram");
  assert.ok(!sentToAdmin.some((m) => /Line one/.test(String(m.text))), "reply body never goes to an admin chat");
  await page.context().close();
});

await step("tickets: a new ticket arrives in the inbox without reload, shows unread, and opening it clears the count", async () => {
  const page = await newPage();
  await go(page, "/tickets");
  const rows = page.getByRole("list", { name: "Tickets" });
  const fresh = await openTicket(910002, "Fresh ticket", "First message");
  const row = rows.getByRole("button", { name: new RegExp(fresh) });
  await row.waitFor({ timeout: 12_000 });
  await row.getByLabel("1 unread").waitFor();
  assert.ok((await page.getByText(/\d+ unread/).count()) >= 1, "header shows the unread total");
  await row.click();
  await conversation(page).getByText("First message").waitFor();
  await page.waitForTimeout(6500);
  assert.equal(await row.getByLabel(/unread/).count(), 0);
  assert.equal(supportDeps.Ticket.docs.find((t) => t.ticketId === fresh).unreadForAdmin, 0);
  assert.ok(page.url().includes(`t=${fresh}`), "selection is in the URL");
  await page.reload({ waitUntil: "networkidle" });
  await conversation(page).getByText("First message").waitFor();
  await page.context().close();
});

for (const theme of ["light", "dark"]) {
  await step(`tickets: status dropdown is readable (${theme}): canonical options, contrast, keyboard navigation`, async () => {
    const id = await openTicket(910003, `Dropdown ${theme}`, "Status dropdown check");
    const page = await newPage({ theme });
    await go(page, `/tickets?t=${id}`);
    await conversation(page).getByText("Status dropdown check").waitFor();
    const trigger = conversation(page).getByRole("combobox", { name: "Ticket status" });
    await trigger.focus();
    await trigger.press("Enter");
    const listbox = page.getByRole("listbox");
    await listbox.waitFor();
    assert.deepEqual(await page.getByRole("option").allInnerTexts(), ["Open", "Awaiting customer", "Closed"]);
    await page.keyboard.press("ArrowDown");
    const contrast = await page.evaluate(() => {
      const parse = (value) => (value.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const background = parse(getComputedStyle(document.querySelector('[role="listbox"]').parentElement.parentElement).backgroundColor);
      const options = [...document.querySelectorAll('[role="option"]')].map((el) => {
        const style = getComputedStyle(el);
        const bg = parse(style.backgroundColor);
        const surface = bg.length === 4 && bg[3] === 0 ? background : bg;
        return { text: el.textContent, disabled: el.getAttribute("data-disabled") !== null, highlighted: el.getAttribute("data-highlighted") !== null, checked: el.getAttribute("data-state") === "checked", ratio: ratio(parse(style.color), surface) };
      });
      return { options, panel: ratio(parse(getComputedStyle(document.querySelector('[role="listbox"]')).color), background) };
    });
    for (const option of contrast.options) {
      // Disabled options are intentionally dimmed (WCAG exempts inactive controls) but must stay legible at 3:1.
      assert.ok(option.ratio >= (option.disabled ? 3 : 4.5), `${theme}: "${option.text}" contrast ${option.ratio.toFixed(2)}`);
    }
    assert.ok(contrast.options.some((o) => o.highlighted), "keyboard highlight is visible state");
    assert.ok(contrast.options.some((o) => o.checked), "the current value is marked");
    await page.screenshot({ path: join(shots, `ticket-status-dropdown-${theme}.png` ) });
    await page.keyboard.press("Escape");
    await page.context().close();
  });
}

await step("tickets: status change shows success only after the server accepts it; a failure shows an error and keeps the value; close is confirmed, final and idempotent", async () => {
  const id = await openTicket(910004, "Close me", "Please help");
  const page = await newPage();
  await go(page, `/tickets?t=${id}`);
  await conversation(page).getByText("Please help").waitFor();
  const trigger = conversation(page).getByRole("combobox", { name: "Ticket status" });
  const pick = async (name) => { await trigger.click(); await page.getByRole("option", { name }).click(); };
  const rowFor = () => page.getByRole("list", { name: "Tickets" }).getByRole("button", { name: new RegExp(id) });
  const ticketRow = () => supportDeps.Ticket.docs.find((t) => t.ticketId === id);

  await pick("Awaiting customer");
  await page.getByText("Ticket status set to “Awaiting customer”.").waitFor();
  assert.equal(ticketRow().status, "pending_customer");
  assert.equal((await trigger.innerText()).trim(), "Awaiting customer");
  await rowFor().getByText("Awaiting customer").waitFor();
  await pick("Open");
  await page.getByText("Ticket status set to “Open”.").waitFor();
  assert.equal(ticketRow().status, "open");

  // A rejected change: error toast, no success toast, the control keeps the saved value.
  await page.route("**/api/admin/tickets/*/status", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid_transition", message: "This status change is not allowed." }) }));
  await pick("Closed");
  await page.getByRole("alertdialog").getByRole("button", { name: "Close ticket" }).click();
  await page.getByText("This status change is not allowed.").waitFor();
  assert.equal(await page.getByText("Ticket closed.").count(), 0, "no false success");
  assert.equal(ticketRow().status, "open");
  assert.equal((await trigger.innerText()).trim(), "Open");
  await page.unroute("**/api/admin/tickets/*/status");
  await page.keyboard.press("Escape");

  // The real close.
  await pick("Closed");
  const dialog = page.getByRole("alertdialog");
  await dialog.getByText(`Close ticket ${id}?`).waitFor();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(ticketRow().status, "open", "cancel changes nothing");
  await pick("Closed");
  await dialog.getByRole("button", { name: "Close ticket" }).click();
  await page.getByText("Ticket closed.").waitFor();
  const row = ticketRow();
  assert.equal(row.status, "closed");
  assert.equal(row.closedBy, "admin");
  assert.equal(row.closedByAdminId, "424242");
  await conversation(page).getByText(/This ticket was closed on .* by support\. It is read-only and cannot be reopened/).waitFor();
  assert.equal(await conversation(page).getByRole("textbox", { name: "Reply to customer" }).isDisabled(), true);
  assert.equal(await conversation(page).getByRole("button", { name: "Send" }).isDisabled(), true);
  assert.equal(await trigger.isDisabled(), true);
  await rowFor().getByText("Closed").waitFor();

  // Idempotent and final from every other path.
  const repeat = await adminTickets.setSupportTicketStatus({ actorId: "424242", operationId: `op-e2e-repeat-${Date.now()}00`, ticketId: id, status: "closed", bot: fakeBot, auditModel: audits });
  assert.equal(repeat.changed, false);
  await assert.rejects(customerSays(id, 910004, "sneaking in"), { code: "ticket_closed" });
  await assert.rejects(workflow.customerSetStatus({ userId: 910004, ticketId: id, status: "open" }), { code: "reopen_not_allowed" });
  assert.equal(supportDeps.Message.docs.filter((m) => m.ticketId === id).length, 1);
  assert.equal(ticketRow().status, "closed");
  await page.context().close();
});

await step("tickets: long history loads the newest page first, older pages on demand, without duplicates and without losing the reading position", async () => {
  const id = await openTicket(910005, "Long conversation", "message 1");
  for (let i = 2; i <= 90; i += 1) await customerSays(id, 910005, `message ${i}`);
  const page = await newPage();
  await go(page, `/tickets?t=${id}`);
  await conversation(page).getByText("message 90", { exact: true }).waitFor();
  assert.equal(await logItems(page).count(), 40);
  const scroller = conversation(page).locator('[role="log"]');
  const atBottom = await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5);
  assert.equal(atBottom, true, "opens at the newest message");

  const probe = () => scroller.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const li = [...el.querySelectorAll("li")].find((node) => node.getBoundingClientRect().bottom > top + 40);
    return { text: li.querySelector("p")?.textContent, offset: li.getBoundingClientRect().top - top };
  });
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  const anchor = await probe();
  await conversation(page).getByRole("button", { name: "Load earlier messages" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="log"] li').length === 80);
  const afterOffset = await scroller.evaluate((el, text) => {
    const li = [...el.querySelectorAll("li")].find((node) => node.querySelector("p")?.textContent === text);
    return li ? li.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
  }, anchor.text);
  assert.notEqual(afterOffset, null, "the message being read is still rendered");
  assert.ok(Math.abs(afterOffset - anchor.offset) < 4, `reading position kept for ${anchor.text} (${anchor.offset} -> ${afterOffset})`);
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await conversation(page).getByRole("button", { name: "Load earlier messages" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="log"] li').length === 90);
  assert.equal(await conversation(page).getByRole("button", { name: "Load earlier messages" }).count(), 0, "no more history");
  const texts = await scroller.locator("li p[dir=auto]").evaluateAll((nodes) => nodes.map((n) => n.textContent));
  assert.equal(new Set(texts).size, 90, "no duplicates");
  assert.deepEqual(texts, Array.from({ length: 90 }, (_, i) => `message ${i + 1}`), "chronological order");

  // Not at the bottom: a new message does not yank the view; a jump button appears.
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  await customerSays(id, 910005, "message 91");
  await conversation(page).getByRole("button", { name: /1 new message/ }).waitFor({ timeout: 10_000 });
  assert.equal(await scroller.evaluate((el) => el.scrollTop < 50), true, "reader was not moved");
  await conversation(page).getByRole("button", { name: /1 new message/ }).click();
  assert.equal(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 5), true);
  await page.context().close();
});

await step("tickets: the admin ticket UI is English only (customer content is left as sent) in both themes", async () => {
  const id = await openTicket(910006, "اتصال قطع است", "سلام، لطفاً کمک کنید");
  await workflow.adminReply({ bot: fakeBot, adminId: "424242", ticketId: id, text: "Hello from support", dedupeKey: `seed:${++dedupe}` });
  for (const theme of ["light", "dark"]) {
    const page = await newPage({ theme });
    await go(page, `/tickets?t=${id}`);
    await conversation(page).getByText("Hello from support").waitFor();
    const found = await page.evaluate((source) => {
      const pattern = new RegExp(source);
      const offenders = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (pattern.test(node.textContent) && !/^(SCRIPT|STYLE)$/.test(node.parentElement.tagName) && !node.parentElement.closest('[dir="auto"]')) offenders.push(node.textContent.trim().slice(0, 60));
      }
      const attributes = [...document.querySelectorAll("[aria-label], [placeholder], [title], img[alt]")].flatMap((el) => ["aria-label", "placeholder", "title", "alt"].map((a) => el.getAttribute(a) || "")).filter((v) => pattern.test(v));
      return { offenders, attributes, dir: document.documentElement.dir, lang: document.documentElement.lang, rtl: document.querySelectorAll('[dir="rtl"]').length };
    }, arabicScript.source);
    assert.deepEqual(found.offenders, [], `Persian UI text (${theme}): ${JSON.stringify(found.offenders)}`);
    assert.deepEqual(found.attributes, [], `Persian accessible text (${theme})`);
    assert.equal(found.rtl, 0, "no RTL layout in the admin panel");
    assert.notEqual(found.dir, "rtl");
    assert.ok(!/^fa/.test(found.lang));
    await conversation(page).getByText("سلام، لطفاً کمک کنید").waitFor(); // the customer's own words are shown faithfully
    await page.screenshot({ path: join(shots, `ticket-chat-${theme}.png` ) });
    await page.context().close();
  }
});

await step("tickets: phone layout shows the inbox or the conversation, with a way back; browser back restores the inbox", async () => {
  const id = await openTicket(910007, "Phone check", "Hello from a phone");
  const page = await newPage({ width: 375, height: 800 });
  await go(page, "/tickets");
  const rows = page.getByRole("list", { name: "Tickets" });
  await rows.waitFor();
  assert.equal(await page.getByRole("region", { name: "Conversation" }).isVisible(), false, "inbox first on a phone");
  await rows.getByRole("button", { name: new RegExp(id) }).click();
  await conversation(page).getByText("Hello from a phone").waitFor();
  assert.equal(await page.getByRole("region", { name: "Ticket inbox" }).isVisible(), false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, "no horizontal overflow");
  await page.screenshot({ path: join(shots, "ticket-chat-375.png") });
  await page.goBack();
  await rows.waitFor();
  assert.ok(!page.url().includes("t="));
  await rows.getByRole("button", { name: new RegExp(id) }).click();
  await conversation(page).getByRole("button", { name: "Back to inbox" }).click();
  await rows.waitFor();
  await page.context().close();
});

await step("tickets: live updates stop when the admin session is revoked (polling gets 401 and the panel returns to sign-in)", async () => {
  const id = await openTicket(910008, "Session check", "Hello");
  const second = await auth.createAdminSession("424242");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
  const cookie = (path) => ({ ...cookieHeader(path), value: second.token });
  await context.addCookies([cookie("/api/admin"), cookie("/panel")]);
  const page = await context.newPage();
  await go(page, `/tickets?t=${id}`);
  await conversation(page).getByText("Hello").waitFor();
  await auth.deleteAdminSession(second.token);
  await page.waitForURL(/\/panel\/sign-in/, { timeout: 15_000 });
  const polls = [];
  page.on("request", (request) => { if (/\/api\/admin\/tickets/.test(request.url())) polls.push(request.url()); });
  await page.waitForTimeout(8000);
  assert.deepEqual(polls, [], "no further ticket requests after sign-out");
  await context.close();
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

// ── System health: ECG trace reflects the reported status, never invents health ─────────────
const healthService = (name, status, extra = {}) => ({ name, status, latencyMs: status === "unknown" ? null : 12, error: status === "down" ? "connection refused" : null, details: {}, lastCheckedAt: NOW.toISOString(), lastSuccessAt: null, lastFailureAt: null, lastErrorMessage: null, ...extra });
for (const theme of ["light", "dark"]) {
  await step(`system health (${theme}): each status gets its own ECG state, with a text label; unknown and an unrecognised value never look healthy`, async () => {
    healthFixture.overall = "degraded";
    healthFixture.services = [healthService("mongodb", "healthy"), healthService("redis", "degraded"), healthService("telegram", "down"), healthService("webhook", "unknown"), healthService("hooshpay", "something-new")];
    const page = await newPage({ theme, width: 1280 });
    await go(page, "/system-health");
    await page.getByTestId("ecg-mongodb").waitFor();
    const state = (name) => page.getByTestId(`ecg-${name}`).locator("svg").getAttribute("data-ecg");
    assert.equal(await state("mongodb"), "beat");
    assert.equal(await state("redis"), "irregular");
    assert.equal(await state("telegram"), "flatline");
    assert.equal(await state("webhook"), "idle");
    assert.equal(await state("hooshpay"), "idle", "an unrecognised status is shown as unknown, not healthy");
    assert.equal(await page.getByTestId("overall-ecg").locator("svg").getAttribute("data-ecg"), "irregular");
    // Only healthy and degraded animate; down and unknown are static.
    const animated = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-testid^=ecg-]")].map((el) => [el.dataset.testid, !!el.querySelector(".ecg-sweep")])));
    assert.deepEqual(animated, { "ecg-mongodb": true, "ecg-redis": true, "ecg-telegram": false, "ecg-webhook": false, "ecg-hooshpay": false });
    const anim = await page.evaluate(() => ({ healthy: getComputedStyle(document.querySelector("[data-testid=ecg-mongodb] .ecg-sweep")).animationName, duration: getComputedStyle(document.querySelector("[data-testid=ecg-redis] .ecg-sweep")).animationDuration }));
    assert.equal(anim.healthy, "ecg-sweep");
    assert.equal(anim.duration, "4s", "degraded sweeps more slowly");
    // Colour is never the only signal: each card names its status, and the unrecognised value reads "unknown".
    const card = (name) => page.getByTestId(`ecg-${name}`).locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
    assert.match(await card("mongodb").innerText(), /healthy/);
    assert.match(await card("telegram").innerText(), /down/);
    assert.match(await card("hooshpay").innerText(), /unknown/);
    // No overflow or clipping of the waveform, and the same box in every state.
    const geometry = await page.evaluate(() => [...document.querySelectorAll("[data-testid^=ecg-] svg")].map((svg) => { const r = svg.getBoundingClientRect(), p = svg.parentElement.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), inside: r.right <= p.right + 0.5 && r.left >= p.left - 0.5 }; }));
    assert.ok(geometry.every((g) => g.inside && g.h === 28 && g.w === geometry[0].w), JSON.stringify(geometry));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: join(shots, `system-health-${theme}.png`) });
    assert.deepEqual(page.errors.splice(0), []);
    await page.context().close();
  });
}
await step("system health: with prefers-reduced-motion nothing animates and the full trace is drawn; a 320px viewport has no overflow", async () => {
  healthFixture.overall = "healthy";
  healthFixture.services = [healthService("mongodb", "healthy"), healthService("redis", "degraded")];
  const context = await browser.newContext({ viewport: { width: 320, height: 800 }, reducedMotion: "reduce", baseURL: base });
  await context.addCookies([cookieHeader("/api/admin"), cookieHeader("/panel")]);
  const page = await context.newPage();
  await go(page, "/system-health");
  await page.getByTestId("ecg-mongodb").waitFor();
  const motion = await page.evaluate(() => [...document.querySelectorAll(".ecg-sweep")].map((el) => { const s = getComputedStyle(el); return { animationName: s.animationName, dash: s.strokeDasharray }; }));
  assert.ok(motion.length === 3 && motion.every((m) => m.animationName === "none" && m.dash === "none"), JSON.stringify(motion));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: join(shots, "system-health-reduced-320.png") });
  await context.close();
});
await step("system health: an all-unknown report stays neutral (no animated trace, overall not healthy)", async () => {
  healthFixture.overall = "unknown";
  healthFixture.services = [healthService("mongodb", "unknown"), healthService("redis", "unknown")];
  const page = await newPage({ width: 1280 });
  await go(page, "/system-health");
  await page.getByTestId("ecg-mongodb").waitFor();
  assert.equal(await page.locator(".ecg-sweep").count(), 0);
  assert.equal(await page.getByTestId("overall-ecg").locator("svg").getAttribute("data-ecg"), "idle");
  await page.context().close();
});

// ── System health: Telegram diagnostics and order backlog (shapes mirror services/admin/monitoring.js) ──────────
const telegramDetails = (overrides = {}) => ({
  polling: { failing: false, stalled: false, source: "poller", lastErrorAgeSec: null, lastErrorStatus: null, lastErrorCode: null, lastSuccessAgeSec: 4 },
  webhook: { registered: false, pendingUpdates: 0, lastErrorAgeSec: null, lastErrorMessage: null },
  ...overrides,
});
const ordersDetails = (overrides = {}) => ({ awaitingProvider: 0, needsReview: 0, refundPending: 0, stalledProvisioning: 0, ledgerStalled: 0, deliveryPending: 0, alertPending: 0, oldestAwaitingMinutes: null, ...overrides });
const TOKEN_LIKE = /\d{6,}:[A-Za-z0-9_-]{20,}/;
const cardText = (page, name) => page.getByTestId(`ecg-${name}`).locator("xpath=ancestor::*[contains(@class,'rounded')][1]").innerText();

for (const [label, viewport, theme] of [["desktop", { width: 1280, height: 900 }, "light"], ["mobile 375px", { width: 375, height: 800 }, "dark"]]) {
  await step(`system health (${label}): Telegram polling/webhook warnings and the order backlog render accurately, existing cards stay, no overflow, no secrets`, async () => {
    healthFixture.fail = false;
    healthFixture.overall = "down";
    healthFixture.services = [
      healthService("mongodb", "healthy"),
      healthService("redis", "healthy"),
      healthService("wizardxray", "healthy"),
      healthService("telegram", "down", { error: "Another process is polling with this bot token (409 Conflict); keep exactly one replica; A webhook is registered while the bot uses long polling; 250 updates are waiting at Telegram",
        details: telegramDetails({ polling: { failing: true, stalled: false, source: "poller", lastErrorAgeSec: 3, lastErrorStatus: 409, lastErrorCode: "ETELEGRAM", lastSuccessAgeSec: 45 }, webhook: { registered: true, pendingUpdates: 250, lastErrorAgeSec: null, lastErrorMessage: null } }) }),
      healthService("orders", "degraded", { error: "1 order(s) need manual reconciliation with the panel; 2 order(s) waiting for WizardXray funds; 1 admin alert(s) not delivered",
        details: ordersDetails({ awaitingProvider: 2, needsReview: 1, alertPending: 1, oldestAwaitingMinutes: 125 }) }),
      healthService("webhook", "healthy"),
    ];
    const page = await newPage({ ...viewport, theme });
    await go(page, "/system-health");
    await page.getByTestId("details-telegram").waitFor();

    const telegram = await cardText(page, "telegram");
    assert.match(telegram, /down/);
    assert.match(telegram, /Long polling\s+failing/);
    assert.match(telegram, /Last successful poll\s+45 s ago/);
    assert.match(telegram, /Webhook registered\s+yes/);
    assert.match(telegram, /Updates waiting at Telegram\s+250/);
    assert.match(telegram, /409 Conflict/);

    const orders = await cardText(page, "orders");
    assert.match(orders, /degraded/);
    assert.match(orders, /Waiting for provider funds\s+2/);
    assert.match(orders, /Need manual reconciliation\s+1/);
    assert.match(orders, /of which admin alert not delivered\s+1/);
    assert.match(orders, /Created, not delivered\s+0/);
    assert.match(orders, /Oldest waiting\s+125 min/);
    // Warning styling only where the value is non-zero.
    const warned = await page.evaluate(() => [...document.querySelectorAll("[data-testid=details-orders] div")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.className.includes("text-warning")]));
    const warnOf = (label) => warned.find(([name]) => name === label)?.[1];
    assert.equal(warnOf("Waiting for provider funds"), true);
    assert.equal(warnOf("Created, not delivered"), false);

    // Existing cards are intact.
    for (const name of ["mongodb", "redis", "wizardxray", "webhook"]) assert.match(await cardText(page, name), /healthy/);
    assert.equal(await page.getByTestId("details-mongodb").count(), 0, "services without diagnostics get no empty details block");

    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no horizontal overflow");
    assert.equal(TOKEN_LIKE.test(await page.content()), false, "nothing token-shaped reaches the browser");
    assert.equal(await page.evaluate(() => /api\.telegram\.org|BOT_TOKEN/.test(document.documentElement.outerHTML)), false);
    await page.screenshot({ path: join(shots, `system-health-diagnostics-${label.replace(/\W+/g, "-")}.png`), fullPage: true });
    assert.deepEqual(page.errors.splice(0), []);
    await page.context().close();
  });
}
await step("system health: a stalled poller and a healthy bot are labelled differently; a clean ledger shows zeros without warnings", async () => {
  healthFixture.fail = false;
  healthFixture.overall = "degraded";
  healthFixture.services = [
    healthService("telegram", "degraded", { error: "No successful long-poll for 200 s", details: telegramDetails({ polling: { failing: false, stalled: true, source: "poller", lastErrorAgeSec: null, lastErrorStatus: null, lastErrorCode: null, lastSuccessAgeSec: 200 } }) }),
    healthService("orders", "healthy", { details: ordersDetails() }),
  ];
  const page = await newPage({ width: 1280 });
  await go(page, "/system-health");
  await page.getByTestId("details-telegram").waitFor();
  assert.match(await cardText(page, "telegram"), /Long polling\s+stalled/);
  assert.match(await cardText(page, "telegram"), /Last successful poll\s+200 s ago/);
  const ordersCard = await cardText(page, "orders");
  assert.match(ordersCard, /healthy/);
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-testid=details-orders] .text-warning").length), 0, "zero counts carry no warning style");
  // And a healthy bot reads "ok", never "failing".
  healthFixture.services = [healthService("telegram", "healthy", { details: telegramDetails() })];
  await go(page, "/system-health");
  await page.getByTestId("details-telegram").waitFor();
  assert.match(await cardText(page, "telegram"), /Long polling\s+ok/);
  assert.doesNotMatch(await cardText(page, "telegram"), /failing|stalled/);
  await page.context().close();
});
await step("system health: an empty report renders no cards and does not crash; a failing API shows the framework error page, never a healthy state", async () => {
  healthFixture.fail = false;
  healthFixture.overall = "healthy";
  healthFixture.services = [];
  let page = await newPage({ width: 1280 });
  await go(page, "/system-health");
  await page.getByText("System health", { exact: true }).first().waitFor();
  assert.equal(await page.locator("[data-testid^=ecg-]:not([data-testid=overall-ecg])").count(), 0, "no service cards for an empty report");
  assert.deepEqual(page.errors.splice(0), []);
  await page.context().close();

  healthFixture.fail = true;
  try {
    page = await newPage({ width: 1280 });
    const response = await page.goto("/panel/system-health", { waitUntil: "networkidle" });
    assert.ok(response.status() >= 500, `API failure surfaces as a server error page (got ${response.status()})`);
    const text = await page.locator("body").innerText();
    assert.doesNotMatch(text, /\bhealthy\b/i, "a failed fetch never renders a healthy state");
    assert.equal(TOKEN_LIKE.test(await page.content()), false);
    await page.context().close();
  } finally {
    healthFixture.fail = false;
  }
});

// ── Disabled Selects: only those that change data ──────────────────────────
await step("broadcast audience Select works: it opens, every audience is offered, picking the custom list reveals the Telegram IDs field and switching back hides it", async () => {
  const page = await newPage({ width: 1280 });
  await go(page, "/broadcasts");
  const audience = page.getByRole("combobox").first();
  assert.equal(await audience.isDisabled(), false);
  assert.equal((await audience.innerText()).trim(), "All users", "default audience");
  await audience.click();
  assert.deepEqual(await page.getByRole("option").allInnerTexts(), ["All users", "Active in last 30 days", "Has an expired service", "Has paid at least once", "Custom Telegram ID list"]);
  await page.getByRole("option", { name: "Custom Telegram ID list" }).click();
  assert.equal((await audience.innerText()).trim(), "Custom Telegram ID list");
  await page.getByText("Up to 10,000 recipients.").waitFor();
  await audience.focus(); await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Has paid at least once" }).click();
  assert.equal((await audience.innerText()).trim(), "Has paid at least once");
  assert.equal(await page.getByText("Up to 10,000 recipients.").count(), 0);
  await page.context().close();
});
await step("read-only filter Selects stay operable (Users sort still opens)", async () => {
  const page = await newPage({ width: 1280 });
  await go(page, "/users");
  const sort = page.getByRole("combobox", { name: "Sort users" });
  assert.equal(await sort.isDisabled(), false);
  await sort.click();
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("Escape");
  await page.context().close();
});

await step("tickets: the customer in the header opens that user's detail sheet (mouse and keyboard) without leaving the conversation", async () => {
  const id = await openTicket(910020, "Profile link", "Who is this customer?");
  const page = await newPage();
  await go(page, `/tickets?t=${id}`);
  await conversation(page).getByText("Who is this customer?").waitFor();
  const customer = page.getByTestId("ticket-customer");
  await customer.getByText("910020").waitFor();
  assert.equal(await customer.evaluate((el) => el.tagName), "BUTTON", "the profile is a real button, so it is keyboard reachable");

  const requested = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/users/910020") && !request.url().endsWith("/photo"));
  await customer.click();
  await requested;
  const sheet = page.getByRole("dialog");
  await sheet.getByText("Telegram ID 910020").waitFor();
  assert.ok(new URL(page.url()).searchParams.get("t") === id, "the open ticket stays selected");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await conversation(page).getByText("Who is this customer?").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")), "ticket-customer", "focus returns to the profile button when the sheet closes");

  await customer.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByText("Telegram ID 910020").waitFor();
  await page.keyboard.press("Escape");
  await page.context().close();
});

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

// ── Form validation (zod + @hookform/resolvers run in the browser) ───────────────────────────────
// The two forms that use zod. Assertions use the schemas' own messages and what the forms submit; default
// library messages (e.g. for an empty number field) are only asserted to exist, so they may be reworded by a zod upgrade.
const formMessages = (scope) => scope.locator("p[id$='-form-item-message']").allInnerTexts();

await step("plan form: schema messages, coerced numbers, no request while invalid, create and edit bodies", async () => {
  const page = await newPage();
  await go(page, "/products");
  calls.product.length = 0;
  await page.getByRole("button", { name: "Add service" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add service" }).click(); // empty name, price 0
  await dialog.getByText("Name is required").waitFor();
  assert.deepEqual((await formMessages(dialog)).sort(), ["Name is required", "Price must be positive"]);
  assert.equal(calls.product.length, 0, "an invalid form sends nothing");

  await dialog.getByLabel("Name", { exact: true }).fill("x".repeat(121));
  await dialog.getByLabel("Traffic (GB)").fill("100001");
  await dialog.getByLabel("Price (Toman)").fill("2000000001");
  await dialog.getByLabel("Cost (Toman)").fill("-1");
  await dialog.getByLabel("ID (optional)").fill("Bad Id");
  await dialog.getByRole("button", { name: "Add service" }).click();
  await dialog.getByText("Cost cannot be negative").waitFor();
  assert.deepEqual((await formMessages(dialog)).sort(), [
    "Cost cannot be negative", "Must be at most 100,000 GB", "Name must be at most 120 characters", "Price is too large",
    "Use 3–32 lowercase letters, digits or _, starting with a letter",
  ].sort());
  assert.equal(calls.product.length, 0);

  // Duration is a select limited to the bot's four subscription lengths, so it cannot be invalid.
  await dialog.getByLabel("Duration").click();
  assert.deepEqual(await page.getByRole("option").allInnerTexts(), ["30 days", "90 days", "180 days", "365 days"]);
  await page.getByRole("option", { name: "90 days" }).click();

  await dialog.getByLabel("Name", { exact: true }).fill("  E2E plan  ");
  await dialog.getByLabel("ID (optional)").fill("");
  await dialog.getByLabel("Traffic (GB)").fill("10");
  await dialog.getByLabel("Price (Toman)").fill("150000");
  await dialog.getByLabel("Cost (Toman)").fill("90000");
  await dialog.getByRole("switch", { name: "Available for purchase" }).click();
  await dialog.getByRole("button", { name: "Add service" }).click();
  await page.waitForFunction(() => document.body.innerText.includes('"E2E plan" created.'));
  assert.equal(calls.product.length, 1);
  const created = calls.product[0];
  assert.equal(created.method, "POST");
  assert.match(created.body.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...created.body, operationId: undefined }, { operationId: undefined, name: "E2E plan", durationDays: 90, trafficGb: 10, priceToman: 150000, costToman: 90000, enabled: true, published: true, displayOrder: 0 },
    "numbers are submitted as numbers (coerced from the inputs), the name is trimmed");

  await page.getByRole("button", { name: "Actions for 1-month · 50GB" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  assert.equal(await edit.getByLabel("Price (Toman)").inputValue(), "100000");
  await edit.getByLabel("Price (Toman)").fill("120000");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("updated."));
  assert.equal(calls.product.length, 2);
  assert.equal(calls.product[1].method, "PATCH");
  assert.equal(calls.product[1].id, "P-1");
  assert.equal(calls.product[1].body.priceToman, 120000);
  assert.equal(calls.product[1].body.durationDays, 30);
  assert.equal(calls.product[1].body.expectedRevision, 3, "edits echo the revision they were opened with so stale saves are refused");
  await page.context().close();
});

await step("broadcast form: message and button rules, 4-button limit, t.me-only links, what preview and send submit", async () => {
  const page = await newPage();
  await go(page, "/broadcasts");
  calls.broadcastPreview.length = 0;
  calls.broadcast.length = 0;
  const form = page.locator("form").first();
  await form.getByRole("button", { name: "Preview" }).click();
  await page.getByText("Message is required").waitFor();
  assert.equal(calls.broadcastPreview.length, 0, "an invalid form is not previewed");

  const add = form.getByRole("button", { name: "Add button" });
  for (let i = 0; i < 4; i += 1) await add.click();
  assert.equal(await add.isDisabled(), true, "the UI stops at 4 buttons");
  assert.equal(await form.getByPlaceholder("Button text").count(), 4);
  await form.getByRole("button", { name: "Preview" }).click();
  await page.getByText("Button text is required").first().waitFor();
  const messages = await formMessages(form);
  assert.equal(messages.filter((m) => m === "Button text is required").length, 4);
  assert.equal(messages.filter((m) => m === "Must be a valid URL").length, 4);

  await form.getByPlaceholder("What would you like to tell your users?").fill("Hello everyone");
  const texts = form.getByPlaceholder("Button text");
  const urls = form.getByPlaceholder("https://t.me/...");
  await texts.nth(0).fill("Channel");
  await urls.nth(0).fill("https://t.me/swift_shield");
  await texts.nth(1).fill("Evil");
  await urls.nth(1).fill("https://t.me.evil.example/x"); // a valid URL, but not a Telegram link
  await texts.nth(2).fill("x".repeat(65));
  await urls.nth(2).fill("https://telegram.me/swift_shield");
  await form.getByRole("button", { name: "Remove button" }).nth(3).click();
  await form.getByRole("button", { name: "Preview" }).click();
  await page.getByText("Must be a t.me link").waitFor();
  assert.deepEqual((await formMessages(form)).sort(), ["At most 64 characters", "Must be a t.me link"]);
  assert.equal(calls.broadcastPreview.length, 0);

  await urls.nth(1).fill("https://telegram.dog/swift_shield");
  await texts.nth(1).fill("Dog");
  await texts.nth(2).fill("Me");
  await form.getByRole("button", { name: "Preview" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("14 characters"));
  assert.equal(calls.broadcastPreview.length, 1);
  assert.deepEqual(calls.broadcastPreview[0], { message: "Hello everyone", buttons: [
    { text: "Channel", url: "https://t.me/swift_shield" }, { text: "Dog", url: "https://telegram.dog/swift_shield" }, { text: "Me", url: "https://telegram.me/swift_shield" },
  ] });

  await form.getByRole("button", { name: "Send broadcast" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Broadcast started."));
  assert.equal(calls.broadcast.length, 1);
  assert.match(calls.broadcast[0].operationId, /^[0-9a-f-]{36}$/);
  assert.equal(calls.broadcast[0].audience, "all");
  assert.equal(calls.broadcast[0].message, "Hello everyone");
  assert.equal(calls.broadcast[0].buttons.length, 3);
  await page.context().close();
});

// ── Interaction: nothing may look successful before the server has answered ─────
const toasts = (page) => page.locator("[data-sonner-toast]");

await step("wallet credit: no success before the server answers; a failure keeps the dialog and the operationId; the new balance flashes", async () => {
  const page = await newPage();
  await go(page, "/users");
  // CSS, not roles: an open dialog marks the page behind it aria-hidden, and this reads the page behind it.
  const balanceCell = page.locator("tbody tr", { hasText: users[0].telegramId }).locator("td").nth(1);
  const before = await balanceCell.innerText();
  await page.getByRole("button", { name: `Actions for ${users[0].telegramId}` }).click();
  await page.getByRole("menuitem", { name: "Credit wallet" }).click();
  await page.getByLabel("Amount to add (Toman)").fill("50000");
  await page.getByLabel("Reason (kept in the audit log)").fill("Compensation for an outage");
  await page.getByRole("button", { name: "Review" }).click();

  stub.failNext = true;
  await page.getByRole("button", { name: /^Credit / }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert.equal(await page.getByRole("dialog").isVisible(), true, "a failure leaves the dialog open");
  assert.equal(await toasts(page).count(), 0, "no toast on failure");
  assert.equal(await balanceCell.innerText(), before);

  stub.delayMs = 700;
  const confirm = page.getByRole("button", { name: /Applying|^Credit / });
  await confirm.click();
  await page.getByRole("button", { name: "Applying…" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Applying…" }).isDisabled(), true, "the button cannot be pressed twice");
  assert.equal(await page.getByRole("button", { name: "Applying…" }).getAttribute("aria-busy"), "true");
  assert.equal(await toasts(page).count(), 0, "no success while the request is in flight");
  assert.equal(await balanceCell.innerText(), before, "the balance does not move before the server answers");
  await toasts(page).first().waitFor();
  stub.delayMs = 0;
  assert.match(await toasts(page).first().innerText(), /Credited/);
  assert.equal(stub.balance.length, 2);
  assert.equal(stub.balance[0].operationId, stub.balance[1].operationId, "a retry reuses the operationId");
  await page.waitForFunction((value) => {
    const cell = [...document.querySelectorAll("tbody tr")].find((tr) => tr.textContent.includes(value))?.querySelectorAll("td")[1];
    return cell?.querySelector("[data-changed=true]");
  }, users[0].telegramId);
  assert.notEqual(await balanceCell.innerText(), before, "the confirmed balance is shown");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await step("bank receipt: confirming needs a dialog, a double click sends one request, a retry keeps its operationId", async () => {
  const page = await newPage();
  await go(page, "/payments");
  await page.getByRole("row").filter({ hasText: "BANK-RECEIPT-0002" }).getByRole("button", { name: "View" }).click();
  await page.getByRole("button", { name: "Confirm receipt" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /100,000/, "the dialog names the amount");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(stub.bank.length, 0, "cancelling sends nothing");

  await page.getByRole("button", { name: "Confirm receipt" }).click();
  stub.failNext = true;
  await dialog.getByRole("button", { name: /^Credit / }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await toasts(page).count(), 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "bank-confirm-failed.png") });

  stub.delayMs = 500;
  await dialog.getByRole("button", { name: /^Credit / }).dblclick();
  await dialog.getByRole("button", { name: "Confirming…" }).waitFor();
  assert.equal(await toasts(page).count(), 0, "no success while the request is in flight");
  await toasts(page).first().waitFor();
  stub.delayMs = 0;
  assert.equal(stub.bank.length, 2, "one failed attempt, one retry; the double click added nothing");
  assert.equal(stub.bank[0].operationId, stub.bank[1].operationId);
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "Confirm receipt" }).count(), 0, "the action disappears once the server says it is done");
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await step("recovery: retrying asks first, Escape cancels, and the result is reported from the server's answer", async () => {
  const page = await newPage();
  await go(page, "/recovery");
  await page.getByRole("button", { name: "Retry all safe items" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(stub.recovery.length, 0);
  await page.getByRole("button", { name: "Retry all safe items" }).click();
  await dialog.getByRole("button", { name: "Retry" }).click();
  await toasts(page).first().waitFor();
  assert.match(await toasts(page).first().innerText(), /1\/1 retried/);
  assert.equal(stub.recovery.length, 1);
  await page.context().close();
});

await step("filters: the search box keeps focus and the list stays up while results load; an empty result offers Clear filters", async () => {
  const page = await newPage();
  await go(page, "/users");
  stub.usersDelayMs = 700;
  const search = page.getByRole("textbox").first();
  await search.click();
  await page.keyboard.type("nobody");
  await page.locator(".nav-progress").waitFor({ timeout: 3000 });
  assert.equal(await page.locator("main").getAttribute("aria-busy"), "true");
  assert.equal(await page.getByRole("row").filter({ hasText: users[0].telegramId }).count(), 1, "the old list stays while waiting");
  await page.getByText("No users match these filters.").waitFor();
  stub.usersDelayMs = 0;
  assert.equal(await search.evaluate((el) => el === document.activeElement), true, "typing is never interrupted");
  assert.equal(await search.inputValue(), "nobody");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.getByRole("row").filter({ hasText: users[0].telegramId }).waitFor();
  await page.context().close();
});

await step("sections: changing section shows a skeleton, then the page; an empty unfiltered list offers no Clear filters", async () => {
  const page = await newPage();
  await go(page, "/users");
  stub.usersDelayMs = 0;
  await page.route("**/panel/vpns**", async (route) => { await new Promise((resolve) => setTimeout(resolve, 500)); await route.continue(); });
  await page.getByRole("link", { name: "VPN services" }).first().click();
  await page.locator(".skeleton").first().waitFor();
  await page.getByText("No VPN services match these filters.").waitFor();
  assert.equal(await page.getByRole("button", { name: "Clear filters" }).count(), 0);
  await page.context().close();
});

await step("charts: the crosshair tooltip lists every series, series toggle and one always stays", async () => {
  const page = await newPage();
  await go(page, "/analytics");
  const box = await page.locator(".recharts-surface").first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tooltip = page.locator(".recharts-tooltip-wrapper");
  await page.waitForFunction(() => /Top-ups/.test(document.querySelector(".recharts-tooltip-wrapper")?.textContent || ""));
  const text = await tooltip.innerText();
  assert.ok(/Top-ups/.test(text) && /Sales/.test(text) && /Toman/i.test(text), text);
  const topups = page.getByRole("button", { name: /Top-ups/ });
  const sales = page.getByRole("button", { name: /Sales/ });
  await sales.click();
  assert.equal(await sales.getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator(".recharts-area").count(), 1);
  await topups.click();
  assert.equal(await topups.getAttribute("aria-pressed"), "true", "the last visible series cannot be hidden");
  await sales.click();
  assert.equal(await page.locator(".recharts-area").count(), 2);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shots, "analytics-chart.png") });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

await step("reduced motion: page entrance, skeletons and charts do not animate, and the panel still works", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark", reducedMotion: "reduce", baseURL: base });
  await context.addCookies([cookieHeader("/api/admin"), cookieHeader("/panel")]);
  const page = await context.newPage();
  await go(page, "/analytics");
  const duration = await page.locator(".page-enter").evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  assert.ok(duration < 0.01, `page entrance ${duration}s`);
  assert.equal(await page.locator(".recharts-area-curve").first().evaluate((el) => el.getAttribute("stroke-dasharray")?.includes("px") ?? false), false, "the line is not drawn in");
  await page.getByRole("button", { name: /Sales/ }).click();
  assert.equal(await page.locator(".recharts-area").count(), 1);
  await context.close();
});

await step("filters: filtering and clearing never leaves a navigation stuck (a route loading.tsx did, about one time in sixteen)", async () => {
  const warm = await newPage();
  await go(warm, "/users");
  await warm.context().close();
  for (const serverDelay of [700, 0]) {
    for (const wait of [50, 150, 400]) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const page = await newPage();
        await go(page, "/users");
        stub.usersDelayMs = serverDelay;
        await page.getByRole("textbox").first().click();
        await page.keyboard.type("nobody");
        await page.getByText("No users match these filters.").waitFor({ timeout: 5000 });
        stub.usersDelayMs = 0;
        await page.waitForTimeout(wait);
        await page.getByRole("button", { name: "Clear filters" }).click();
        await page.locator("tbody tr").first().waitFor({ timeout: 4000 });
        assert.equal(await page.locator("main").getAttribute("aria-busy"), "false");
        await page.context().close();
      }
    }
  }
});

await step("filters: the catalog search, which had a route loading.tsx, also commits every time", async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const page = await newPage();
    await go(page, "/products");
    const search = page.getByRole("textbox", { name: "Search services" });
    await search.click();
    await page.keyboard.type("nobody");
    await page.waitForFunction(() => location.search.includes("search=nobody"), undefined, { timeout: 4000 });
    await page.waitForTimeout([50, 150, 400][attempt % 3]);
    await search.fill("");
    await page.waitForFunction(() => !location.search.includes("search="), undefined, { timeout: 4000 });
    await page.context().close();
  }
});

await step("no route loading.tsx exists under the signed-in panel", async () => {
  const { readdirSync } = await import("node:fs");
  const found = readdirSync(join(root, "admin-panel/app/(app)"), { recursive: true }).filter((file) => basename(String(file)) === "loading.tsx");
  assert.deepEqual(found, [], "see components/shared/navigation-pending.tsx");
});

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
