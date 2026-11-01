/**
 * The Service Reliability Center in a real browser against the REAL Express app, the REAL /api/admin router, a real event
 * stream and a REAL disposable MongoDB. Orders are real records; dependencies are probes this file controls, so an outage
 * can be started and ended on demand. Redis is an in-memory stand-in for sessions only. Nothing talks to Telegram or a provider.
 *
 * Run:  npx next build admin-panel
 *       TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test node tests/e2e/reliability.e2e.mjs
 * Options: E2E_SHOTS=<dir> for screenshots, E2E_ONLY=<regex>, AXE_PATH=<axe.min.js> for accessibility checks.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

process.env.NODE_ENV = "production";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.HOOSHPAY_API_KEY = "fixture-not-a-real-key";
process.env.HOOSHPAY_WEBHOOK_SECRET = "fixture-webhook-secret";
delete process.env.WIZARD_API_URL;
const root = join(fileURLToPath(import.meta.url), "../../..");
if (!existsSync(join(root, "admin-panel/.next/BUILD_ID"))) { console.log("SKIP: run `npx next build admin-panel` first"); process.exit(0); }
if (!process.env.TEST_MONGO_URL) { console.log("SKIP: set TEST_MONGO_URL to a disposable MongoDB (database name must contain 'test')"); process.exit(0); }
const CHROME = process.env.CHROME_PATH || ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((path) => existsSync(path));
if (!CHROME) { console.log("SKIP: no Chrome found (set CHROME_PATH)"); process.exit(0); }

const { connectTestDB, disconnectTestDB } = await import("../helpers/db.js");
if (!(await connectTestDB())) { console.log("SKIP: MongoDB not reachable"); process.exit(0); }
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");
const { default: ReliabilityIncident } = await import("../../models/ReliabilityIncident.js");
const { HEALTH_CHECKERS } = await import("../../services/admin/monitoring.js");
const { createCollector } = await import("../../services/reliability/collector.js");
const { createIncidentTracker } = await import("../../services/reliability/incidents.js");
const { createStreamHub } = await import("../../services/reliability/stream.js");
const { setReliabilityRuntimeForTests } = await import("../../services/reliability/queries.js");
const { telemetry, observeJob, observeProvider, observeTelegramUpdate } = await import("../../services/reliability/telemetry.js");

const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms);
const shots = process.env.E2E_SHOTS || join(tmpdir(), "swift-reliability-shots");
mkdirSync(shots, { recursive: true });

async function order(status, fields = {}) {
  const purchaseId = randomUUID();
  await WalletPurchase.collection.insertOne({
    purchaseId, telegramId: "900200001", planId: "plan-30", planName: "30 day plan", gig: 50, days: 30, amount: 120_000, status, walletDebitStatus: "reserved", refundStatus: "none", recoveryStatus: "none",
    retryCount: 0, fulfillmentAttempts: 1, notificationPending: false, createdAt: ago(50 * MIN), reservedAt: ago(50 * MIN), provisioningStartedAt: ago(49 * MIN), events: [], ...fields,
  });
  return purchaseId;
}

const delivered = await order("completed", { walletDebitStatus: "finalized", provisionedAt: ago(48.9 * MIN), completedAt: ago(48.8 * MIN), notifiedAt: ago(48.7 * MIN), createdAt: ago(10 * MIN), reservedAt: ago(9.9 * MIN), provisioningStartedAt: ago(9.8 * MIN) });
for (let index = 0; index < 7; index += 1) await order("completed", { walletDebitStatus: "finalized", createdAt: ago(9 * MIN), reservedAt: ago(8.9 * MIN), provisioningStartedAt: ago(8.8 * MIN), provisionedAt: ago(8.7 * MIN), completedAt: ago(8.6 * MIN), notifiedAt: ago(8.5 * MIN) });
const review = await order("manual_review", { errorCode: "PANEL_RESULT_UNKNOWN", recoveryStatus: "required", recoveryReason: "PANEL_RESULT_UNKNOWN", events: [{ at: ago(49 * MIN), type: "provisioning_started", from: "reserved", to: "provisioning" }] });
const parked = await order("awaiting_provider", { awaitingProviderSince: ago(45 * MIN), errorCode: "PROVIDER_INSUFFICIENT_BALANCE" });

const outages = { redis: false, wizardxray: false };
const healthy = (latencyMs = 3, details) => async () => ({ status: "healthy", latencyMs, error: null, details });
const probes = {
  mongodb: HEALTH_CHECKERS.mongodb,
  redis: async () => (outages.redis ? { status: "down", latencyMs: null, error: "connection refused" } : { status: "healthy", latencyMs: 2, error: null }),
  express: healthy(4),
  telegram: healthy(140, { webhook: { registered: false, pendingUpdates: 0 } }),
  wizardxray: async () => (outages.wizardxray ? { status: "down", latencyMs: null, error: "The request timed out" } : { status: "healthy", latencyMs: 310, error: null, details: { panelPingMs: 90 } }),
  hooshpay: healthy(0),
  orders: HEALTH_CHECKERS.orders,
};
const hub = createStreamHub({ heartbeatMs: 2_000, revalidateMs: 5_000, batchMs: 200, revalidate: async (client) => Boolean(await auth.getAdminSession(client.token)) });
const collector = createCollector({
  env: { ...process.env, SENTINEL_ENABLED: "off", USER_SPEND_SWEEPER: "off", TRX_WALLET: "" },
  config: { enabled: true, intervalMs: 3_000, probeIntervalMs: 3_000 },
  probes,
  telemetry,
  tracker: createIncidentTracker({ clearTicks: 2 }),
  polling: () => ({ failing: false, stalled: false, lastErrorAgeSec: null, lastErrorStatus: null, lastSuccessAgeSec: 2 }),
  sentinel: async () => ({ health: "healthy" }),
  publish: (snapshot) => hub.publish("snapshot", snapshot),
  eventLoop: { p50Ms: 1, p99Ms: 14, maxMs: 30 },
});
setReliabilityRuntimeForTests({ collector, hub });
telemetry.subscribe((event) => { if (event.severity !== "debug") hub.queueEvent({ ...event, dirty: undefined, seq: undefined }, `${telemetry.instance}:${event.seq}`); });

function traffic(count = 30) {
  for (let index = 0; index < count; index += 1) {
    observeTelegramUpdate();
    telemetry.observe("http.store", { ms: 30 + index });
    telemetry.observe("webhook.hooshpay", { ms: 80 + index * 3 });
    observeProvider("provider.hooshpay", { operation: "invoice verification", ms: 200 + index });
    observeProvider("provider.wizardxray.create", { operation: "service creation", ms: 900 + index * 10 });
    telemetry.observe("telegram.delivery", { ms: 120 });
  }
  telemetry.observe("http.admin", { outcome: "error", ms: 40 });
  for (const job of ["hooshpay-recovery-cron", "nowpayments-recovery", "invoice-cleanup"]) observeJob(job, { ok: true });
}
traffic();
telemetry.emit({ type: "webhook.accepted", component: "webhook", message: "hooshpay callback accepted", correlationId: "req-fixture-1" });
await collector.tick();

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base; // production trusts configured origins only, never the Host header
const session = await auth.createAdminSession("424242");
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
await collector.tick();
let ticker = setInterval(() => { collector.tick().catch(() => {}); }, 3_000);

async function newPage({ theme = "dark", width = 1440, height = 1000, reducedMotion = "no-preference", hasTouch = false, signedIn = session } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion, hasTouch, baseURL: base });
  if (signedIn) await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: signedIn.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* ignore */ } }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|ERR_ABORTED|net::|EventSource/.test(message.text())) errors.push(message.text()); });
  return { page, context, errors };
}

const incident = await (async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const row = await ReliabilityIncident.findOne({ code: "ORDERS_NEED_REVIEW", state: "open" }).lean();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("no incident was written");
})();

const PAGES = [
  ["center", "/reliability", /Service topology/],
  ["events", "/reliability/events", /events? listed/],
  ["incidents", "/reliability/incidents", /Orders need a manual decision/],
  ["incident", `/reliability/incidents/${incident.incidentId}`, /Where to look next/],
  ["orders", "/reliability/orders", /unresolved/],
  ["trace-review", `/reliability/orders/${review}`, /WizardXray service request/],
  ["trace-delivered", `/reliability/orders/${delivered}`, /Service sent on Telegram/],
  ["history", "/reliability/history", /Component history/],
];

const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
const results = { passed: 0, failed: [] };
async function step(name, run) {
  if (only && !only.test(name)) return;
  try {
    await run();
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.failed.push(name);
    console.log(`  FAIL ${name}\n       ${String(error?.message || error).split("\n").slice(0, 12).join("\n       ")}`);
  }
}

const liveState = (page) => page.getByTestId("connection").getAttribute("data-state");
const waitForConnection = (page, state, timeout = 20_000) => page.waitForFunction((wanted) => document.querySelector('[data-testid="connection"]')?.dataset.state === wanted, state, { timeout });

for (const [theme, width] of [["dark", 1440], ["light", 1440], ["dark", 1024], ["light", 768], ["dark", 375], ["light", 375]]) {
  for (const [name, path, expected] of PAGES) {
    await step(`${name} (${theme} ${width}px)`, async () => {
      const { page, context, errors } = await newPage({ theme, width });
      const response = await page.goto(`/panel${path}`, { waitUntil: "load" });
      assert.equal(response.status(), 200);
      await page.waitForTimeout(900);
      const text = await page.locator("body").innerText();
      assert.ok(!/Application error|client-side exception|Internal Server Error|This page could not be found/i.test(text), "no error page");
      assert.match(text, expected);
      assert.deepEqual(errors, [], `console/page errors: ${errors.join(" | ").slice(0, 400)}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
      await page.screenshot({ path: join(shots, `${name}-${theme}-${width}.png`), fullPage: true });
      await context.close();
    });
  }
}

await step("the sidebar links the section, in the existing shell", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel", { waitUntil: "load" });
  await page.getByRole("link", { name: "Service reliability", exact: true }).click();
  await page.waitForURL("**/panel/reliability");
  await page.getByText("Service topology").waitFor();
  assert.equal(await page.locator("aside").first().isVisible(), true);
  await context.close();
});

await step("the page says what is wrong: overall state, reason and blind spots", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  const overall = page.getByTestId("overall");
  assert.equal(await overall.getAttribute("data-state"), "degraded");
  const text = await overall.innerText();
  assert.match(text, /Something needs attention/);
  assert.match(text, /Order workflow/);
  assert.match(text, /No recent evidence for: .*NOWPayments/);
  await context.close();
});

await step("every topology node is a real button, and traffic moves only on measured links", async () => {
  traffic(5);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.locator(".mf-particle").first().waitFor({ state: "attached", timeout: 8_000 });
  assert.equal(await page.locator(".rf-node").count(), 12);
  assert.ok(await page.locator(".mf-particle").count() <= 40, "bounded particle count");
  const box1 = await page.locator(".mf-particle").first().boundingBox();
  await page.waitForTimeout(500);
  const box2 = await page.locator(".mf-particle").first().boundingBox();
  assert.ok(box1 && box2 && (box1.x !== box2.x || box1.y !== box2.y), "particles really travel");
  const moving = await page.evaluate(() => [...document.querySelectorAll(".rf-edge[data-active]")].map((edge) => edge.getAttribute("data-kind")));
  assert.ok(moving.length >= 3);
  assert.ok(moving.every((kind) => kind === "flow"), "a dependency edge never reads as traffic");
  await context.close();
});

await step("no traffic means no dots", async () => {
  const { page, context } = await newPage();
  await page.route("**/api/admin/reliability/stream", (route) => route.abort());
  await page.route("**/api/admin/reliability/snapshot", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const edge of body.data.edges) { edge.count = edge.measured ? 0 : null; edge.perMinute = edge.measured ? 0 : null; }
    await route.fulfill({ response, json: body });
  });
  const polled = page.waitForResponse("**/api/admin/reliability/snapshot", { timeout: 30_000 });
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await polled;
  await page.waitForFunction(() => document.querySelectorAll(".mf-particle").length === 0, null, { timeout: 5_000 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".mf-particle").count(), 0);
  await context.close();
});

await step("clicking a node opens its details and lights its real neighbours", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.locator('[data-node="orders"]').click();
  const inspector = page.getByTestId("inspector");
  await inspector.waitFor();
  const text = await inspector.innerText();
  assert.match(text, /Order workflow/);
  assert.match(text, /Stored records/);
  assert.match(text, /Depends on/);
  assert.match(text, /Related incidents/i);
  assert.equal(await page.locator('[data-node="mongodb"]').getAttribute("data-dim"), null);
  assert.equal(await page.locator('[data-node="hooshpay"]').getAttribute("data-dim"), "true");
  await page.locator('[data-node="orders"]').click();
  await inspector.waitFor({ state: "hidden" });
  await context.close();
});

await step("hover and focus give a concise summary", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.locator('[data-node="redis"]').hover();
  await page.getByRole("tooltip").waitFor();
  assert.match(await page.getByRole("tooltip").innerText(), /Redis/);
  await page.mouse.move(0, 0);
  await page.locator('[data-node="mongodb"]').focus();
  assert.match(await page.getByRole("tooltip").innerText(), /MongoDB/);
  await context.close();
});

await step("selecting an incident lights the path it can affect", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.getByRole("button", { name: /Orders need a manual decision/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-node="telegram"]')?.dataset.dim === "true");
  assert.equal(await page.locator('[data-node="orders"]').getAttribute("data-dim"), null);
  assert.equal(await page.locator('[data-node="delivery"]').getAttribute("data-dim"), null, "delivery depends on orders");
  await context.close();
});

await step("keyboard: every node is reachable, shows focus and opens with Enter", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  const node = page.locator('[data-node="redis"]');
  await node.focus();
  const ring = await node.evaluate((el) => { const style = getComputedStyle(el); return `${style.outlineStyle} ${style.boxShadow}`; });
  assert.ok(/solid|rgb|hsl/.test(ring), `focus is visible: ${ring}`);
  await page.keyboard.press("Enter");
  await page.getByTestId("inspector").waitFor();
  assert.equal(await node.getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Close details" }).focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("inspector").waitFor({ state: "hidden" });
  await context.close();
});

await step("the list view is the same information without the picture, and is remembered", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByTestId("topology-list").waitFor();
  assert.equal(await page.getByTestId("topology").isVisible(), false);
  assert.match(await page.getByTestId("topology-list").innerText(), /MongoDB/);
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("topology-list").waitFor();
  assert.equal(await page.getByTestId("topology").isVisible(), false);
  await context.close();
});

await step("the phone layout replaces the diagram with a readable list and proper touch targets", async () => {
  const { page, context } = await newPage({ width: 375, hasTouch: true });
  await page.goto("/panel/reliability", { waitUntil: "load" });
  assert.equal(await page.locator(".rf-scene").isVisible(), false);
  assert.ok(await page.getByTestId("topology-list").isVisible());
  const small = await page.evaluate(() => [...document.querySelectorAll("main button, main a")].filter((el) => el.offsetParent && el.getBoundingClientRect().height < 36).map((el) => el.textContent.trim().slice(0, 30)));
  assert.deepEqual(small, [], "touch targets");
  await context.close();
});

await step("reduced motion removes particles and flashes, and keeps everything else", async () => {
  const { page, context } = await newPage({ reducedMotion: "reduce" });
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".mf-particle").count(), 0);
  assert.equal(await page.locator(".rf-node").count(), 12);
  await page.locator('[data-node="orders"]').click();
  await page.getByTestId("inspector").waitFor();
  await context.close();
});

await step("the stream is live, and says so only while that is true", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  assert.match(await page.getByTestId("connection").innerText(), /Live/);
  await context.close();
});

await step("a new event appears without a reload, once, and a reconnect does not repeat it", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const message = `Fixture event ${randomUUID().slice(0, 8)}`;
  telemetry.emit({ type: "provider.failed", severity: "error", component: "wizardxray", message });
  const list = page.getByTestId("recent-events");
  await list.getByText(message).first().waitFor({ timeout: 6_000 });
  assert.equal(await list.getByText(message).count(), 1);
  await page.route("**/api/admin/reliability/stream", (route) => route.abort());
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.unroute("**/api/admin/reliability/stream");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await waitForConnection(page, "live");
  await page.waitForTimeout(3_500);
  assert.equal(await list.getByText(message).count(), 1, "still one row after a reconnect and a new snapshot");
  await context.close();
});

await step("a coalesced burst stays one row and its count rises", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const key = randomUUID();
  const message = `Burst ${key.slice(0, 8)}`;
  for (let index = 0; index < 25; index += 1) telemetry.emit({ type: "webhook.rejected", severity: "warning", component: "webhook", message, coalesceKey: key });
  const list = page.getByTestId("recent-events");
  await list.getByText(message).first().waitFor({ timeout: 6_000 });
  assert.equal(await list.getByText(message).count(), 1);
  await list.getByText("25 times").first().waitFor({ timeout: 6_000 });
  await context.close();
});

await step("a dependency failing changes the node and opens an incident, live; recovery clears both", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  outages.wizardxray = true;
  try {
    await page.waitForFunction(() => document.querySelector('[data-node="wizardxray"]')?.dataset.state === "failed", null, { timeout: 15_000 });
    await page.getByRole("button", { name: /WizardXray is not responding/ }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId("overall").getAttribute("data-state"), "failed");
    await page.waitForFunction(() => document.querySelector('[data-node="wizardxray"] .rf-node-badge'), null, { timeout: 5_000 });
  } finally {
    outages.wizardxray = false;
  }
  await page.waitForFunction(() => document.querySelector('[data-node="wizardxray"]')?.dataset.state === "healthy", null, { timeout: 15_000 });
  await page.getByRole("button", { name: /WizardXray is not responding/ }).waitFor({ state: "hidden", timeout: 20_000 });
  await context.close();
});

await step("a repeated failure is one incident row, however many checks saw it", async () => {
  outages.redis = true;
  try {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    assert.equal(await ReliabilityIncident.countDocuments({ fingerprint: "DEPENDENCY_DOWN:redis", state: "open" }), 1);
  } finally {
    outages.redis = false;
  }
  await new Promise((resolve) => setTimeout(resolve, 9_000));
  assert.equal(await ReliabilityIncident.countDocuments({ fingerprint: "DEPENDENCY_DOWN:redis", state: "open" }), 0);
});

await step("a dropped stream reconnects with growing delays, falls back to polling, then recovers", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  let attempts = 0;
  await page.route("**/api/admin/reliability/stream", (route) => { attempts += 1; return route.abort(); });
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await waitForConnection(page, "polling", 30_000);
  assert.ok(attempts >= 2 && attempts <= 6, `backed off (${attempts} attempts)`);
  await page.unroute("**/api/admin/reliability/stream");
  await waitForConnection(page, "live", 45_000);
  await context.close();
});

await step("a stopped monitor reads stale, in the browser, however good the connection is", async () => {
  const { page, context } = await newPage();
  await page.route("**/api/admin/reliability/stream", (route) => route.abort());
  await page.route("**/api/admin/reliability/snapshot", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.monitoring.fresh = false;
    body.data.monitoring.lastTickAt = new Date(Date.now() - 600_000).toISOString();
    body.data.overall = { state: "stale", reason: "The monitor last ran 600 seconds ago, so nothing here describes the system now.", affected: [], unverified: [] };
    body.data.components = body.data.components.map((item) => ({ ...item, state: "stale" }));
    await route.fulfill({ response, json: body });
  });
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "stale", 30_000);
  assert.equal(await page.getByTestId("overall").getAttribute("data-state"), "stale");
  assert.match(await page.getByTestId("overall").innerText(), /Monitoring has gone quiet/);
  await page.getByTestId("connection-banner").waitFor();
  await context.close();
});

await step("a monitor that really stops goes stale over a live stream: nothing stays green", async () => {
  traffic(5);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  await page.locator(".mf-particle").first().waitFor({ state: "attached", timeout: 8_000 });
  clearInterval(ticker);
  try {
    await waitForConnection(page, "stale", 80_000);
    assert.equal(await page.getByTestId("overall").getAttribute("data-state"), "stale");
    assert.equal(await page.locator('.rf-node[data-state="stale"]').count(), 12);
    assert.equal(await page.locator(".mf-particle").count(), 0, "no dot moves on old data");
  } finally {
    ticker = setInterval(() => { collector.tick().catch(() => {}); }, 3_000);
  }
  await waitForConnection(page, "live", 15_000);
  assert.notEqual(await page.getByTestId("overall").getAttribute("data-state"), "stale");
  await context.close();
});

await step("a stream that rotates reconnects at once, and is not counted as a failure", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  await page.evaluate(() => { window.__opened = 0; });
  const next = page.waitForRequest("**/api/admin/reliability/stream**");
  hub.closeAll("reconnect");
  await next;
  await page.waitForTimeout(600);
  assert.equal(await liveState(page), "live");
  assert.doesNotMatch(await page.getByTestId("connection").innerText(), /failed/);
  await context.close();
});

await step("events missed while disconnected arrive after reconnecting", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const before = `Before the drop ${randomUUID().slice(0, 8)}`;
  telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: before });
  await page.getByTestId("recent-events").getByText(before).first().waitFor({ timeout: 6_000 });
  await page.route("**/api/admin/reliability/stream**", (route) => route.abort());
  hub.closeAll("server_stopping");
  const missed = `Missed while away ${randomUUID().slice(0, 8)}`;
  telemetry.emit({ type: "provider.failed", severity: "error", component: "hooshpay", message: missed });
  await page.waitForTimeout(500);
  await page.unroute("**/api/admin/reliability/stream**");
  await page.getByTestId("recent-events").getByText(missed).first().waitFor({ timeout: 15_000 });
  assert.equal(await page.getByTestId("recent-events").getByText(missed).count(), 1);
  await context.close();
});

await step("the server unreachable shows disconnected with the last data, never Live", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  await page.route("**/api/admin/reliability/**", (route) => route.abort());
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(() => ["reconnecting", "disconnected"].includes(document.querySelector('[data-testid="connection"]')?.dataset.state), null, { timeout: 30_000 });
  assert.notEqual(await liveState(page), "live");
  assert.ok(await page.getByText("Service topology").isVisible(), "the last data stays on screen");
  await context.close();
});

await step("a section that loads with no server answer shows the disconnected state, not an error", async () => {
  const { page, context } = await newPage();
  const previous = collector.snapshot;
  collector.snapshot = () => null;
  try {
    await page.goto("/panel/reliability", { waitUntil: "load" });
    assert.equal(await page.getByTestId("overall").getAttribute("data-state"), "unknown");
    assert.match(await page.getByTestId("overall").innerText(), /Health cannot be established/);
  } finally {
    collector.snapshot = previous;
  }
  await context.close();
});

await step("a hidden tab holds no connection", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const before = hub.size();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await waitForConnection(page, "paused");
  await page.waitForTimeout(400);
  assert.equal(hub.size(), before - 1);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await waitForConnection(page, "live");
  await context.close();
});

await step("leaving the section closes the stream", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const before = hub.size();
  await page.getByRole("link", { name: "System health" }).first().click();
  await page.waitForURL("**/panel/system-health");
  await page.waitForTimeout(500);
  assert.equal(hub.size(), before - 1);
  await context.close();
});

await step("moving between tabs keeps the one connection", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const before = hub.size();
  const tabs = page.getByRole("navigation", { name: "Service Reliability sections" });
  await tabs.getByRole("link", { name: /^Incidents/ }).click();
  await page.waitForURL("**/reliability/incidents");
  await tabs.getByRole("link", { name: "History" }).click();
  await page.waitForURL("**/reliability/history");
  await page.waitForTimeout(300);
  assert.equal(hub.size(), before);
  await context.close();
});

await step("a session that ends mid-stream shows signed out", async () => {
  const short = await auth.createAdminSession("424242");
  const { page, context } = await newPage({ signedIn: short });
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await waitForConnection(page, "live");
  await auth.deleteAdminSession(short.token);
  await waitForConnection(page, "signed_out", 20_000);
  assert.match(await page.getByTestId("connection").innerText(), /Signed out/);
  await context.close();
});

await step("signed out, the section redirects and the API refuses", async () => {
  const { page, context } = await newPage({ signedIn: null });
  await page.goto("/panel/reliability", { waitUntil: "load" });
  assert.match(page.url(), /sign-in/);
  const status = await page.evaluate(async () => (await fetch("/api/admin/reliability/snapshot")).status);
  assert.equal(status, 401);
  await context.close();
});

await step("events filter by severity, component and type, through the URL", async () => {
  const { page, context } = await newPage();
  telemetry.emit({ type: "webhook.failed", severity: "error", component: "webhook", message: "filter-me" });
  await page.waitForTimeout(3_500);
  await page.goto("/panel/reliability/events?severity=error&component=webhook&range=15m", { waitUntil: "load" });
  const list = page.getByTestId("event-list");
  await list.getByText("filter-me").first().waitFor();
  assert.ok(!(await list.innerText()).includes("hooshpay callback accepted"));
  await page.goto("/panel/reliability/events?type=order&range=24h", { waitUntil: "load" });
  await list.getByText(/Order:/).first().waitFor();
  await context.close();
});

await step("a live event that does not match the filter stays out", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability/events?component=polling&range=15m", { waitUntil: "load" });
  await waitForConnection(page, "live");
  const miss = `Other component ${randomUUID().slice(0, 8)}`;
  const hit = `Polling event ${randomUUID().slice(0, 8)}`;
  telemetry.emit({ type: "polling.error", severity: "warning", component: "webhook", message: miss });
  telemetry.emit({ type: "polling.error", severity: "warning", component: "polling", message: hit });
  await page.getByTestId("event-list").getByText(hit).waitFor({ timeout: 6_000 });
  assert.equal(await page.getByText(miss).count(), 0);
  await context.close();
});

await step("the incident view has evidence, scope, next steps and affected orders, and changes nothing", async () => {
  const { page, context } = await newPage();
  await page.goto(`/panel/reliability/incidents/${incident.incidentId}`, { waitUntil: "load" });
  const text = await page.locator("main").innerText();
  for (const expected of [/First detected/, /Orders affected/, /Evidence/, /Where to look next/, /What it can affect/, /Affected orders/, /Correlated events/]) assert.match(text, expected);
  assert.equal(await page.locator("main button").filter({ hasText: /retry|cancel|refund|restart|resolve/i }).count(), 0);
  await page.getByTestId("order-rows").getByRole("link").first().click();
  await page.waitForURL("**/reliability/orders/**");
  await page.getByTestId("trace").waitFor();
  await context.close();
});

await step("an order trace states each stage and its basis", async () => {
  const { page, context } = await newPage();
  await page.goto(`/panel/reliability/orders/${review}`, { waitUntil: "load" });
  const provider = page.locator('[data-stage="provider"]');
  assert.equal(await provider.getAttribute("data-state"), "failed");
  assert.equal(await provider.getAttribute("data-delayed"), "true");
  assert.match(await provider.innerText(), /PANEL_RESULT_UNKNOWN/);
  assert.match(await provider.innerText(), /never replayed/);
  const funding = page.locator('[data-stage="funding"]');
  assert.match(await funding.innerText(), /Not linked/);
  assert.match(await funding.innerText(), /No telemetry/);
  await page.goto(`/panel/reliability/orders/${parked}`, { waitUntil: "load" });
  assert.equal(await page.locator('[data-stage="provider"]').getAttribute("data-state"), "waiting");
  await context.close();
});

await step("order search finds an order and a customer; an unknown one is a clear not-found", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability/orders", { waitUntil: "load" });
  await page.getByLabel(/Order id or customer/).fill(delivered);
  await page.getByRole("button", { name: "Trace" }).click();
  await page.waitForURL(`**/reliability/orders/${delivered}`);
  await page.getByTestId("trace").waitFor();
  await page.goto("/panel/reliability/orders", { waitUntil: "load" });
  await page.getByLabel(/Order id or customer/).fill("900200001");
  await page.getByRole("button", { name: "Trace" }).click();
  await page.waitForURL("**/reliability/orders?userId=900200001");
  await page.getByText(/recent orders for this customer/).waitFor();
  const text = await page.locator("main").innerText();
  assert.ok(!text.includes("900200001 ·"), "the list masks the customer id");
  const missing = await page.goto("/panel/reliability/orders/no-such-order", { waitUntil: "load" });
  assert.equal(missing.status(), 404);
  await context.close();
});

await step("history shows gaps as gaps, and a partial window says so", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability/history?range=24h", { waitUntil: "load" });
  await page.getByTestId("coverage-note").waitFor();
  await page.getByTestId("availability").waitFor();
  await page.locator(".recharts-surface").first().waitFor();
  assert.ok(await page.locator('.rf-strip > span[data-state="none"]').count() > 10);
  await page.getByText("Table view").click();
  await page.getByText("not measured").first().waitFor();
  await context.close();
});

await step("recharts stays out of the command center", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/reliability", { waitUntil: "load" });
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".recharts-wrapper").count(), 0);
  await context.close();
});

await step("nothing sensitive reaches the page", async () => {
  const { page, context } = await newPage();
  await page.goto(`/panel/reliability/orders/${delivered}`, { waitUntil: "load" });
  const html = await page.content();
  for (const secret of ["fixture-webhook-secret", "fixture-not-a-real-key", "900200001"]) assert.ok(!html.includes(secret), secret);
  const snapshot = await page.evaluate(async () => (await fetch("/api/admin/reliability/snapshot")).text());
  for (const secret of ["fixture-webhook-secret", "fixture-not-a-real-key", "mongodb://", "900200001"]) assert.ok(!snapshot.includes(secret), secret);
  await context.close();
});

await step("the light theme stays green-tinted and the dark theme near-black green", async () => {
  for (const [theme, check] of [["light", ([r, g, b]) => g > r && g >= b && r < 250], ["dark", ([r, g, b]) => g >= r && r < 30 && b < 30]]) {
    const { page, context } = await newPage({ theme });
    await page.goto("/panel/reliability", { waitUntil: "load" });
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.ok(check(background.match(/[\d.]+/g).map(Number)), `${theme} background ${background}`);
    await context.close();
  }
});

await step("Sentinel's flow still runs on the shared particle code", async () => {
  const { page, context, errors } = await newPage();
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  await page.getByRole("heading", { name: "Money paths" }).waitFor();
  assert.equal(await page.locator(".mf-node").count(), 10);
  assert.deepEqual(errors, []);
  await context.close();
});

await step("accessibility (axe, WCAG 2 A and AA)", async () => {
  const axePath = process.env.AXE_PATH;
  if (!axePath || !existsSync(axePath)) { console.log("       skipped: set AXE_PATH to axe.min.js"); return; }
  const axe = readFileSync(axePath, "utf8");
  for (const [theme, width] of [["dark", 1440], ["light", 1440], ["dark", 375], ["light", 375]]) {
    for (const [name, path] of PAGES) {
      const { page, context } = await newPage({ theme, width });
      await page.goto(`/panel${path}`, { waitUntil: "load" });
      await page.waitForTimeout(900);
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector("main"), { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`));
      assert.deepEqual(violations, [], `${name} ${theme} ${width}`);
      await context.close();
    }
  }
});

await step("the topology costs little main-thread time while animating, compared with Sentinel", async () => {
  traffic(5);
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  async function busy(path, reducedMotion) {
    const { page, context } = await newPage({ reducedMotion });
    await page.goto(`/panel${path}`, { waitUntil: "load" });
    await page.waitForTimeout(1_500);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const sample = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
    const first = await sample();
    await page.waitForTimeout(5_000);
    const second = await sample();
    const dots = await page.locator(".mf-particle").count();
    await context.close();
    return { busy: (second.TaskDuration - first.TaskDuration) / (second.Timestamp - first.Timestamp), dots };
  }
  const still = await busy("/reliability", "reduce");
  const moving = await busy("/reliability", "no-preference");
  const sentinel = await busy("/sentinel/flow", "no-preference");
  console.log(`       main thread busy: ${(still.busy * 100).toFixed(1)}% still, ${(moving.busy * 100).toFixed(1)}% with ${moving.dots} particles; Sentinel flow ${(sentinel.busy * 100).toFixed(1)}% with ${sentinel.dots} particles (software rendering)`);
  assert.ok(moving.dots > 0, "measured with real traffic on screen");
  assert.ok(moving.busy < 0.25, `busy ${(moving.busy * 100).toFixed(1)}%`);
});

clearInterval(ticker);
hub.closeAll();
await browser.close();
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
await disconnectTestDB();
console.log(`\n${results.passed} passed, ${results.failed.length} failed${results.failed.length ? `:\n  ${results.failed.join("\n  ")}` : ""}\nScreenshots: ${shots}`);
process.exit(results.failed.length ? 1 : 0);
