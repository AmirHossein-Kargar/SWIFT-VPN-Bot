/**
 * Every admin page at /panel rendered by a real browser against the REAL Express app, the REAL /api/admin router
 * and a REAL MongoDB (disposable test database), seeded with a few records. No fixtures stand in for the API.
 *
 * What is still not real: Telegram (the bot is absent; sends are skipped) and external providers (NOWPayments,
 * HooshPay, WizardXray are not configured, so those screens must show their "not configured / unavailable"
 * states honestly). Redis is an in-memory stand-in for sessions only. No money moves.
 *
 * Run:  TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test  npx next build admin-panel &&
 *       node tests/e2e/panelRealBackend.e2e.mjs        (then: rm -rf admin-panel/.next admin-panel/tsconfig.tsbuildinfo)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const { connectTestDB, disconnectTestDB } = await import("../helpers/db.js");
if (!(await connectTestDB())) { console.log("SKIP: MongoDB not reachable"); process.exit(0); }
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const customerAuth = await import("../../services/support/customerAuth.js");
customerAuth.setCustomerSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");

// Seed a little real data through the real models.
const { default: User } = await import("../../models/User.js");
const { default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js");
const { default: WalletPurchase } = await import("../../models/WalletPurchase.js");
const { default: Bank } = await import("../../models/invoice.js");
const workflow = await import("../../services/support/workflow.js");
const { makeFakeBot } = await import("../helpers/fakeSupport.js");
const { default: AdminProduct } = await import("../../models/AdminProduct.js");
const DAY = 864e5;
for (let i = 1; i <= 4; i += 1) await User.create({ telegramId: String(910000 + i), username: `real_user_${i}`, firstName: "Real", lastName: `User ${i}`, balance: i * 10_000, services: i % 2 ? [{ username: `svc_real_${i}`, expiresAt: new Date(Date.now() + 20 * DAY) }] : [] });
await HooshPayInvoice.create({ uid: "REAL-PAID", orderId: "RP1", userId: 910001, amount: 120_000, status: "paid", balanceCredited: true, balanceCreditedAt: new Date(), fulfilled: true, paidAt: new Date() });
await HooshPayInvoice.create({ uid: "REAL-FAILED", orderId: "RP2", userId: 910002, amount: 50_000, status: "failed" });
await HooshPayInvoice.create({ uid: "REAL-STUCK", orderId: "RP3", userId: 910003, amount: 70_000, status: "paid", balanceCredited: false, fulfilled: true, paidAt: new Date() }); // recovery queue
await Bank.create({ paymentId: "REAL-BANK-1", userId: 910004, amount: 80_000, status: "rejected" });
await Bank.create({ paymentId: "REAL-BANK-DONE", userId: 910001, amount: 25_000, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: true, balanceCreditedAt: new Date(), confirmedAt: new Date() });
await Bank.create({ paymentId: "REAL-BANK-UNCREDITED", userId: 910001, amount: 30_000, paymentType: "bank", status: "confirmed", creditLedgerVersion: 2, balanceCredited: false, confirmedAt: new Date() });
await WalletPurchase.create({ purchaseId: "wp_real_1", telegramId: "910001", planId: "p", planName: "Real plan", gig: 10, days: 30, amount: 90_000, status: "completed", completedAt: new Date(), expiresAt: new Date(Date.now() + 20 * DAY) });
await AdminProduct.create({ productId: "real_p1", name: "Real product", durationDays: 30, trafficGb: 20, priceToman: 90_000, costToman: 40_000, enabled: true, sortOrder: 1 }).catch(() => {});
const fakeBot = makeFakeBot();
const ticket = await workflow.customerOpenTicket({ bot: fakeBot, from: { id: 910001 }, userId: 910001, subject: "تیکت واقعی", text: "سلام", dedupeKey: "real:open:1", channel: "telegram" });
const ticketId = ticket.ticket.ticketId;

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base; // production trusts configured origins only, never the Host header
const session = await auth.createAdminSession("424242");

const CHROME = process.env.CHROME_PATH || ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!CHROME) { console.log("SKIP: no Chrome found"); process.exit(0); }
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const PAGES = [
  ["dashboard", "/", /./],
  ["analytics", "/analytics", /./],
  ["users", "/users", /real_user_1|Real User 1/],
  ["payments", "/payments", /REAL-PAID|HooshPay/],
  ["vpns", "/vpns", /./],
  ["vpns-remote", "/vpns/remote", /not configured|unavailable|could not|Remote clients/i],
  ["custody", "/custody", /Custody/],
  ["products", "/products", /Real product/],
  ["recovery", "/recovery", /./],
  ["referrals", "/referrals", /./],
  ["audit", "/audit", /./],
  ["admins", "/admins", /424242/],
  ["broadcasts", "/broadcasts", /./],
  ["mock-tests", "/mock-tests", /./],
  ["settings", "/settings", /./],
  ["system-health", "/system-health", /./],
  ["tickets", "/tickets", /تیکت واقعی/],
  ["ticket-detail", `/tickets/${ticketId}`, /سلام/],
];
const results = { passed: 0, failed: [] };
for (const [theme, width] of [["light", 1440], ["dark", 390]]) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* ignore */ } }, theme);
  for (const [name, path, expected] of PAGES) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error.message)));
    page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
    const label = `${name} (${theme} ${width}px)`;
    try {
      const response = await page.goto(`/panel${path}`, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200, "HTTP status");
      assert.ok(new URL(page.url()).pathname.startsWith("/panel") && !page.url().includes("sign-in"), `stayed signed in: ${page.url()}`);
      const text = await page.locator("body").innerText();
      assert.ok(!/Application error|client-side exception|Internal Server Error|This page could not be found/i.test(text), "no error boundary / 404 page");
      assert.match(text, expected);
      assert.deepEqual(errors, [], "console/page errors");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
      results.passed += 1;
      console.log(`  ok   ${label}`);
    } catch (error) {
      results.failed.push({ label, message: String(error?.message || error).split("\n")[0] });
      console.log(`  FAIL ${label}\n       ${String(error?.message || error).split("\n").slice(0, 2).join("\n       ")}`);
    }
    await page.close();
  }
  await context.close();
}
// ── Real interaction: the Retry button is offered only when a retry can actually run (rule shared with the server) ──
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  const page = await context.newPage();
  await page.goto("/panel/payments", { waitUntil: "networkidle" });
  const retryOffered = async (rowText) => {
    await page.getByRole("row").filter({ hasText: rowText }).getByRole("button", { name: "View" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByText(rowText).first().waitFor();
    await page.waitForTimeout(400);
    const offered = (await sheet.getByRole("button", { name: "Retry", exact: true }).count()) > 0;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    return offered;
  };
  assert.equal(await retryOffered("REAL-BANK-DONE"), false, "a credited bank invoice offers no retry");
  assert.equal(await retryOffered("REAL-PAID"), false, "a credited HooshPay invoice offers no retry");
  assert.equal(await retryOffered("REAL-BANK-UNCREDITED"), true, "a confirmed-but-uncredited bank invoice offers a retry");
  assert.equal(await retryOffered("REAL-STUCK"), true, "a paid-but-uncredited HooshPay invoice offers a retry");
  // And the API agrees for the settled ones: a forced retry is a no-op, never a recovery flag.
  const csrf = session.session.csrfToken;
  const forced = await fetch(`${base}/api/admin/payments/${encodeURIComponent("bank:REAL-BANK-DONE")}/retry`, { method: "POST", headers: { cookie: `${auth.ADMIN_SESSION_COOKIE}=${session.token}`, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ operationId: "e2e-forced-retry-0000000001" }) });
  const forcedBody = await forced.json();
  assert.equal(forced.status, 200);
  assert.equal(forcedBody.data.noop, true);
  assert.equal(forcedBody.data.status, "already_confirmed");
  assert.equal((await Bank.findOne({ paymentId: "REAL-BANK-DONE" }).lean()).recoveryStatus, "none");
  results.passed += 1;
  console.log("  ok   payment detail offers Retry only when it can run; a forced retry of a settled invoice is a no-op through the real API");
  await context.close();
} catch (error) {
  results.failed.push({ label: "retry availability (real backend)", message: String(error?.message || error).split("\n")[0] });
  console.log("  FAIL retry availability (real backend)\n       " + String(error?.message || error).split("\n").slice(0, 2).join("\n       "));
}

// ── Real interaction: delete a payment through the UI -> real API -> real MongoDB ──
try {
  const { default: Tombstone } = await import("../../models/PaymentTombstone.js");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  const page = await context.newPage();
  await page.goto("/panel/payments", { waitUntil: "networkidle" });
  const row = (text) => page.getByRole("row").filter({ hasText: text });
  assert.equal(await row("REAL-STUCK").getByRole("checkbox").isDisabled(), true, "paid-but-uncredited must not be deletable");
  assert.equal(await row("REAL-PAID").getByRole("checkbox").isDisabled(), true, "credited payment must not be deletable");
  await row("REAL-FAILED").getByRole("checkbox").click();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  await page.getByText(/All 1 selected records are eligible/).waitFor();
  await page.getByRole("button", { name: /^Delete 1 record$/ }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("REAL-FAILED"), null, { timeout: 10_000 });
  assert.equal(await HooshPayInvoice.countDocuments({ uid: "REAL-FAILED" }), 0, "removed from MongoDB");
  assert.equal(await HooshPayInvoice.countDocuments({ uid: { $in: ["REAL-PAID", "REAL-STUCK"] } }), 2, "other records untouched");
  const stone = await Tombstone.findOne({ provider: "hooshpay", orderId: "RP2" }).lean();
  assert.ok(stone && stone.deletedAt, "tombstone written and completed");
  const { default: AuditLog } = await import("../../models/AdminAuditLog.js");
  assert.equal(await AuditLog.countDocuments({ action: "PAYMENTS_DELETED", status: "succeeded" }), 1);
  results.passed += 1;
  console.log("  ok   payment deletion through the UI on the real backend (row removed, DB row gone, tombstone + audit written, protected rows untouched)");
  await context.close();
} catch (error) {
  results.failed.push({ label: "payment deletion (real backend)", message: String(error?.message || error).split("\n")[0] });
  console.log("  FAIL payment deletion (real backend)\n       " + String(error?.message || error).split("\n").slice(0, 2).join("\n       "));
}

// ── Real interaction: service catalog lifecycle through the UI -> real API -> real MongoDB ──
try {
  const { default: AuditLog } = await import("../../models/AdminAuditLog.js");
  const shots = process.env.E2E_SHOTS;
  await (await import("../../services/plans.js")).seedDefaultProducts(); // production seeds the shipped plans at boot
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  const page = await context.newPage();
  await page.goto("/panel/products", { waitUntil: "networkidle" });
  await page.getByText(/\d+ services/).first().waitFor();
  if (shots) await page.screenshot({ path: `${shots}/catalog-list.png`, fullPage: true });

  // Add a service through the dialog (starts off sale).
  await page.getByRole("button", { name: "Add service" }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("UI created plan");
  await dialog.getByLabel("Traffic (GB)").fill("77");
  await dialog.getByLabel("Price (Toman)").fill("123000");
  await dialog.getByLabel("Cost (Toman)").fill("80000");
  await dialog.getByText("Not for sale.").waitFor();
  if (shots) await page.screenshot({ path: `${shots}/catalog-add-dialog.png` });
  await dialog.getByRole("button", { name: "Add service" }).click();
  await page.getByText('"UI created plan" created.').waitFor({ timeout: 10_000 });
  const created = await AdminProduct.findOne({ name: "UI created plan" }).lean();
  assert.ok(created && created.enabled === false && created.published === true && created.durationDays === 30 && created.revision === 0);

  // Search narrows the list and the counter says so.
  await page.getByLabel("Search services").fill("UI created");
  await page.getByText(/1 of \d+ services match/).waitFor({ timeout: 10_000 });
  const row = page.getByRole("row").filter({ hasText: "UI created plan" });
  await row.getByText("Off sale").waitFor();

  // Put on sale, hide from storefront, and the public API follows.
  await row.getByRole("button", { name: "Actions for UI created plan" }).click();
  await page.getByRole("menuitem", { name: "Put on sale" }).click();
  await row.getByText("On sale").waitFor({ timeout: 10_000 });
  const publicIds = async () => (await (await fetch(`${base}/api/store/catalog`)).json()).data.plans.map((plan) => plan.id);
  assert.ok((await publicIds()).includes(created.productId), "on-sale plans reach the public storefront catalog");
  await row.getByRole("button", { name: "Actions for UI created plan" }).click();
  await page.getByRole("menuitem", { name: "Hide from storefront" }).click();
  await row.getByText("Hidden from storefront").waitFor({ timeout: 10_000 });
  assert.ok(!(await publicIds()).includes(created.productId), "unpublished plans leave the storefront catalog");

  // Edit via dialog: review lists the change, save bumps the revision.
  await row.getByRole("button", { name: "Actions for UI created plan" }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Price (Toman)").fill("150000");
  await dialog.getByText(/Price: .* → /).waitFor();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await page.getByText('"UI created plan" updated.').waitFor({ timeout: 10_000 });
  assert.equal((await AdminProduct.findOne({ productId: created.productId }).lean()).priceToman, 150000);

  // Archive needs confirmation, then the row leaves the default view and shows under Archived.
  await row.getByRole("button", { name: "Actions for UI created plan" }).click();
  await page.getByRole("menuitem", { name: "Archive…" }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByText(/Existing orders and customers' active VPN services are not affected/).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/catalog-archive-confirm.png` });
  await confirm.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("No services match these filters.").waitFor({ timeout: 10_000 });
  assert.ok((await AdminProduct.findOne({ productId: created.productId }).lean()).archivedAt);

  // Shipped plans cannot be deleted from the menu; an unreferenced custom plan can.
  await page.goto("/panel/products?search=s30_10", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Actions for / }).first().click();
  assert.equal(await page.getByRole("menuitem", { name: /Delete permanently/ }).getAttribute("aria-disabled"), "true");
  await page.keyboard.press("Escape");
  await page.goto("/panel/products?status=archived&search=UI%20created", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Actions for UI created plan" }).click();
  await page.getByRole("menuitem", { name: /Delete permanently/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete permanently" }).click();
  await page.getByText('"UI created plan" deleted.').waitFor({ timeout: 10_000 });
  assert.equal(await AdminProduct.countDocuments({ productId: created.productId }), 0);

  for (const action of ["PRODUCT_CREATED", "PRODUCT_AVAILABILITY_CHANGED", "PRODUCT_UPDATED", "PRODUCT_ARCHIVED", "PRODUCT_DELETED"]) {
    assert.ok(await AuditLog.countDocuments({ action, status: "succeeded" }), `${action} audited`);
  }
  for (const [width, theme] of [[390, "dark"], [768, "light"]]) {
    const small = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, baseURL: base });
    await small.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
    const mobile = await small.newPage();
    await mobile.goto("/panel/products", { waitUntil: "networkidle" });
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `catalog page overflows horizontally at ${width}px by ${overflow}px`);
    if (shots) await mobile.screenshot({ path: `${shots}/catalog-${width}.png`, fullPage: true });
    await small.close();
  }
  results.passed += 1;
  console.log("  ok   service catalog through the UI on the real backend (add, search, sale/storefront toggles, edit review, archive confirm, protected + permanent delete, audit, mobile/tablet layout)");
  await context.close();
} catch (error) {
  results.failed.push({ label: "service catalog (real backend)", message: String(error?.message || error).split("\n")[0] });
  console.log("  FAIL service catalog (real backend)\n       " + String(error?.message || error).split("\n").slice(0, 3).join("\n       "));
}

// ── Real interaction: add / remove / re-add an admin through the UI -> real API -> real MongoDB ──
try {
  const { default: AdminAccount } = await import("../../models/AdminAccount.js");
  const { isAdminUser } = await import("../../utils/auth.js");
  const NEW_ADMIN = "910777";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: base });
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  const page = await context.newPage();
  await page.goto("/panel/admins", { waitUntil: "networkidle" });
  const addViaUi = async (name) => {
    await page.getByRole("button", { name: "Add admin" }).first().click();
    const dialog = page.getByRole("dialog");
    const idInput = dialog.getByLabel("Telegram ID");
    for (let i = 0; i < 6; i += 1) { await idInput.fill(NEW_ADMIN); await page.waitForTimeout(250); if ((await idInput.inputValue()) === NEW_ADMIN) break; }
    await dialog.getByLabel("Display name (optional)").fill(name);
    await dialog.getByRole("button", { name: "Add admin" }).click();
    await page.getByText(`Admin ${NEW_ADMIN} added.`).waitFor({ timeout: 10_000 });
  };
  await addViaUi("Ui Added");
  const created = await AdminAccount.find({ telegramId: NEW_ADMIN }).lean();
  assert.equal(created.length, 1, "exactly one row created in MongoDB");
  assert.equal(created[0].removedAt, null);
  assert.equal(created[0].displayName, "Ui Added");
  assert.equal(isAdminUser(NEW_ADMIN), true, "the new admin is authorized immediately");
  await page.getByText(NEW_ADMIN).first().waitFor();

  await page.getByRole("button", { name: `Remove ${NEW_ADMIN}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await page.getByText(`Admin ${NEW_ADMIN} removed.`).waitFor({ timeout: 10_000 });
  assert.ok((await AdminAccount.findOne({ telegramId: NEW_ADMIN }).lean()).removedAt instanceof Date);
  await page.reload({ waitUntil: "networkidle" });

  await addViaUi("Ui Re-added");
  const readded = await AdminAccount.find({ telegramId: NEW_ADMIN }).lean();
  assert.equal(readded.length, 1, "re-adding re-activates the same row, never a duplicate");
  assert.equal(readded[0].removedAt, null);
  assert.equal(readded[0].displayName, "Ui Re-added");
  results.passed += 1;
  console.log("  ok   admin add -> remove -> re-add through the UI on the real backend (one row throughout, access follows state)");
  await context.close();
} catch (error) {
  results.failed.push({ label: "admin add/remove/re-add (real backend)", message: String(error?.message || error).split("\n")[0] });
  console.log("  FAIL admin add/remove/re-add (real backend)\n       " + String(error?.message || error).split("\n").slice(0, 2).join("\n       "));
}

// ── Real API: broadcast lease failure modes through the real router (+ real Redis when REDIS_URL is set) ──
try {
  const post = async (path, body) => {
    const response = await fetch(`${base}/api/admin${path}`, { method: "POST", headers: { cookie: `${auth.ADMIN_SESSION_COOKIE}=${session.token}`, "content-type": "application/json", "x-csrf-token": session.session.csrfToken }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const payload = (operationId) => ({ operationId, message: "E2E lease check", audience: "custom", customTelegramIds: ["910001"] });
  // The e2e process has not connected the shared Redis client, so the lock service is "down": truthful 503, nothing sent.
  const down = await post("/broadcast", payload("e2e-broadcast-down-0000000001"));
  assert.equal(down.status, 503);
  assert.equal(down.body.error, "broadcast_lock_unavailable");
  let detail = "Redis-down -> truthful 503 broadcast_lock_unavailable";
  if (process.env.REDIS_URL) {
    const redis = await import("../../config/redisClient.js");
    await redis.connectRedis();
    try {
      await redis.default.del("admin:broadcast:active");
      const started = await post("/broadcast", payload("e2e-broadcast-up-000000000002"));
      assert.equal(started.status, 200);
      assert.equal(started.body.data.started, true);
      const deadline = Date.now() + 10_000;
      let status;
      while (Date.now() < deadline) {
        const poll = await fetch(`${base}/api/admin/broadcast/status/e2e-broadcast-up-000000000002`, { headers: { cookie: `${auth.ADMIN_SESSION_COOKIE}=${session.token}` } });
        status = (await poll.json()).data;
        if (["completed", "failed", "cancelled"].includes(status.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(["completed", "failed"].includes(status.status), `finished: ${status.status}`);
      assert.equal(status.succeeded, 0, "no bot in the e2e process: nothing delivered");
      await redis.default.set("admin:broadcast:active", "foreign-owner", { NX: true, EX: 60 });
      const held = await post("/broadcast", payload("e2e-broadcast-held-00000000003"));
      assert.equal(held.status, 409);
      assert.equal(held.body.error, "broadcast_already_running");
      assert.equal(await redis.default.get("admin:broadcast:active"), "foreign-owner", "foreign lease untouched");
      detail += "; real Redis -> broadcast runs and releases; held lease -> 409, untouched";
    } finally {
      await redis.default.del("admin:broadcast:active");
      await redis.closeRedis();
    }
  } else {
    detail += " (Redis lease paths NOT exercised: REDIS_URL not set)";
  }
  results.passed += 1;
  console.log(`  ok   broadcast lease through the real API: ${detail}`);
} catch (error) {
  results.failed.push({ label: "broadcast lease (real API)", message: String(error?.message || error).split("\n")[0] });
  console.log("  FAIL broadcast lease (real API)\n       " + String(error?.message || error).split("\n").slice(0, 2).join("\n       "));
}

await browser.close();
server.close();
await disconnectTestDB();
console.log(`\n${results.passed} passed, ${results.failed.length} failed (real Express + real /api/admin + real MongoDB test database).`);
for (const failure of results.failed) console.log(` - ${failure.label}: ${failure.message}`);
process.exit(results.failed.length ? 1 : 0);
