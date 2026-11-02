/**
 * Every /panel route, the customer support portal and the storefront, at every target viewport, in a real browser against
 * the REAL Express app, the REAL session and CSRF middleware and a REAL disposable MongoDB, seeded with worst-case values
 * (long names, unbroken ids, mixed-direction text). Only what needs a live provider is a fixture: NOWPayments custody,
 * WizardXray remote clients and a service's live detail. Redis is an in-memory stand-in for sessions. No money moves.
 *
 * Why this exists beside the older suites: `document.documentElement.scrollWidth` cannot see a defect here. In /panel,
 * `<main>` used to be its own scroller, and the storefront's `body { overflow-x: clip }` hides whatever runs past the edge.
 * So this suite measures each element against the viewport, and treats only a real inner scroller (a table, a code block)
 * as allowed to contain something wider than the screen.
 *
 * Run:  npm run build
 *       TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test node tests/e2e/responsive.e2e.mjs
 * Options:
 *   E2E_SHOTS=<dir>        screenshots (full page at 320, 375, 768 and 1440 px)
 *   E2E_ONLY=<regex>       routes or flows whose label matches
 *   E2E_WIDTHS=320,375     a subset of the viewports
 *   E2E_JSON=<file>        machine-readable result of every measurement
 *   E2E_AUDIT=1            report only: exit 0 whatever is found, to measure a baseline
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import express from "express";
import { chromium } from "playwright-core";

process.env.NODE_ENV = "production";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.BOT_USERNAME = "Swift_servicebot";
process.env.HOOSHPAY_API_KEY = "fixture-not-a-real-key";
process.env.HOOSHPAY_WEBHOOK_SECRET = "fixture-webhook-secret";
delete process.env.WIZARD_API_URL;
delete process.env.NOWPAYMENTS_API_KEY;

const root = join(fileURLToPath(import.meta.url), "../../..");
if (!existsSync(join(root, "admin-panel/.next/BUILD_ID"))) { console.log("SKIP: run `npx next build admin-panel` first"); process.exit(0); }
if (!existsSync(join(root, "web/public/storefront.html"))) { console.log("SKIP: run `npm run build:storefront` first"); process.exit(0); }
if (!process.env.TEST_MONGO_URL) { console.log("SKIP: set TEST_MONGO_URL to a disposable MongoDB (database name must contain 'test')"); process.exit(0); }
const CHROME = process.env.CHROME_PATH || ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => existsSync(path));
if (!CHROME) { console.log("SKIP: no Chrome found (set CHROME_PATH)"); process.exit(0); }

const { connectTestDB, disconnectTestDB } = await import("../helpers/db.js");
if (!(await connectTestDB())) { console.log("SKIP: MongoDB not reachable"); process.exit(0); }
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const { makeFakeBot } = await import("../helpers/fakeSupport.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const customerAuth = await import("../../services/support/customerAuth.js");
customerAuth.setCustomerSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");
const { default: User } = await import("../../models/User.js");
const { default: Hoosh } = await import("../../models/HooshPayInvoice.js");
const { default: NowPayments } = await import("../../models/NowPaymentsInvoice.js");
const { default: Bank } = await import("../../models/invoice.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");
const { default: AdminProduct } = await import("../../models/AdminProduct.js");
const { default: AuditLog } = await import("../../models/AdminAuditLog.js");
const { default: Broadcast } = await import("../../models/AdminBroadcast.js");
const { default: MockTestRun } = await import("../../models/MockTestRun.js");
const { default: Finding } = await import("../../models/SentinelFinding.js");
const { default: ReliabilityIncident } = await import("../../models/ReliabilityIncident.js");
const workflow = await import("../../services/support/workflow.js");
const { creditWalletOnce } = await import("../../services/walletCredit.js");
const { runSentinelTick } = await import("../../services/sentinel/reconciler.js");
const { readSentinelConfig } = await import("../../services/sentinel/constants.js");
const { seedDefaultProducts } = await import("../../services/plans.js");
const { HEALTH_CHECKERS } = await import("../../services/admin/monitoring.js");
const { createCollector } = await import("../../services/reliability/collector.js");
const { createIncidentTracker } = await import("../../services/reliability/incidents.js");
const { createStreamHub } = await import("../../services/reliability/stream.js");
const { setReliabilityRuntimeForTests } = await import("../../services/reliability/queries.js");
const { telemetry, observeJob, observeProvider, observeTelegramUpdate } = await import("../../services/reliability/telemetry.js");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms);
const later = (ms) => new Date(Date.now() + ms);
const shots = process.env.E2E_SHOTS || join(tmpdir(), "swift-responsive-shots");
mkdirSync(shots, { recursive: true });
const audit = process.env.E2E_AUDIT === "1";
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

// Values picked to break layouts: no break opportunities, and Persian beside Latin.
const UNBROKEN = "an-unbroken-identifier-0123456789abcdef0123456789abcdef0123456789abcdef";
const LONG_NAME = "Alexander-Maximilian Extremely-Long-Family-Name-For-Wrapping";
const LONG_USERNAME = "very_long_telegram_username_for_layout_checks_01";
const OWNER_ID = "900100001";

// ── Seed ─────────────────────────────────────────────────────────────────────
for (let index = 1; index <= 30; index += 1) {
  const telegramId = String(900100000 + index);
  await User.create({
    telegramId,
    username: index % 3 === 0 ? null : `${LONG_USERNAME.slice(0, 40)}_${index}`,
    firstName: index % 2 ? "علیرضا-عبدالرحمان" : LONG_NAME.split(" ")[0],
    lastName: index % 2 ? "میرزاطاهرخان‌زادهٔ بسیار طولانی" : LONG_NAME.split(" ")[1],
    balance: index * 125_000_000,
    isBanned: index === 7,
    createdAt: ago(index * DAY),
    lastActivityAt: ago(index * HOUR),
    referralCode: index === 2 ? `REF-${UNBROKEN.slice(0, 24)}` : null,
    referredByTelegramId: index > 20 ? "900100002" : null,
    services: index % 2 ? [{ username: `svc_${UNBROKEN.slice(0, 32)}_${index}`, purchaseId: `purchase-${index}`, productId: "s30_50", trafficGb: 500, createdAt: ago(5 * DAY), expiresAt: later((index - 8) * DAY) }] : [],
  });
}
for (let index = 1; index <= 6; index += 1) {
  const uid = `HOOSH-${index}-${UNBROKEN}`;
  await Hoosh.create({ uid, orderId: `order-${index}-${UNBROKEN.slice(0, 40)}`, userId: 900100000 + index, amount: 50_000_000 * index, status: index % 2 ? "paid" : "failed", fulfilled: Boolean(index % 2), balanceCredited: index === 1, paidAt: index % 2 ? ago(index * HOUR) : null, createdAt: ago(index * HOUR) });
}
await NowPayments.create({ orderId: `NP-${UNBROKEN.slice(0, 40)}`, userId: 900100003, amountToman: 500_000, priceAmountCents: 1000, priceCurrency: "usd", payCurrency: "usdttrc20", tomanPerFiat: 50_000, rateSource: "fixture", status: "creation_unknown", createdAt: ago(3 * HOUR) });
await Bank.create({ paymentId: `BANK-${UNBROKEN.slice(0, 40)}`, userId: 900100004, amount: 800_000, status: "rejected" });

await AdminProduct.create({ productId: "long_custom_plan", name: `${LONG_NAME} بسته‌ی فصلی ویژه`, durationDays: 90, trafficGb: 2500, priceToman: 1_250_000_000, costToman: 400_000_000, enabled: true, sortOrder: 1 }).catch(() => {});
await seedDefaultProducts();

async function topUp(telegramId, amount, hoursAgo) {
  const uid = `E2E-${randomUUID().slice(0, 13)}`;
  const at = ago(hoursAgo * HOUR);
  await Hoosh.create({ uid, orderId: `o-${uid}`, userId: Number(telegramId), amount, status: "paid", fulfilled: true, fulfilledAt: at, paidAt: at, creditLedgerVersion: 2, createdAt: new Date(at.getTime() - MIN), webhookLog: [{ receivedAt: at, payload: { status: "paid" } }] });
  await creditWalletOnce({ telegramId, amount, creditKey: `hooshpay:${uid}` });
  await Hoosh.updateOne({ uid }, { $set: { balanceCredited: true, balanceCreditedAt: new Date(at.getTime() + 2_000) } });
}
await User.create({ telegramId: "900200001", firstName: "Fixture", balance: 0, createdAt: ago(20 * DAY) });
await User.create({ telegramId: "900200002", firstName: "Fixture", balance: 0, createdAt: ago(20 * DAY) });
for (const [amount, age] of [[250_000, 60], [180_000, 40], [320_000, 20], [90_000, 6]]) await topUp("900200001", amount, age);
await topUp("900200002", 200_000, 30);
await User.collection.updateOne({ telegramId: "900200002" }, { $inc: { balance: 75_000 } });
await Hoosh.create({ uid: `E2E-LOST-${randomUUID().slice(0, 8)}`, orderId: "o-lost", userId: 900200002, amount: 150_000, status: "paid", fulfilled: true, fulfilledAt: ago(5 * HOUR), paidAt: ago(5 * HOUR), creditLedgerVersion: 2, createdAt: ago(6 * HOUR) });

async function order(status, fields = {}) {
  const purchaseId = randomUUID();
  await WalletPurchase.collection.insertOne({
    purchaseId, telegramId: "900200001", planId: "plan-30", planName: `${LONG_NAME} plan`, gig: 50, days: 30, amount: 120_000, status, walletDebitStatus: "reserved", refundStatus: "none", recoveryStatus: "none",
    retryCount: 0, fulfillmentAttempts: 1, notificationPending: false, createdAt: ago(50 * MIN), reservedAt: ago(50 * MIN), provisioningStartedAt: ago(49 * MIN), events: [], ...fields,
  });
  return purchaseId;
}
for (let index = 0; index < 5; index += 1) await order("completed", { walletDebitStatus: "finalized", createdAt: ago(9 * MIN), reservedAt: ago(8.9 * MIN), provisioningStartedAt: ago(8.8 * MIN), provisionedAt: ago(8.7 * MIN), completedAt: ago(8.6 * MIN), notifiedAt: ago(8.5 * MIN) });
const reviewOrder = await order("manual_review", { errorCode: "PANEL_RESULT_UNKNOWN", recoveryStatus: "required", recoveryReason: "PANEL_RESULT_UNKNOWN", events: [{ at: ago(49 * MIN), type: "provisioning_started", from: "reserved", to: "provisioning" }] });
await order("awaiting_provider", { awaitingProviderSince: ago(45 * MIN), errorCode: "PROVIDER_INSUFFICIENT_BALANCE" });

const operation = (index) => `e2e-responsive-${String(index).padStart(4, "0")}`;
for (let index = 1; index <= 8; index += 1) {
  await AuditLog.create({ operationId: operation(index), actorTelegramId: "424242", action: index % 2 ? "PAYMENTS_DELETED" : "USER_BALANCE_ADJUSTED", targetType: "payment", targetId: `hooshpay:${UNBROKEN}`.slice(0, 120), targetUserId: OWNER_ID, status: index === 3 ? "failed" : "succeeded", ipAddress: "127.0.0.1", errorCode: index === 3 ? "PROVIDER_RESULT_UNKNOWN" : null, metadata: { reason: "layout fixture" }, createdAt: ago(index * HOUR), completedAt: ago(index * HOUR) });
}
for (let index = 1; index <= 3; index += 1) {
  await Broadcast.create({ operationId: operation(100 + index), adminTelegramId: "424242", message: `پیام اطلاع‌رسانی بسیار طولانی ${UNBROKEN} ${"برای بررسی شکستن خط ".repeat(6)}`, audience: index % 2 ? "all" : "custom", status: index === 2 ? "failed" : "completed", total: 15_340, processed: 15_340, succeeded: 15_100, failed: 240, lastErrorCode: index === 2 ? "TELEGRAM_RATE_LIMITED" : null, startedAt: ago(index * DAY), finishedAt: ago(index * DAY - HOUR), createdAt: ago(index * DAY) });
}
await MockTestRun.create({ runId: `run-${UNBROKEN.slice(0, 40)}`, actorTelegramId: "424242", trigger: "web", requestedScenarios: ["card-to-card"], startedAt: ago(HOUR), completedAt: ago(HOUR - MIN), summary: { overall: "FAIL", PASS: 12, FAIL: 1, BLOCKED: 0, SKIPPED: 2, total: 15 }, scenarios: [{ id: "card-to-card", title: "A scenario title long enough to need more than one line on a phone", status: "FAIL", counts: { passed: 12, failed: 1, skipped: 2, total: 15 }, durationMs: 1240, explanation: "An explanation of what went wrong in this mock run.", error: `Assertion failed at ${UNBROKEN}`, assertions: [{ name: "wallet stays untouched", status: "FAIL", expected: UNBROKEN, actual: UNBROKEN.toUpperCase() }] }] });

const bot = makeFakeBot();
const opened = await workflow.customerOpenTicket({ bot, from: { id: Number(OWNER_ID) }, userId: Number(OWNER_ID), subject: "اتصال قطع می‌شود", text: `سلام، لینک سرویس من کار نمی‌کند: vless://${randomUUID()}@a-very-long-server-hostname.example.invalid:443?security=reality&sni=${UNBROKEN}#swift`, dedupeKey: "responsive:open:1", channel: "telegram" });
const ticketId = opened.ticket.ticketId;
await workflow.adminReply({ bot, adminId: "424242", ticketId, text: `Please try this reference: ${UNBROKEN}`, dedupeKey: "responsive:reply:1" });

const tick = await runSentinelTick({ config: readSentinelConfig({ SENTINEL_INTERVAL_SECONDS: "120" }) });
assert.equal(tick.error, null);
const finding = await Finding.findOne({ state: "open" }).lean();
assert.ok(finding, "the injected damage produced a Sentinel finding");

// Reliability runtime: dependencies are probes, orders are real, as in reliability.e2e.mjs.
const healthy = (latencyMs = 3, details) => async () => ({ status: "healthy", latencyMs, error: null, details });
const probes = { mongodb: HEALTH_CHECKERS.mongodb, redis: healthy(2), express: healthy(4), telegram: healthy(140, { webhook: { registered: false, pendingUpdates: 0 } }), wizardxray: async () => ({ status: "down", latencyMs: null, error: `The request timed out: ${UNBROKEN}` }), hooshpay: healthy(0), orders: HEALTH_CHECKERS.orders };
const hub = createStreamHub({ heartbeatMs: 2_000, revalidateMs: 5_000, batchMs: 200, revalidate: async (client) => Boolean(await auth.getAdminSession(client.token)) });
const collector = createCollector({
  env: { ...process.env, SENTINEL_ENABLED: "off", USER_SPEND_SWEEPER: "off", TRX_WALLET: "" },
  config: { enabled: true, intervalMs: 3_000, probeIntervalMs: 3_000 },
  probes, telemetry,
  tracker: createIncidentTracker({ clearTicks: 2 }),
  polling: () => ({ failing: false, stalled: false, lastErrorAgeSec: null, lastErrorStatus: null, lastSuccessAgeSec: 2 }),
  sentinel: async () => ({ health: "healthy" }),
  publish: (snapshot) => hub.publish("snapshot", snapshot),
  eventLoop: { p50Ms: 1, p99Ms: 14, maxMs: 30 },
});
setReliabilityRuntimeForTests({ collector, hub });
telemetry.subscribe((event) => { if (event.severity !== "debug") hub.queueEvent({ ...event, dirty: undefined, seq: undefined }, `${telemetry.instance}:${event.seq}`); });
for (let index = 0; index < 30; index += 1) {
  observeTelegramUpdate();
  telemetry.observe("http.store", { ms: 30 + index });
  telemetry.observe("webhook.hooshpay", { ms: 80 + index * 3 });
  observeProvider("provider.hooshpay", { operation: "invoice verification", ms: 200 + index });
  observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 900 + index * 10 });
  telemetry.observe("telegram.delivery", { ms: 120 });
}
for (const job of ["hooshpay-recovery-cron", "nowpayments-recovery", "invoice-cleanup"]) observeJob(job, { ok: true });
telemetry.emit({ type: "webhook.accepted", component: "webhook", message: `hooshpay callback accepted ${UNBROKEN}`, correlationId: `req-${UNBROKEN.slice(0, 30)}` });
await collector.tick();
await collector.tick();
await collector.tick();

// ── Server: only provider-backed reads are fixtures, ahead of the real app ───
const when = new Date().toISOString();
const paged = (items) => ({ items, total: items.length, page: 1, pages: 1, pageSize: 20, lastSyncedAt: when, balanceError: null });
const hash = "0x" + "ab12".repeat(16);
const address = `T${"Xyz1234567890abcdefghijk".repeat(2).slice(0, 33)}`;
const balances = Array.from({ length: 6 }, (_, index) => ({ code: `usdt${index}`, ticker: `USDT${index}`, name: `Tether on a network with a long descriptive name ${index}`, network: index % 2 ? "TRC20" : "ERC20", availableAmount: 1234567.12345678, availableDisplay: "1,234,567.12345678", pendingAmount: 12.5, pendingDisplay: "12.50000000" }));
const conversions = [{ id: `CV-${UNBROKEN.slice(0, 30)}`, fromCurrency: "trx", toCurrency: "usdttrc20", fromAmountDisplay: "100,000.12345678", toAmountDisplay: "24,100.12345678", rate: 0.241, status: "finished", createdAt: when }];
const payouts = [{ id: `PO-${UNBROKEN.slice(0, 30)}`, batchWithdrawalId: "BATCH-1", currency: "trx", ticker: "TRX", network: "TRX", address, extraId: null, amountDisplay: "50.12345678", fee: 1, status: "waiting", hash: null, createdAt: when }, { id: "PO-2", batchWithdrawalId: "BATCH-2", currency: "trx", ticker: "TRX", network: "TRX", address, extraId: "memo-1", amountDisplay: "10", fee: 1, status: "finished", hash, createdAt: when }];
const deposits = [{ orderId: `NP-${UNBROKEN.slice(0, 30)}`, invoiceId: "5512345678", userId: OWNER_ID, amountToman: 12_500_000, payCurrency: "usdttrc20", ticker: "USDT", status: "partially_paid", balanceCredited: false, recoveryStatus: "required", createdAt: when, paidAt: when }];
const custodyOverview = { lastSyncedAt: when, providerHealth: { status: "healthy", message: "ok" }, capabilities: { apiConfigured: true, ipnConfigured: true, custodyJwtConfigured: true, isOwner: true, apiHealthy: true, balanceEnabled: true, conversionsEnabled: true, payoutsEnabled: true }, balances, totalTrackedAssets: 6, balanceError: null, recentConversions: conversions, conversionsError: null, recentPayouts: payouts, payoutsError: null, localSummary: { finishedCount: 4_321, finishedToman: 3_000_000_000, pendingCount: 12, recoveryRequiredCount: 3, underpaidCount: 1 }, recentDeposits: deposits, reconciliationWarnings: [{ orderId: deposits[0].orderId, userId: OWNER_ID, status: "partially_paid", payCurrency: "usdttrc20", amountToman: 12_500_000 }] };
const assets = Array.from({ length: 12 }, (_, index) => ({ code: `asset${index}`, ticker: `AS${index}`, name: `Asset number ${index} with a long descriptive name`, network: index % 2 ? "TRC20" : "ERC20", enable: true, availableDisplay: `${index}.12345678`, pendingDisplay: "0", hasBalance: index < 5, minAmount: 1, supportedActions: { acceptPayment: true, convert: index < 5, withdraw: index < 5 } }));
const remoteClient = (index) => ({ username: index === 1 ? `client_${UNBROKEN}` : `client_${index}`, status: index % 2 ? "active" : "expired", test: index === 3, unlimited: index === 2, trafficGb: 500, usedGb: 123.45, remainingGb: 376.55, days: 30, daysLeft: index, expiresAt: later(index * DAY).toISOString(), createdAt: when, knownLocally: index % 2 === 0 });
const remote = { source: "wizardxray", fetchedAt: when, page: 1, pageSize: 50, total: 5, pages: 1, count: 5, items: [1, 2, 3, 4, 5].map(remoteClient) };
const vpnDetail = (username) => ({ username, user: { telegramId: OWNER_ID, name: LONG_NAME, username: LONG_USERNAME }, product: `${LONG_NAME} plan`, expiresAt: later(9 * DAY).toISOString(), trafficUsed: "123.45 GB", trafficGb: 500, trafficRemainingGb: 376.55, unlimited: false, status: "active", wizardStatus: "active", wizardXray: { status: "stale", error: `WizardXray returned: ${UNBROKEN}` }, availableActions: { changeLink: true, extendTime: true, increaseTraffic: true, renew: true, enable: false, disable: true, revoke: true } });

const outer = express();
const send = (data) => (_req, res) => res.json({ ok: true, data });
outer.get("/__store-fallback", (_req, res) => res.sendFile(join(root, "web/public/store.html"))); // `/store.html` itself answers with the Next build while one exists
outer.get("/api/admin/custody/overview", send(custodyOverview));
outer.get("/api/admin/custody/assets", send(paged(assets)));
outer.get("/api/admin/custody/conversions", send(paged(conversions)));
outer.get("/api/admin/custody/payouts", send(paged(payouts)));
outer.get("/api/admin/custody/transactions", send(paged(deposits)));
outer.get("/api/admin/vpns-remote/clients", send(remote));
outer.get("/api/admin/vpns/:username", (req, res) => res.json({ ok: true, data: vpnDetail(req.params.username) }));
outer.use(app);

const server = outer.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base; // production trusts configured origins only, never the Host header
const session = await auth.createAdminSession("424242");
const customer = await customerAuth.createCustomerSession(OWNER_ID);
const ticker = setInterval(() => { collector.tick().catch(() => {}); }, 3_000);
ticker.unref();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const adminJson = async (path) => (await (await fetch(`${base}/api/admin${path}`, { headers: { cookie: `${auth.ADMIN_SESSION_COOKIE}=${session.token}` } })).json()).data;
const transactions = await adminJson("/sentinel/transactions");
const transactionKey = transactions?.items?.[0]?.key;
assert.ok(transactionKey, "the Sentinel ledger has a transaction to open");
const incident = await (async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await ReliabilityIncident.findOne({ state: "open" }).lean();
    if (row) return row;
    await collector.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
})();
assert.ok(incident, "the failed probe opened a reliability incident");

// ── Route inventory: adding a page under admin-panel/app without listing it here fails below ─────────────────────────
const ADMIN = [
  "/", "/analytics", "/users", "/vpns", "/vpns/remote", "/payments", "/recovery", "/tickets", `/tickets/${ticketId}`, "/products",
  "/sentinel", "/sentinel/flow", "/sentinel/transactions", `/sentinel/transactions/${encodeURIComponent(transactionKey)}`, "/sentinel/reconciliation", `/sentinel/reconciliation/${finding._id}`,
  "/custody", "/broadcasts", "/referrals", "/audit", "/admins", "/mock-tests",
  "/reliability", "/reliability/events", "/reliability/incidents", `/reliability/incidents/${incident.incidentId}`, "/reliability/orders", `/reliability/orders/${reviewOrder}`, "/reliability/history",
  "/system-health", "/settings",
].map((path) => ({ label: `panel ${path.replace(/[0-9a-f]{20,}|TCK-[\w-]+|hooshpay[^/]*/gi, ":id")}`, path: `/panel${path}`, who: "admin" }));
const PUBLIC = [
  { label: "panel /sign-in", path: "/panel/sign-in", who: "nobody" },
  { label: "portal /support/login", path: "/panel/support/login", who: "nobody" },
  { label: "portal /support", path: "/panel/support", who: "customer", rtl: true },
  { label: "portal /support/new", path: "/panel/support/new", who: "customer", rtl: true },
  { label: "portal /support/:id", path: `/panel/support/${ticketId}`, who: "customer", rtl: true },
  { label: "store /", path: "/", who: "nobody", rtl: true },
  { label: "store fallback page", path: "/__store-fallback", who: "nobody", rtl: true, staticPage: true },
  { label: "store 404", path: "/no-such-page", who: "nobody", rtl: true, status: 404, staticPage: true },
];
const ROUTES = [...ADMIN, ...PUBLIC];

const WIDTHS = [[320, 640], [375, 812], [430, 932], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]]
  .filter(([width]) => !process.env.E2E_WIDTHS || process.env.E2E_WIDTHS.split(",").map(Number).includes(width));
const SHOT_WIDTHS = new Set([320, 375, 768, 1440]);

// Reduced motion on purpose: the storefront's scroll reveal keeps everything below the fold at opacity 0 otherwise, and what is invisible here goes unmeasured.
async function newPage({ width, height, who = "admin", theme = "dark", touch = width < 1024, bypassCSP = false }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce", baseURL: base, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1, locale: "en-US", bypassCSP });
  const cookies = [];
  if (who === "admin") cookies.push(...["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  if (who === "customer") cookies.push(...["/api/support", "/panel"].map((path) => ({ name: customerAuth.CUSTOMER_SESSION_COOKIE, value: customer.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  if (cookies.length) await context.addCookies(cookies);
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* storage can be blocked */ } }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|net::ERR|EventSource/.test(message.text())) errors.push(`console: ${message.text().slice(0, 200)}`); });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400 && url.startsWith(base) && !/iranyekanx|\/photo\b|favicon|no-such-page/.test(url)) errors.push(`http ${response.status()} ${url.replace(base, "").slice(0, 100)}`);
  });
  return { page, context, errors };
}

async function open(page, path, { staticPage = false } = {}) {
  const response = await page.goto(path, { waitUntil: "load" });
  if (!staticPage) await page.waitForFunction(() => document.documentElement.dataset.hydrated !== undefined || document.querySelector("main, form, h1") !== null, null, { timeout: 15_000 });
  await page.waitForTimeout(450); // charts and the catalog settle; the live stream means there is no network idle here
  return response;
}

/** Runs in the page. Everything is measured against the viewport, never against a container that could be hiding it. */
function measure({ phone }) {
  const viewport = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const describe = (element) => {
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const text = (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${text ? ` "${text}"` : ""}`;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.01;
  };
  // A scroller that contains the overrun is fine, unless it is the page's own frame.
  const insideScroller = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.tagName === "MAIN") continue;
      const overflow = getComputedStyle(parent).overflowX;
      if (overflow === "visible") continue;
      const rect = parent.getBoundingClientRect();
      if (rect.left >= -1 && rect.right <= viewport + 1) return true;
    }
    return false;
  };
  const all = [...document.body.querySelectorAll("*")].filter((element) => !element.closest("[hidden], template, script, style, .sr-only, [data-radix-popper-content-wrapper]"));
  const overrun = [];
  const clipped = [];
  const scrollers = [];
  for (const element of all) {
    if (!visible(element)) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.position !== "fixed" && !element.closest('[aria-hidden="true"]') && (rect.right > viewport + 1 || rect.left < -1) && !insideScroller(element)) overrun.push(`${describe(element)} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
    if (element.childElementCount === 0 && (element.textContent || "").trim() && style.overflowX === "visible" && !element.closest('[aria-hidden="true"]')) {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.overflowX === "visible") continue;
        const box = parent.getBoundingClientRect();
        if (["auto", "scroll"].includes(parentStyle.overflowX) || parentStyle.textOverflow === "ellipsis" || box.width <= 1) break; // A scroller, a visible ellipsis, or the hidden header of a card table
        if (rect.right > box.right + 1 || rect.left < box.left - 1) clipped.push(`${describe(element)} cut by ${describe(parent)}`);
        break;
      }
    }
    if (element.scrollWidth > element.clientWidth + 1 && style.overflowX !== "visible") {
      if (["auto", "scroll"].includes(style.overflowX) && element.tagName !== "MAIN") {
        scrollers.push({ element: describe(element), client: element.clientWidth, scroll: element.scrollWidth, focusable: element.tabIndex >= 0 || element.querySelector("a, button, input, select, textarea, [tabindex]") !== null });
      } else if (style.overflowX !== "auto" && style.overflowX !== "scroll" && element.childElementCount === 0 && style.textOverflow !== "ellipsis") {
        clipped.push(`${describe(element)} ${element.clientWidth}/${element.scrollWidth}`);
      }
    }
  }
  const controls = all.filter((element) => element.matches('a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="combobox"], [role="menuitem"]') && visible(element) && !element.disabled);
  const covered = [];
  const small = [];
  for (const element of controls) {
    const rect = element.getBoundingClientRect();
    const onScreen = rect.top >= 0 && rect.left >= 0 && rect.bottom <= height && rect.right <= viewport;
    if (onScreen) {
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      // Passing under the sticky header while scrolled is what a sticky header does; anything else on top of a control is a defect.
      if (hit && hit !== element && !element.contains(hit) && !hit.contains(element) && !element.closest("label")?.contains(hit) && !hit.closest("header")) covered.push(`${describe(element)} under ${describe(hit)}`);
    }
    // WCAG's inline exception: a link inside running text sizes with the text.
    const inline = element.tagName === "A" && getComputedStyle(element).display === "inline" && /\S/.test(element.parentElement?.textContent.replace(element.textContent, "") ?? "");
    // A checkbox stays a small mark and carries a larger hit area on ::after, which no bounding box reports; 24 px is the WCAG 2.2 AA floor.
    const box = element.matches('[role="checkbox"], [role="switch"], [type="checkbox"], [type="radio"], [role="radio"]');
    const minimum = box ? 16 : 44;
    if (phone && !inline && rect.height < minimum) small.push(`${describe(element)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }
  const main = document.querySelector("main");
  const fixed = all.filter((element) => ["fixed", "sticky"].includes(getComputedStyle(element).position) && visible(element)).map((element) => ({ element: describe(element), height: Math.round(element.getBoundingClientRect().height) }));
  return {
    viewport,
    pageOverflow: document.documentElement.scrollWidth - viewport,
    mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
    mainPadding: main ? getComputedStyle(main).paddingLeft : null,
    direction: getComputedStyle(document.querySelector("main") ?? document.documentElement).direction,
    rows: document.querySelectorAll("tbody tr").length,
    tables: document.querySelectorAll("table").length,
    overrun: [...new Set(overrun)].slice(0, 10),
    overrunCount: new Set(overrun).size,
    clipped: [...new Set(clipped)].slice(0, 6),
    scrollers: scrollers.slice(0, 8),
    covered: [...new Set(covered)].slice(0, 8),
    small: [...new Set(small)].slice(0, 10),
    smallCount: new Set(small).size,
    fixed: fixed.slice(0, 5),
  };
}

const results = [];
const failures = [];
function record(label, width, problems, data) {
  results.push({ label, width, problems, ...data });
  if (problems.length) failures.push({ label, width, problems });
  console.log(`  ${problems.length ? "FAIL" : "ok  "} ${label} @${width}${problems.length ? `\n       ${problems.join("\n       ")}` : ""}`);
}

function judge(metrics, errors, route) {
  const problems = [];
  if (metrics.pageOverflow > 1) problems.push(`page overflows by ${metrics.pageOverflow}px`);
  if (metrics.mainOverflow > 1) problems.push(`<main> overflows by ${metrics.mainOverflow}px`);
  if (metrics.overrunCount) problems.push(`${metrics.overrunCount} elements run past the viewport: ${metrics.overrun.slice(0, 3).join("; ")}`);
  if (metrics.covered.length) problems.push(`covered controls: ${metrics.covered.slice(0, 3).join("; ")}`);
  if (metrics.clipped.length) problems.push(`clipped without ellipsis: ${metrics.clipped.slice(0, 3).join("; ")}`);
  if (metrics.smallCount) problems.push(`${metrics.smallCount} controls under the touch minimum: ${metrics.small.slice(0, 3).join("; ")}`);
  if (metrics.scrollers.some((scroller) => !scroller.focusable)) problems.push(`scroller not reachable by keyboard: ${metrics.scrollers.filter((scroller) => !scroller.focusable).map((scroller) => scroller.element).join("; ")}`);
  // Passing the checks above is not enough for a table: its last columns are the status and the actions, and from a tablet up they must be on screen.
  if (metrics.viewport >= 768 && metrics.scrollers.some((scroller) => scroller.element.includes("scroll-region"))) problems.push(`a table scrolls sideways: ${metrics.scrollers.map((scroller) => `${scroller.client}/${scroller.scroll}`).join(", ")}`);
  if (route.rtl && metrics.direction !== "rtl") problems.push(`expected rtl, got ${metrics.direction}`);
  if (errors.length) problems.push(...[...new Set(errors)].slice(0, 4));
  return problems;
}

// ── 1. The inventory is complete ─────────────────────────────────────────────
if (!only || only.test("inventory")) {
  const { readdirSync } = await import("node:fs");
  const appDir = join(root, "admin-panel/app");
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name === "page.tsx" ? [dir] : []);
  const pages = walk(appDir).map((dir) => dir.slice(appDir.length).replace(/\\/g, "/").replace(/\/\([^)]*\)/g, "") || "/");
  const known = ROUTES.map((route) => route.label.replace(/^(panel|portal) /, ""));
  const toPattern = (page) => new RegExp(`^${page.replace(/\[[^\]]+\]/g, "[^/]+")}$`);
  const missing = pages.filter((page) => !known.some((label) => toPattern(page).test(label)));
  record("inventory: every page.tsx is in the route list", 0, missing.map((page) => `not covered: ${page}`), {});
}

// ── 2. Every route at every viewport ─────────────────────────────────────────
for (const [width, height] of WIDTHS) {
  for (const route of ROUTES) {
    if (only && !only.test(route.label)) continue;
    const { page, context, errors } = await newPage({ width, height, who: route.who, theme: width % 2 ? "dark" : "light" });
    let problems = [];
    let metrics = {};
    try {
      const response = await open(page, route.path, route);
      assert.equal(response.status(), route.status ?? 200, `HTTP ${response.status()}`);
      assert.ok(!/\/sign-in/.test(page.url()) || route.path.includes("sign-in"), `signed out: ${page.url()}`);
      metrics = await page.evaluate(measure, { phone: width < 1024 });
      problems = judge(metrics, route.status ? errors.filter((text) => !/http 404/.test(text)) : errors, route);
      if (SHOT_WIDTHS.has(width)) await page.screenshot({ path: join(shots, `${route.label.replace(/[^\w]+/g, "_")}-${width}.png`), fullPage: true });
    } catch (error) {
      problems = [`crashed: ${String(error?.message || error).split("\n")[0]}`];
    }
    record(route.label, width, problems, { metrics });
    await context.close();
  }
}

// ── 3. What only opens on interaction ─────────────────────────────────────────
/** Every open dialog, sheet, menu and listbox: inside the viewport, with nothing inside it wider than itself. */
function floating() {
  const viewport = document.documentElement.clientWidth;
  const height = window.innerHeight;
  const layers = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')].filter((element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 1;
  });
  return layers.map((layer) => {
    const rect = layer.getBoundingClientRect();
    const inner = [...layer.querySelectorAll("*")].filter((element) => {
      const box = element.getBoundingClientRect();
      if (box.width <= 1 || element.closest('.sr-only, [aria-hidden="true"]')) return false; // Radix keeps a hidden native input beside each switch
      for (let parent = element.parentElement; parent && parent !== layer; parent = parent.parentElement) if (getComputedStyle(parent).overflowX !== "visible") return false;
      return box.right > rect.right + 1 || box.left < rect.left - 1;
    });
    const close = [...layer.querySelectorAll("button")].find((button) => /close/i.test(button.textContent));
    return {
      role: layer.getAttribute("role"),
      rect: [rect.left, rect.top, rect.right, rect.bottom].map(Math.round),
      inView: rect.left >= -1 && rect.top >= -1 && rect.right <= viewport + 1 && rect.bottom <= height + 1,
      overflow: layer.scrollWidth - layer.clientWidth,
      inner: inner.slice(0, 3).map((element) => `${element.tagName.toLowerCase()} "${(element.textContent || "").trim().slice(0, 30)}"`),
      closeSize: close ? [Math.round(close.getBoundingClientRect().width), Math.round(close.getBoundingClientRect().height)] : null,
    };
  });
}

function assertFloating(layers, what) {
  assert.ok(layers.length > 0, `${what}: nothing opened`);
  for (const layer of layers) {
    assert.ok(layer.inView, `${what}: ${layer.role} leaves the viewport ${JSON.stringify(layer.rect)}`);
    assert.ok(layer.overflow <= 1, `${what}: ${layer.role} scrolls sideways by ${layer.overflow}px`);
    assert.deepEqual(layer.inner, [], `${what}: content wider than the ${layer.role}`);
  }
}

async function flow(label, { width = 375, height = 812, who = "admin", touch = width < 1024, bypassCSP = false }, run) {
  if (only && !only.test(label)) return;
  const { page, context, errors } = await newPage({ width, height, who, touch, bypassCSP });
  let problems = [];
  try {
    await run(page, context);
    if (errors.length) problems = [...new Set(errors)].slice(0, 4);
  } catch (error) {
    problems = [String(error?.message || error).split("\n").slice(0, 14).join(" | ").slice(0, 900)];
    await page.screenshot({ path: join(shots, `FAILED-${label.replace(/[^\w]+/g, "_").slice(0, 60)}-${width}.png`) }).catch(() => {});
  }
  record(`flow: ${label}`, width, problems, {});
  await context.close();
}

const shot = (page, name) => page.screenshot({ path: join(shots, `flow-${name}.png`) });
const closeLayer = async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(250); };

for (const width of [320, 375]) {
  const height = width === 320 ? 640 : 812;

  await flow("navigation drawer lifecycle", { width, height }, async (page) => {
    await open(page, "/panel/payments");
    const menu = page.getByRole("button", { name: "Open navigation" });
    const lockedBefore = await page.evaluate(() => document.body.hasAttribute("data-scroll-locked"));
    assert.equal(lockedBefore, false);
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    await menu.click();
    const drawer = page.getByRole("dialog");
    await drawer.waitFor();
    await page.waitForTimeout(350);
    assert.equal(await menu.getAttribute("aria-expanded", { timeout: 2000 }).catch(() => "true"), "true");
    const metrics = await drawer.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const links = [...element.querySelectorAll("a")];
      return { width: rect.width, left: rect.left, right: rect.right, links: links.length, smallest: Math.min(...links.map((link) => link.getBoundingClientRect().height)), active: links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent.trim()) };
    });
    assert.equal(metrics.left, 0, "the drawer opens from the side its button is on");
    assert.ok(metrics.width <= width * 0.9, `the drawer leaves page visible: ${metrics.width} of ${width}`);
    assert.ok(metrics.smallest >= 44, `drawer links are touch sized: ${metrics.smallest}`);
    assert.deepEqual(metrics.active, ["Payments"], "the active route is marked");
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-scroll-locked")), true, "the page behind cannot scroll");
    assertFloating(await page.evaluate(floating), "drawer");
    await shot(page, `drawer-${width}`);

    // The last link is reachable on a short screen.
    await drawer.getByRole("link", { name: "Settings" }).scrollIntoViewIfNeeded();
    assert.ok(await drawer.getByRole("link", { name: "Settings" }).isVisible());

    // Escape, and focus goes back to the button that opened it.
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open navigation", null, { timeout: 2_000 });
    assert.equal(await page.evaluate(() => document.body.hasAttribute("data-scroll-locked")), false, "scroll comes back");

    // The backdrop closes it.
    await menu.click();
    await drawer.waitFor();
    await page.waitForTimeout(350);
    await page.mouse.click(width - 8, height / 2);
    await drawer.waitFor({ state: "hidden" });

    // Choosing a link navigates and closes it.
    await menu.click();
    await drawer.getByRole("link", { name: "Users" }).click();
    await page.waitForURL(/\/panel\/users/);
    await drawer.waitFor({ state: "hidden" });
    await page.getByRole("combobox", { name: "Sort users" }).waitFor();

    // Browser back with the drawer open closes it rather than leaving it over the old page.
    await menu.click();
    await drawer.waitFor();
    await page.goBack();
    await page.waitForURL(/\/panel\/payments/);
    await drawer.waitFor({ state: "hidden" });
  });

  await flow("top bar stays in reach on a long page", { width, height }, async (page) => {
    await open(page, "/panel/users");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(150);
    const box = await page.getByRole("button", { name: "Open navigation" }).boundingBox();
    assert.ok(box && box.y >= 0 && box.y < 60, `the menu button stays on screen: ${JSON.stringify(box)}`);
    const covered = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main.scrollWidth - main.clientWidth;
    });
    assert.ok(covered <= 1);
  });

  for (const [name, path, opener] of [
    ["user detail", "/panel/users", (page) => page.locator("tbody button").filter({ hasText: /900100/ }).first()],
    ["payment detail", "/panel/payments", (page) => page.getByRole("button", { name: "View details" }).first()],
    ["VPN service detail", "/panel/vpns", (page) => page.locator("tbody button").first()],
    ["audit entry", "/panel/audit", (page) => page.locator("tbody button").first()],
    ["admin detail", "/panel/admins", (page) => page.locator("main button").filter({ hasText: "424242" }).first()],
  ]) {
    await flow(`${name} sheet`, { width, height }, async (page) => {
      await open(page, path);
      await opener(page).click();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      await page.waitForTimeout(800);
      const layers = await page.evaluate(floating);
      assertFloating(layers, name);
      assert.deepEqual(layers[0].closeSize, [44, 44], `${name}: the close button is touch sized`);
      await shot(page, `sheet-${name.replace(/\W+/g, "-")}-${width}`);
      await closeLayer(page);
      assert.equal(await sheet.count(), 0, "Escape closes it");
    });
  }

  await flow("row menu and filter select fit a phone", { width, height }, async (page) => {
    await open(page, "/panel/users");
    await page.getByRole("button", { name: /^Actions for/ }).first().click();
    await page.getByRole("menu").waitFor();
    await page.waitForTimeout(250);
    assertFloating(await page.evaluate(floating), "row menu");
    const items = await page.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    assert.ok(Math.min(...items) >= 44, `menu items are touch sized: ${Math.min(...items)}`);
    await shot(page, `row-menu-${width}`);
    await closeLayer(page);
    await page.getByRole("combobox", { name: "Sort users" }).click();
    await page.getByRole("listbox").waitFor();
    await page.waitForTimeout(250);
    assertFloating(await page.evaluate(floating), "filter select");
    await closeLayer(page);
    await page.getByRole("button", { name: /Account menu/ }).click();
    await page.getByRole("menu").waitFor();
    await page.waitForTimeout(250);
    assertFloating(await page.evaluate(floating), "account menu");
  });

  await flow("service form stays usable under a mobile keyboard", { width, height }, async (page) => {
    await open(page, "/panel/products");
    await page.getByRole("button", { name: "Add service" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.waitForTimeout(300);
    assertFloating(await page.evaluate(floating), "service form");
    await shot(page, `product-form-${width}`);
    // A software keyboard takes about 40% of the height. `interactive-widget=resizes-content` makes that a resize.
    await page.setViewportSize({ width, height: Math.round(height * 0.55) });
    await dialog.getByLabel("Name", { exact: true }).focus();
    await page.waitForTimeout(250);
    assertFloating(await page.evaluate(floating), "service form with a keyboard");
    const submit = dialog.getByRole("button", { name: "Add service" });
    const footer = await submit.boundingBox();
    assert.ok(footer && footer.y + footer.height <= Math.round(height * 0.55) + 1, `the submit button stays on screen: ${JSON.stringify(footer)}`);
    const focused = await page.evaluate(() => { const box = document.activeElement.getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight; });
    assert.ok(focused, "the focused field is on screen");
    await shot(page, `product-form-keyboard-${width}`);
  });

  await flow("confirmation dialog fits and cancels", { width, height }, async (page) => {
    await open(page, "/panel/recovery");
    const retry = page.getByRole("button", { name: "Retry all safe items" });
    assert.ok(await retry.isVisible(), "the bulk action is on screen");
    await retry.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor();
    await page.waitForTimeout(250);
    assertFloating(await page.evaluate(floating), "confirmation");
    await shot(page, `confirm-${width}`);
    await dialog.getByRole("button", { name: "Cancel" }).click(); // never confirmed: this suite moves no money
    await dialog.waitFor({ state: "hidden" });
  });

  await flow("settings and custody tabs", { width, height }, async (page) => {
    for (const [path, names] of [
      ["/panel/settings", ["General", "Appearance", "Security", "Notifications", "Payments", "VPN", "System", "Audit"]],
      ["/panel/custody", ["Overview", "Assets", "Conversions", "Payouts", "Transactions"]],
    ]) {
      await open(page, path);
      for (const name of names) {
        await page.getByRole("tab", { name, exact: true }).click();
        await page.waitForTimeout(400);
        const metrics = await page.evaluate(measure, { phone: true });
        const problems = judge({ ...metrics, smallCount: 0 }, [], {});
        assert.deepEqual(problems, [], `${path} ${name}`);
        await page.screenshot({ path: join(shots, `tab-${path.split("/").pop()}-${name}-${width}.png`), fullPage: true });
      }
    }
  });

  await flow("reliability list and diagram views", { width, height }, async (page) => {
    await open(page, "/panel/reliability");
    for (const name of ["List", "Diagram"]) {
      const toggle = page.getByRole("button", { name, exact: true });
      if (!(await toggle.isVisible())) continue; // Phones get the list only.
      await toggle.click();
      await page.waitForTimeout(350);
      const metrics = await page.evaluate(measure, { phone: true });
      assert.deepEqual(judge({ ...metrics, smallCount: 0 }, [], {}), [], name);
      await page.screenshot({ path: join(shots, `reliability-${name}-${width}.png`), fullPage: true });
    }
  });

  await flow("ticket: inbox, conversation and back on a phone", { width, height }, async (page) => {
    await open(page, "/panel/tickets");
    await page.locator('[aria-label="Tickets"] button').first().click();
    const box = page.locator('section[aria-label="Conversation"] textarea');
    await box.waitFor({ timeout: 8_000 });
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(measure, { phone: true });
    assert.deepEqual(judge({ ...metrics, smallCount: 0 }, [], {}), []);
    await page.setViewportSize({ width, height: Math.round(height * 0.6) });
    await box.focus();
    await page.waitForTimeout(200);
    const reply = await box.boundingBox();
    assert.ok(reply && reply.y + reply.height <= Math.round(height * 0.6) + 1, `the reply box stays above the keyboard: ${JSON.stringify(reply)}`);
    await shot(page, `ticket-${width}`);
  });

  await flow("sign-in form under a mobile keyboard", { width, height: Math.round(height * 0.55), who: "nobody" }, async (page) => {
    await open(page, "/panel/sign-in");
    const metrics = await page.evaluate(measure, { phone: true });
    assert.deepEqual(judge(metrics, [], {}), []);
  });

  await flow("customer: new ticket form under a mobile keyboard", { width, height: Math.round(height * 0.55), who: "customer" }, async (page) => {
    await open(page, "/panel/support/new");
    const metrics = await page.evaluate(measure, { phone: true });
    assert.deepEqual(judge(metrics, [], {}), []);
    assert.equal(metrics.direction, "rtl");
  });

  await flow("store: mobile menu", { width, height, who: "nobody" }, async (page) => {
    await open(page, "/");
    await page.waitForFunction(() => document.documentElement.dataset.hydrated !== undefined);
    const menu = page.locator('button[aria-controls="mobile-nav"]');
    await menu.click();
    const panel = page.locator("#mobile-nav");
    await panel.waitFor();
    assert.equal(await menu.getAttribute("aria-expanded"), "true");
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1, "the menu fits");
    assert.ok(box.y + box.height <= height, "every menu link is reachable without scrolling the page behind it");
    await shot(page, `store-menu-${width}`);
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-controls")), "mobile-nav", "focus goes back to the button");
    await menu.click();
    await panel.getByRole("link").nth(1).click();
    await panel.waitFor({ state: "hidden" });
    await page.waitForTimeout(500);
    const landed = await page.evaluate(() => {
      const section = document.querySelector("#features");
      const header = document.querySelector("header").getBoundingClientRect();
      return { top: section.getBoundingClientRect().top, header: header.bottom };
    });
    assert.ok(landed.top >= landed.header - 1, `the sticky header does not cover the section: ${JSON.stringify(landed)}`);
  });

  await flow("store: every duration, the order review, keyboard height", { width, height, who: "nobody" }, async (page) => {
    await open(page, "/");
    const list = page.getByRole("tablist", { name: "مدت اشتراک" });
    await list.waitFor();
    for (const tab of await list.getByRole("tab").all()) {
      await tab.click();
      await page.waitForTimeout(120);
      const metrics = await page.evaluate(measure, { phone: true });
      assert.deepEqual(judge({ ...metrics, smallCount: 0 }, [], {}), []);
    }
    await page.getByRole("button", { name: /انتخاب پلن/ }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByRole("link", { name: /ادامه خرید/ }).waitFor();
    await page.waitForTimeout(300);
    assertFloating(await page.evaluate(floating), "order review");
    await shot(page, `store-order-${width}`);
    await page.setViewportSize({ width, height: 420 });
    await page.waitForTimeout(250);
    assertFloating(await page.evaluate(floating), "order review on a short screen");
    await dialog.getByRole("link", { name: /ادامه خرید/ }).scrollIntoViewIfNeeded();
    assert.ok(await dialog.getByRole("link", { name: /ادامه خرید/ }).isVisible(), "the hand-off link can be reached");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  });

  await flow("store: guide stepper, device tabs and FAQ", { width, height, who: "nobody" }, async (page) => {
    await open(page, "/");
    await page.waitForFunction(() => document.documentElement.dataset.hydrated !== undefined);
    for (const section of ["#payment", "#devices"]) {
      const tabs = page.locator(`${section} [role="tab"]`);
      for (let index = 0; index < await tabs.count(); index += 1) {
        await tabs.nth(index).click();
        await page.waitForTimeout(150);
        const metrics = await page.evaluate(measure, { phone: true });
        assert.deepEqual(judge({ ...metrics, smallCount: 0 }, [], {}), [], `${section} tab ${index}`);
      }
    }
    const next = page.locator("#payment button:visible", { hasText: "مرحلهٔ بعد" }).first();
    for (let step = 0; step < 3 && await next.count(); step += 1) {
      await next.click();
      await page.waitForTimeout(100);
    }
    const metrics = await page.evaluate(measure, { phone: true });
    assert.deepEqual(judge({ ...metrics, smallCount: 0 }, [], {}), [], "guide step");
    const enlarge = page.locator("#payment").getByRole("button", { name: /بزرگ/ });
    if (await enlarge.count()) {
      await enlarge.first().click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(350);
      assertFloating(await page.evaluate(floating), "guide lightbox");
      await shot(page, `store-lightbox-${width}`);
      await closeLayer(page);
    }
    for (const item of await page.locator("#faq details summary").all()) await item.click();
    await page.waitForTimeout(350);
    const open_ = await page.evaluate(measure, { phone: true });
    assert.deepEqual(judge({ ...open_, smallCount: 0 }, [], {}), [], "every FAQ answer open");
  });
}

for (const width of [320, 768]) {
  const height = width === 320 ? 640 : 1024;

  await flow("empty results and a missing page", { width, height }, async (page) => {
    for (const path of ["/panel/users?search=zz-no-match", "/panel/vpns?search=zz-no-match", "/panel/payments?search=zz-no-match", "/panel/products?search=zz-no-match", "/panel/audit?action=ZZ_NO_MATCH", "/panel/reliability/orders?q=zz-no-match"]) {
      await open(page, path);
      assert.deepEqual(judge({ ...(await page.evaluate(measure, { phone: true })), smallCount: 0 }, [], {}), [], path);
    }
    await page.screenshot({ path: join(shots, `empty-${width}.png`) });
    const missing = await page.goto("/panel/no-such-page", { waitUntil: "load" });
    assert.equal(missing.status(), 404);
    assert.deepEqual(judge({ ...(await page.evaluate(measure, { phone: true })), smallCount: 0 }, [], {}), [], "not found");
  });

  await flow("store: catalog failing, then loading", { width, height, who: "nobody" }, async (page, context) => {
    await context.route("**/api/store/catalog*", (route) => route.abort());
    await page.goto("/", { waitUntil: "load" });
    await page.getByRole("alert").first().waitFor({ timeout: 10_000 });
    assert.deepEqual(judge({ ...(await page.evaluate(measure, { phone: true })), smallCount: 0 }, [], {}), [], "failed catalog");
    await page.screenshot({ path: join(shots, `store-failed-${width}.png`) });
    await context.unroute("**/api/store/catalog*");
    await context.route("**/api/store/catalog*", () => {}); // never answers
    await page.goto("/", { waitUntil: "load" });
    await page.waitForTimeout(400);
    assert.deepEqual(judge({ ...(await page.evaluate(measure, { phone: true })), smallCount: 0 }, [], {}), [], "loading skeletons");
  });
}

await flow("reliability diagram at tablet width", { width: 768, height: 1024 }, async (page) => {
  await open(page, "/panel/reliability");
  for (const name of ["List", "Diagram"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(350);
    assert.deepEqual(judge({ ...(await page.evaluate(measure, { phone: true })), smallCount: 0 }, [], {}), [], name);
  }
});

await flow("drawer closes when the screen becomes desktop width", { width: 768, height: 1024 }, async (page) => {
  await open(page, "/panel/users");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").waitFor();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.body.hasAttribute("data-scroll-locked")), false);
});

await flow("desktop sidebar stays with the page", { width: 1440, height: 900 }, async (page) => {
  await open(page, "/panel/users");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  const box = await page.getByRole("link", { name: "Dashboard" }).first().boundingBox();
  assert.ok(box && box.y >= 0 && box.y < 200, `the sidebar stays on screen: ${JSON.stringify(box)}`);
});

await flow("catalog sort works on a phone", { width: 375, height: 812 }, async (page) => {
  await open(page, "/panel/products");
  await page.getByRole("combobox", { name: "Sort services" }).click();
  await page.getByRole("option", { name: "Price, descending" }).click();
  await page.waitForURL(/sort=price.*order=desc/);
});

if (process.env.AXE_PATH) {
  const { readFileSync } = await import("node:fs");
  const axe = readFileSync(process.env.AXE_PATH, "utf8");
  for (const [width, height] of [[320, 640], [1440, 900]]) {
    for (const route of ROUTES.filter((item) => !item.staticPage)) {
      // The panel's nonce policy rightly blocks an injected script, so only these contexts bypass it.
      await flow(`axe: ${route.label}`, { width, height, who: route.who, bypassCSP: true }, async (page) => {
        await open(page, route.path);
        await page.addScriptTag({ content: axe });
        const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] })).violations.map((item) => `${item.id}: ${item.nodes.length} ${item.nodes[0]?.target?.join(" ")}`));
        assert.deepEqual(violations, []);
      });
    }
  }
}

clearInterval(ticker);
await browser.close();
server.closeAllConnections?.();
server.close();
await disconnectTestDB().catch(() => {});
if (process.env.E2E_JSON) { mkdirSync(dirname(process.env.E2E_JSON), { recursive: true }); writeFileSync(process.env.E2E_JSON, JSON.stringify({ results, failures }, null, 1)); }
const passed = results.length - failures.length;
console.log(`\n${passed} passed, ${failures.length} failed, ${results.length} measured`);
process.exit(failures.length && !audit ? 1 : 0);
