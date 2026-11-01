/**
 * The live dashboard in a real browser, against the REAL Express app, the REAL /api/admin router and a REAL disposable MongoDB.
 * The monitor's snapshot is a fixture so each state can be set on demand; Redis is an in-memory stand-in for sessions.
 *
 * The rule under test: everything that moves does so because a real value changed, and nothing keeps looking healthy once the data
 * has stopped being good.
 *
 * Run:  TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test  npx next build admin-panel && node tests/e2e/dashboard.e2e.mjs
 * Options: E2E_ONLY=<regex>, AXE_PATH=<axe.min.js> for accessibility checks.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

process.env.NODE_ENV = "production";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.USER_SPEND_HOOK = "off";
delete process.env.WIZARD_API_URL;
delete process.env.NOWPAYMENTS_API_KEY;
const root = join(fileURLToPath(import.meta.url), "../../..");
if (!existsSync(join(root, "admin-panel/.next/BUILD_ID"))) { console.log("SKIP: run `npx next build admin-panel` first"); process.exit(0); }
if (!process.env.TEST_MONGO_URL) { console.log("SKIP: set TEST_MONGO_URL to a disposable MongoDB (database name must contain 'test')"); process.exit(0); }

const { connectTestDB, disconnectTestDB } = await import("../helpers/db.js");
if (!(await connectTestDB())) { console.log("SKIP: MongoDB not reachable"); process.exit(0); }
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");
const { default: User } = await import("../../models/User.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");
const { resetDashboardPulseForTests } = await import("../../services/admin/dashboard.js");
const { setReliabilityRuntimeForTests } = await import("../../services/reliability/queries.js");
const { COMPONENTS } = await import("../../services/reliability/constants.js");

for (let index = 1; index <= 3; index += 1) await User.create({ telegramId: String(920000 + index), username: `dash_user_${index}` });
await WalletPurchase.create({ purchaseId: "dash-1", telegramId: "920001", planId: "p1", planName: "First plan", gig: 10, days: 30, amount: 20_000, status: "completed", serviceLink: "https://sub.example.test/sub/secret" });

const snapshotWith = ({ states = {}, overall = { state: "healthy", reason: "Every component has recent evidence of working.", affected: [], unverified: [] }, openCount = 0, ageMs = 0 } = {}) => ({
  monitoring: { lastTickAt: new Date(Date.now() - ageMs).toISOString() },
  overall,
  incidents: { openCount },
  edges: [],
  components: COMPONENTS.map((item) => ({ id: item.id, label: item.label, state: states[item.id] ?? "healthy", reason: states[item.id] ? `${item.label} is ${states[item.id]}` : "The last check succeeded." })),
});
let snapshot = snapshotWith();
setReliabilityRuntimeForTests({ collector: { snapshot: () => snapshot, telemetry: { minutes: () => [] } } });

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base;
const session = await auth.createAdminSession("424242");

const CHROME = process.env.CHROME_PATH || ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
if (!CHROME) { console.log("SKIP: no Chrome found"); process.exit(0); }
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function open({ width = 1440, theme = "light", reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Strict" })));
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* ignore */ } }, theme);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error.message)));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) page.errors.push(message.text()); });
  const response = await page.goto("/panel", { waitUntil: "networkidle" });
  assert.equal(response.status(), 200);
  await page.getByTestId("dashboard-freshness").waitFor();
  return page;
}

/** The page refreshes on its timer and whenever it becomes visible; this is the second one, so a test does not wait 30 seconds. */
const refreshNow = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const card = (page, label) => page.locator(".metric-card").filter({ hasText: label });
const freshness = (page) => page.getByTestId("dashboard-freshness");

const results = { passed: 0, failed: [], notRun: [] };
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
const NOT_RUN = Symbol("not run");
async function step(name, run) {
  if (only && !only.test(name)) return;
  snapshot = snapshotWith();
  resetDashboardPulseForTests();
  let page = null;
  try {
    const outcome = await run((options) => open(options).then((opened) => { page = opened; return opened; }));
    if (outcome === NOT_RUN) {
      results.notRun.push(name);
      console.log(`  --   ${name}: NOT RUN (set AXE_PATH to axe.min.js)`);
      return;
    }
    if (page) assert.deepEqual(page.errors, [], "console/page errors");
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.failed.push(name);
    console.log(`  FAIL ${name}\n       ${String(error?.message || error).split("\n").slice(0, 3).join("\n       ")}`);
  }
  await page?.context().close().catch(() => {});
}

await step("shows real figures, twelve checks and the newest order", async (openPage) => {
  const page = await openPage();
  await card(page, "Total users").getByText("3", { exact: true }).first().waitFor();
  await page.getByText("12 of 12 checks passing.").waitFor();
  assert.equal(await page.getByTestId("dashboard-health").locator("li").count(), 12);
  await page.getByText("First plan").waitFor();
  assert.match(await freshness(page).innerText(), /^Live, updated/);
  assert.equal((await page.content()).includes("sub.example.test"), false, "no subscription link reaches the page");
});

await step("a real new order moves the numbers and slides into the list, with no layout shift", async (openPage) => {
  const page = await openPage();
  const before = await card(page, "Orders this month").boundingBox();
  await WalletPurchase.create({ purchaseId: "dash-2", telegramId: "920002", planId: "p2", planName: "Second plan", gig: 0, days: 30, amount: 90_000, status: "provisioning" });
  await User.create({ telegramId: "920099", username: "dash_user_new" });
  resetDashboardPulseForTests();
  await refreshNow(page);
  await page.getByText("Second plan").waitFor();
  await card(page, "Total users").getByText("4", { exact: true }).first().waitFor();
  await page.locator(".change-flash").first().waitFor({ state: "attached" });
  const after = await card(page, "Orders this month").boundingBox();
  assert.deepEqual([after.x, after.y, after.width, after.height], [before.x, before.y, before.width, before.height], "the card kept its place and size");
});

await step("nothing moves when nothing changed: an idle page runs one animation, the live dot", async (openPage) => {
  const page = await openPage();
  await page.waitForTimeout(1_500);
  resetDashboardPulseForTests();
  await refreshNow(page);
  await page.waitForTimeout(1_800);
  const running = await page.evaluate(() => document.getAnimations().filter((item) => item.playState === "running").map((item) => item.animationName));
  assert.deepEqual([...new Set(running)], ["dash-live"]);
  assert.equal(await page.locator(".change-flash").count(), 0, "no value changed, so nothing flashed");
});

await step("a failing component is shown in the first screen, with the count and the open incidents", async (openPage) => {
  snapshot = snapshotWith({ states: { wizardxray: "failed", hooshpay: "degraded" }, overall: { state: "failed", reason: "WizardXray is not working.", affected: ["wizardxray"], unverified: [] }, openCount: 2 });
  const page = await openPage();
  const health = page.getByTestId("dashboard-health");
  await health.getByText("10 of 12 checks passing.").waitFor();
  await health.getByText("WizardXray is not working.").waitFor();
  await health.getByText("2 open").waitFor();
  await health.getByText("failed", { exact: true }).first().waitFor();
});

await step("a status change reaches an open page, and flashes once", async (openPage) => {
  const page = await openPage();
  snapshot = snapshotWith({ states: { redis: "failed" }, overall: { state: "failed", reason: "Redis is not working.", affected: ["redis"], unverified: [] } });
  await refreshNow(page);
  await page.getByText("11 of 12 checks passing.").waitFor();
  await page.getByTestId("dashboard-health").locator("[data-changed=true]").waitFor();
});

await step("a monitor that stopped reads stale, never healthy, whatever it last said", async (openPage) => {
  snapshot = snapshotWith({ ageMs: 20 * 60_000 });
  const page = await openPage();
  const health = page.getByTestId("dashboard-health");
  await health.getByText("stale", { exact: true }).waitFor();
  await health.getByText("0 of 12 checks passing.", { exact: false }).waitFor();
  assert.equal(await health.getByText("healthy", { exact: true }).count(), 0);
});

await step("a monitor that has not reported says so, rather than showing an empty green page", async (openPage) => {
  snapshot = null;
  const page = await openPage();
  const health = page.getByTestId("dashboard-health");
  await health.getByText("unknown", { exact: true }).waitFor();
  await health.getByText("0 of 12 checks passing.", { exact: false }).waitFor();
  assert.equal(await health.getByText("healthy", { exact: true }).count(), 0);
});

await step("a failed refresh keeps the figures and stops saying live", async (openPage) => {
  const page = await openPage();
  const users = await card(page, "Total users").innerText();
  await page.route("**/api/admin/dashboard/pulse", (route) => route.abort());
  await refreshNow(page);
  await freshness(page).getByText(/Not updating/).waitFor();
  assert.equal(await freshness(page).getAttribute("data-state"), "failed");
  await page.getByText("First plan").waitFor();
  assert.equal(await card(page, "Total users").innerText(), users, "the last figures stay on screen");
  assert.equal(await page.locator(".dash-live-dot-on").count(), 0, "the live dot stops");
  await page.unroute("**/api/admin/dashboard/pulse");
  resetDashboardPulseForTests();
  await refreshNow(page);
  await freshness(page).getByText(/^Live/).waitFor();
});

await step("reduced motion: the final figure appears at once and nothing repeats", async (openPage) => {
  const page = await openPage({ reducedMotion: "reduce" });
  await WalletPurchase.create({ purchaseId: "dash-3", telegramId: "920003", planId: "p3", planName: "Third plan", gig: 10, days: 30, amount: 123_456, status: "completed", completedAt: new Date() });
  await User.create({ telegramId: "920100" });
  resetDashboardPulseForTests();
  await refreshNow(page);
  await page.getByText("Third plan").waitFor();
  await page.waitForTimeout(150);
  const repeating = await page.evaluate(() => document.getAnimations().filter((item) => item.effect?.getComputedTiming().iterations === Infinity && item.playState === "running").length);
  assert.equal(repeating, 0);
});

await step("works at every width, in both themes, without sideways scrolling", async (openPage) => {
  for (const [width, theme] of [[360, "dark"], [390, "light"], [768, "dark"], [1440, "dark"]]) {
    const page = await openPage({ width, theme });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${width}px ${theme}: overflow ${overflow}px`);
    await page.context().close();
  }
});

await step("accessibility (axe, WCAG 2 A and AA)", async (openPage) => {
  const axePath = process.env.AXE_PATH;
  if (!axePath || !existsSync(axePath)) return NOT_RUN;
  const axe = readFileSync(axePath, "utf8");
  for (const theme of ["light", "dark"]) {
    const page = await openPage({ theme });
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((item) => item.id));
    assert.deepEqual(violations, [], theme);
    await page.context().close();
  }
});

await browser.close();
server.close();
await disconnectTestDB();
console.log(`\n${results.passed} passed, ${results.failed.length} failed, ${results.notRun.length} not run`);
if (results.failed.length) console.log(results.failed.map((name) => `  - ${name}`).join("\n"));
process.exit(results.failed.length ? 1 : 0);
