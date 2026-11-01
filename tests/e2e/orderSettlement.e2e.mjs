/**
 * Settling an unknown-outcome order, in a real browser, against the REAL Express app and admin API, a disposable MongoDB and Redis, and a
 * local panel that follows the provider's document. This is the one screen where a click moves a customer's money, so it is walked as
 * an admin walks it: look first, read what the page says, and confirm with a reason.
 *
 * Run:  TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test REDIS_URL=redis://127.0.0.1:<port>  npx next build admin-panel &&
 *       node tests/e2e/orderSettlement.e2e.mjs
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

process.env.NODE_ENV = "production";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.USER_SPEND_HOOK = "off";
process.env.VPN_API_KEY = "unit-wizard-key-not-real";
const root = join(fileURLToPath(import.meta.url), "../../..");
if (!existsSync(join(root, "admin-panel/.next/BUILD_ID"))) { console.log("SKIP: run `npx next build admin-panel` first"); process.exit(0); }
if (!process.env.TEST_MONGO_URL || !process.env.REDIS_URL) { console.log("SKIP: set TEST_MONGO_URL and REDIS_URL to disposable servers"); process.exit(0); }

const { connectTestDB, disconnectTestDB } = await import("../helpers/db.js");
if (!(await connectTestDB())) { console.log("SKIP: MongoDB not reachable"); process.exit(0); }
const { startFakeWizardPanel } = await import("../helpers/fakeWizardPanel.js");
const panel = await startFakeWizardPanel();
process.env.WIZARD_API_URL = panel.url;
const { connectRedis, closeRedis } = await import("../../config/redisClient.js");
await connectRedis();
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");
const { default: User } = await import("../../models/User.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");

const MIN = 60_000;
let serial = 0;
async function heldOrder() {
  serial += 1;
  const telegramId = String(970_000_000 + serial);
  const purchaseId = `e2e-held-${serial}`;
  const startedAt = new Date(Date.now() - 30 * MIN);
  await User.create({ telegramId, balance: 500, appliedPurchaseReservations: [purchaseId] });
  await WalletPurchase.create({ purchaseId, telegramId, planId: "p1", planName: "Plan", gig: 20, days: 30, amount: 40_000, status: "manual_review", walletDebitStatus: "reserved", errorCode: "ECONNABORTED", recoveryStatus: "required", provisioningStartedAt: startedAt, createdAt: startedAt });
  return { purchaseId, telegramId, startedAt };
}

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base;
// The built panel must start in production mode, and the provider client rightly refuses a plain-HTTP provider there. Next reads the
// mode once, on the first request, so that request is made here and the stand-in then runs under the client's local-development rule.
process.env.NODE_ENV = "production";
await fetch(`${base}/panel/sign-in`).catch(() => {});
process.env.NODE_ENV = "test";
const session = await auth.createAdminSession("424242");

const CHROME = process.env.CHROME_PATH || ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome"].find(existsSync);
if (!CHROME) { console.log("SKIP: no Chrome found"); process.exit(0); }
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function open() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Strict" })));
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(String(error.message)));
  await page.goto("/panel/recovery", { waitUntil: "networkidle" });
  return page;
}
const row = (page) => page.getByRole("row").filter({ hasText: "provisioning uncertain" });

const results = { passed: 0, failed: [] };
async function step(name, run) {
  panel.services.clear();
  await WalletPurchase.deleteMany({});
  let page = null;
  try {
    await run(async () => { page = await open(); return page; });
    assert.deepEqual(page?.errors ?? [], [], "page errors");
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.failed.push(name);
    console.log(`  FAIL ${name}\n       ${String(error?.message || error).split("\n").slice(0, 3).join("\n       ")}`);
  }
  await page?.context().close().catch(() => {});
}

await step("a found service is linked, with a reason, and the held debit pays for it", async (openPage) => {
  const { purchaseId, telegramId, startedAt } = await heldOrder();
  const service = panel.add({ gig: 20, day: 30, createdAt: Math.floor(startedAt.getTime() / 1000) + 5 });
  const page = await openPage();
  await row(page).getByRole("button", { name: "Check provider" }).click();
  await page.getByText("Possible match, not proof:").waitFor();
  assert.equal(await page.getByRole("button", { name: /refund/i }).count(), 0, "no refund is offered while a match exists");
  await page.getByRole("button", { name: "Link to this order" }).click();
  await page.getByLabel(/Reason/).fill("matched the provider list by hand");
  await page.getByRole("button", { name: "Link and deliver" }).click();
  await page.getByText("Service linked to the order.").waitFor();
  const order = await WalletPurchase.findOne({ purchaseId }).lean();
  assert.deepEqual([order.status, order.serviceUsername], ["completed", service.username]);
  const owner = await User.findOne({ telegramId }).lean();
  assert.equal(owner.balance, 500, "nothing charged, nothing refunded");
  assert.equal(panel.callsTo("create").length, 0);
});

await step("with nothing found, a refund returns the held amount", async (openPage) => {
  const { purchaseId, telegramId } = await heldOrder();
  const page = await openPage();
  await row(page).getByRole("button", { name: "Check provider" }).click();
  await page.getByText(/No match in/).waitFor();
  await page.getByRole("button", { name: "Nothing was created: refund" }).click();
  await page.getByLabel(/Reason/).fill("looked in the provider list, no such service");
  await page.getByRole("alertdialog").getByRole("button", { name: "Refund" }).click();
  await page.getByText("The customer was refunded.").waitFor();
  assert.equal((await User.findOne({ telegramId }).lean()).balance, 40_500);
  assert.equal((await WalletPurchase.findOne({ purchaseId }).lean()).status, "refunded");
});

await step("a refused settlement stays open, says why, and changes nothing", async (openPage) => {
  const { purchaseId, telegramId } = await heldOrder();
  const page = await openPage();
  await row(page).getByRole("button", { name: "Check provider" }).click();
  await page.getByRole("button", { name: "Nothing was created: refund" }).click();
  await page.getByLabel(/Reason/).fill("short");
  await page.getByRole("alertdialog").getByRole("button", { name: "Refund" }).click();
  await page.getByRole("alertdialog").locator(".text-destructive").first().waitFor();
  assert.equal((await User.findOne({ telegramId }).lean()).balance, 500);
  assert.equal((await WalletPurchase.findOne({ purchaseId }).lean()).status, "manual_review");
});

await browser.close();
server.close();
await panel.close();
await closeRedis();
await disconnectTestDB();
console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
process.exit(results.failed.length ? 1 : 0);
