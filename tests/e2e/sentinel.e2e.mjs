/**
 * Money Flow Sentinel in a real browser against the REAL Express app, the REAL /api/admin router and a REAL disposable
 * MongoDB. Money is moved by the real wallet functions and damage is injected directly, then a real reconciliation runs.
 * Redis is an in-memory stand-in for sessions only. Nothing talks to Telegram or a provider.
 *
 * Run:  npx next build admin-panel
 *       TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test node tests/e2e/sentinel.e2e.mjs
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
delete process.env.WIZARD_API_URL;
delete process.env.NOWPAYMENTS_API_KEY;
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
const { default: User } = await import("../../models/User.js");
const { default: Hoosh } = await import("../../models/HooshPayInvoice.js");
const { default: NowPayments } = await import("../../models/NowPaymentsInvoice.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");
const { default: Finding } = await import("../../models/SentinelFinding.js");
const { creditWalletOnce } = await import("../../services/walletCredit.js");
const { reserveBalance, commitProvisionedPurchase, refundPurchaseReservation } = await import("../../services/buyService/purchaseLedger.js");
const { runSentinelTick } = await import("../../services/sentinel/reconciler.js");
const { readSentinelConfig } = await import("../../services/sentinel/constants.js");

const HOUR = 3_600_000;
const ago = (ms) => new Date(Date.now() - ms);
const shots = process.env.E2E_SHOTS || join(tmpdir(), "swift-sentinel-shots");
mkdirSync(shots, { recursive: true });

async function topUp(telegramId, amount, hoursAgo) {
  const uid = `E2E-${randomUUID().slice(0, 13)}`;
  const at = ago(hoursAgo * HOUR);
  await Hoosh.create({ uid, orderId: `o-${uid}`, userId: Number(telegramId), amount, status: "paid", fulfilled: true, fulfilledAt: at, paidAt: at, creditLedgerVersion: 2, createdAt: new Date(at.getTime() - 60_000), webhookLog: [{ receivedAt: at, payload: { status: "paid" } }] });
  await creditWalletOnce({ telegramId, amount, creditKey: `hooshpay:${uid}` });
  await Hoosh.updateOne({ uid }, { $set: { balanceCredited: true, balanceCreditedAt: new Date(at.getTime() + 2_000) } });
  return uid;
}

async function buy(telegramId, amount, hoursAgo) {
  const purchaseId = randomUUID();
  const at = ago(hoursAgo * HOUR);
  await WalletPurchase.create({ purchaseId, telegramId, planId: "plan-30", planName: "30 day plan", gig: 50, days: 30, amount, status: "reserving", createdAt: at });
  await reserveBalance(telegramId, amount, purchaseId);
  await WalletPurchase.updateOne({ purchaseId, status: "reserving" }, { $set: { status: "reserved", walletDebitStatus: "reserved", reservedAt: at, walletDebitedAt: at } });
  return purchaseId;
}

async function fulfil(purchaseId, hoursAgo) {
  const at = ago(hoursAgo * HOUR);
  await WalletPurchase.updateOne({ purchaseId, status: "reserved" }, { $set: { status: "provisioning", provisioningStartedAt: at } });
  await WalletPurchase.updateOne({ purchaseId, status: "provisioning" }, { $set: { status: "provisioned", serviceUsername: `svc${purchaseId.slice(0, 6)}`, provisionedAt: at } });
  await commitProvisionedPurchase(await WalletPurchase.findOne({ purchaseId }), null);
}

const healthy = "900100001";
const damaged = "900100002";
const stuck = "900100003";
await User.create({ telegramId: healthy, firstName: "Fixture", balance: 0, createdAt: ago(400 * HOUR) });
await User.create({ telegramId: damaged, firstName: "Fixture", balance: 0, createdAt: ago(400 * HOUR) });
await User.create({ telegramId: stuck, firstName: "Fixture", balance: 0, createdAt: ago(400 * HOUR) });
for (const [amount, age] of [[250_000, 60], [180_000, 40], [320_000, 20], [90_000, 6], [140_000, 3]]) await topUp(healthy, amount, age);
for (const [amount, age] of [[120_000, 50], [90_000, 18], [120_000, 2]]) await fulfil(await buy(healthy, amount, age), age);
const refundable = await buy(healthy, 60_000, 4);
await refundPurchaseReservation({ purchaseId: refundable, telegramId: healthy, amount: 60_000 }, { reason: "PROVIDER_REJECTED" });

await topUp(damaged, 200_000, 30);
await User.collection.updateOne({ telegramId: damaged }, { $inc: { balance: 75_000 } });
const lost = `E2E-LOST-${randomUUID().slice(0, 8)}`;
await Hoosh.create({ uid: lost, orderId: `o-${lost}`, userId: Number(damaged), amount: 150_000, status: "paid", fulfilled: true, fulfilledAt: ago(5 * HOUR), paidAt: ago(5 * HOUR), creditLedgerVersion: 2, createdAt: ago(6 * HOUR) });

await topUp(stuck, 100_000, 12);
const review = await buy(stuck, 80_000, 8);
await WalletPurchase.updateOne({ purchaseId: review, status: "reserved" }, { $set: { status: "provisioning", provisioningStartedAt: ago(8 * HOUR) } });
await WalletPurchase.updateOne({ purchaseId: review, status: "provisioning" }, { $set: { status: "manual_review", errorCode: "PANEL_RESULT_UNKNOWN" } });
await NowPayments.create({ orderId: "NP-E2E-000000000001", userId: Number(stuck), amountToman: 500_000, priceAmountCents: 1000, priceCurrency: "usd", payCurrency: "trx", tomanPerFiat: 50_000, rateSource: "fixture", status: "creation_unknown", createdAt: ago(3 * HOUR) });

const config = readSentinelConfig({ SENTINEL_INTERVAL_SECONDS: "120" });
const tick = await runSentinelTick({ config });
assert.equal(tick.error, null);
assert.ok(await Finding.countDocuments({ state: "open" }) >= 3, "the injected damage was found");

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base; // production trusts configured origins only, never the Host header
const session = await auth.createAdminSession("424242");
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage({ theme = "dark", width = 1440, height = 1000, reducedMotion = "no-preference", hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion, hasTouch, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* ignore */ } }, theme);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  return { page, context, errors };
}

const firstFinding = (await Finding.find({ state: "open", code: "BALANCE_DRIFT" }).lean())[0];
const lostFinding = await Finding.findOne({ subjectKey: `hooshpay:${lost}` }).lean();
const PAGES = [
  ["overview", "/sentinel", /confirmed|Ledger and records agree/i],
  ["overview-30d", "/sentinel?range=30d", /Money in and out/],
  ["flow", "/sentinel/flow", /Money paths/],
  ["reconciliation", "/sentinel/reconciliation", /Balance differs from the ledger/],
  ["investigation", `/sentinel/reconciliation/${firstFinding._id}`, /Safe ways forward/],
  ["investigation-lost", `/sentinel/reconciliation/${lostFinding._id}`, /Confirmed payment without a wallet credit/],
  ["transactions", "/sentinel/transactions", /Wallet top-up/],
  ["transaction-payment", `/sentinel/transactions/${encodeURIComponent(`hooshpay:${lost}`)}`, /Provider verification/],
  ["transaction-order", `/sentinel/transactions/${encodeURIComponent(`wallet:${review}`)}`, /Order state/],
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

for (const [theme, width] of [["dark", 1440], ["light", 1440], ["dark", 1024], ["light", 768], ["dark", 375], ["light", 375]]) {
  for (const [name, path, expected] of PAGES) {
    await step(`${name} (${theme} ${width}px)`, async () => {
      const { page, context, errors } = await newPage({ theme, width });
      const response = await page.goto(`/panel${path}`, { waitUntil: "load" });
      assert.equal(response.status(), 200);
      await page.waitForTimeout(1200);
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

await step("the desktop flow is a live graph of buttons with particles only on edges that moved money", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  await page.locator(".mf-particle").first().waitFor({ state: "attached" });
  assert.ok(await page.locator(".mf-particle").count() <= 50, "bounded particle count");
  assert.equal(await page.locator(".mf-node").count(), 10);
  const box1 = await page.locator(".mf-particle").first().boundingBox();
  await page.waitForTimeout(500);
  const box2 = await page.locator(".mf-particle").first().boundingBox();
  assert.ok(box1 && box2 && (box1.x !== box2.x || box1.y !== box2.y), "particles really travel");
  await context.close();
});

await step("the phone layout replaces the graph with a readable list", async () => {
  const { page, context } = await newPage({ width: 375, hasTouch: true });
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  assert.equal(await page.locator(".mf-scene").isVisible(), false);
  assert.ok(await page.getByRole("button", { name: /Wallets/ }).first().isVisible());
  const small = await page.evaluate(() => [...document.querySelectorAll("main button, main a")].filter((el) => el.offsetParent && el.getBoundingClientRect().height < 36).map((el) => el.textContent.trim().slice(0, 30)));
  assert.deepEqual(small, [], "touch targets");
  await context.close();
});

await step("reduced motion removes the particles and the float", async () => {
  const { page, context } = await newPage({ reducedMotion: "reduce" });
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".mf-particle").count(), 0);
  assert.ok(await page.locator(".mf-node").first().isVisible());
  await page.goto("/panel/sentinel", { waitUntil: "load" });
  const animations = await page.evaluate(() => getComputedStyle(document.querySelector(".mf-vault-plate")).animationName);
  assert.equal(animations, "none");
  await context.close();
});

await step("keyboard: a stage is reachable, shows focus, and filters the feed", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  const wallet = page.locator(".mf-node-core");
  await wallet.focus();
  const ring = await wallet.evaluate((el) => { const style = getComputedStyle(el); return `${style.outlineStyle} ${style.boxShadow}`; });
  assert.ok(/solid|rgb|hsl/.test(ring), `focus is visible: ${ring}`);
  const request = page.waitForRequest((item) => item.url().includes("/api/admin/sentinel/live") && item.url().includes("stage=credited"));
  await page.keyboard.press("Enter");
  await request;
  assert.equal(await wallet.getAttribute("aria-pressed"), "true");
  await context.close();
});

await step("a new payment appears in the feed without a reload, once, with an honest label", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  await page.getByTestId("feed-health").waitFor();
  const before = await page.locator(".mf-feed-row").count();
  const uid = await topUp(healthy, 77_777, 0);
  await page.getByText("77,777").first().waitFor({ timeout: 16_000 });
  const label = await page.getByTestId("feed-health").getAttribute("data-health");
  assert.equal(label, "live");
  assert.ok(await page.locator(".mf-feed-row").count() > before);
  await page.waitForTimeout(11_000);
  const rows = await page.locator(`.mf-feed-row a[href*="${uid}"]`).count();
  const unique = new Set(await page.locator(`.mf-feed-row a[href*="${uid}"]`).evaluateAll((items) => items.map((item) => item.querySelector(".truncate")?.textContent)));
  assert.equal(rows, unique.size, "polling overlap never duplicates a row");
  await context.close();
});

await step("a broken connection shows as delayed, backs off, and recovers by itself", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  await page.getByTestId("feed-health").waitFor();
  await page.waitForTimeout(500);
  let calls = 0;
  await page.route("**/api/admin/sentinel/live*", (route) => { calls += 1; return route.abort(); });
  await page.waitForFunction(() => document.querySelector('[data-testid="feed-health"]').dataset.health === "delayed", null, { timeout: 40_000 });
  assert.match(await page.locator("body").innerText(), /failed attempt/);
  assert.ok(calls <= 3, `backed off (${calls} calls)`);
  await page.unroute("**/api/admin/sentinel/live*");
  await page.waitForFunction(() => document.querySelector('[data-testid="feed-health"]').dataset.health === "live", null, { timeout: 45_000 });
  await context.close();
});

await step("a hidden tab stops polling", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(10_500);
  let calls = 0;
  page.on("request", (request) => { if (request.url().includes("/sentinel/live")) calls += 1; });
  await page.waitForTimeout(11_000);
  assert.equal(calls, 0);
  await context.close();
});

await step("the review flow records a decision and refuses to hide a live problem", async () => {
  const { page, context } = await newPage();
  await page.goto(`/panel/sentinel/reconciliation/${firstFinding._id}`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Mark resolved" }).click();
  await page.getByLabel("Reason").fill("Looks fine, closing this out");
  await page.getByRole("button", { name: "Save decision" }).click();
  await page.getByRole("alert").filter({ hasText: /still show this problem/ }).waitFor();
  assert.equal((await Finding.findById(firstFinding._id).lean()).review, "new", "refused on the server");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Start investigating" }).click();
  await page.getByLabel("Reason").fill("Comparing the wallet entries with the invoice");
  await page.getByRole("button", { name: "Save decision" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("Comparing the wallet entries with the invoice").first().waitFor();
  assert.equal((await Finding.findById(firstFinding._id).lean()).review, "investigating");
  await context.close();
});

await step("a filter can be set, linked and cleared", async () => {
  const { page, context } = await newPage();
  await page.goto("/panel/sentinel/reconciliation?severity=critical", { waitUntil: "load" });
  await page.getByText(/Nothing here|finding/).first().waitFor();
  await page.goto("/panel/sentinel/transactions?provider=wallet", { waitUntil: "load" });
  const text = await page.locator("main").innerText();
  assert.ok(!text.includes("Wallet top-up"), "only orders");
  await page.goto("/panel/sentinel/transactions?from=2020-01-01&to=2020-02-01", { waitUntil: "load" });
  await page.getByText("No transactions").waitFor();
  await context.close();
});

await step("the light theme stays green-tinted and the dark theme near-black green", async () => {
  for (const [theme, check] of [["light", ([r, g, b]) => g > r && g >= b && r < 250], ["dark", ([r, g, b]) => g >= r && r < 30 && b < 30]]) {
    const { page, context } = await newPage({ theme });
    await page.goto("/panel/sentinel", { waitUntil: "load" });
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const channels = background.match(/[\d.]+/g).map(Number);
    assert.ok(check(channels), `${theme} background ${background}`);
    await context.close();
  }
});

await step("accessibility (axe, WCAG 2 A and AA)", async () => {
  const axePath = process.env.AXE_PATH;
  if (!axePath || !existsSync(axePath)) { console.log("       skipped: set AXE_PATH to axe.min.js"); return; }
  const axe = readFileSync(axePath, "utf8");
  for (const [theme, width] of [["dark", 1440], ["light", 1440], ["dark", 375]]) {
    for (const [name, path] of PAGES) {
      const { page, context } = await newPage({ theme, width });
      await page.goto(`/panel${path}`, { waitUntil: "load" });
      await page.waitForTimeout(700);
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run(document.querySelector("main"), { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(" | ")}`));
      assert.deepEqual(violations, [], `${name} ${theme} ${width}`);
      await context.close();
    }
  }
});

await step("the flow page costs little main-thread time while animating", async () => {
  async function busy(reducedMotion) {
    const { page, context } = await newPage({ reducedMotion });
    await page.goto("/panel/sentinel/flow", { waitUntil: "load" });
    await page.waitForTimeout(1_500);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const sample = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));
    const first = await sample();
    await page.waitForTimeout(4_000);
    const second = await sample();
    await context.close();
    return (second.TaskDuration - first.TaskDuration) / (second.Timestamp - first.Timestamp);
  }
  const still = await busy("reduce");
  const moving = await busy("no-preference");
  console.log(`       main thread busy: ${(still * 100).toFixed(1)}% still, ${(moving * 100).toFixed(1)}% with particles (software rendering)`);
  assert.ok(moving < 0.25, `busy ${(moving * 100).toFixed(1)}%`);
});

await browser.close();
await new Promise((resolve) => server.close(resolve));
await disconnectTestDB();
console.log(`\n${results.passed} passed, ${results.failed.length} failed${results.failed.length ? `:\n  ${results.failed.join("\n  ")}` : ""}\nScreenshots: ${shots}`);
process.exit(results.failed.length ? 1 : 0);
