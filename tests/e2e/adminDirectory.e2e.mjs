/**
 * The admin directory in a real browser against the REAL Express app, the REAL /api/admin router and a REAL disposable
 * MongoDB. Telegram photos come from a stand-in bot, and Redis is an in-memory stand-in for sessions and presence.
 *
 * Run:  npx next build admin-panel
 *       TEST_MONGO_URL=mongodb://127.0.0.1:<port>/swiftvpn_test node tests/e2e/adminDirectory.e2e.mjs
 * Options: E2E_SHOTS=<dir> for screenshots, E2E_ONLY=<regex>, AXE_PATH=<axe.min.js> for accessibility checks.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

process.env.NODE_ENV = "production";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
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
const presence = await import("../../services/admin/adminPresence.js");
const sessions = makeFakeRedis();
const presenceStore = makeFakeRedis();
auth.setAdminSessionRedisForTests(sessions);
presence.setAdminPresenceRedisForTests(presenceStore);
const { setBotInstance } = await import("../../config/botInstance.js");
const { default: app } = await import("../../server.js");
const { default: User } = await import("../../models/User.js");
const { default: AdminAccount } = await import("../../models/AdminAccount.js");
const { default: AdminAuditLog } = await import("../../models/AdminAuditLog.js");

const MIN = 60_000;
const DAY = 1440 * MIN;
const ago = (ms) => new Date(Date.now() - ms);
const OWNER = "424242";
const LEAD = "900101";
const QUIET = "900102";
const FLAGGED = "900103";
const FORMER = "900104";
const STRANGER = "900105";
const shots = process.env.E2E_SHOTS || join(tmpdir(), "swift-admin-directory-shots");
mkdirSync(shots, { recursive: true });

// A 1x1 PNG is all the avatar needs: the assertion is that the bytes rendered, not how they look.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfz0AEYBxVSF+FAAhKDveksOjmAAAAAElFTkSuQmCC", "base64");
setBotInstance({
  async getUserProfilePhotos(id) {
    return String(id) === LEAD ? { total_count: 1, photos: [[{ file_id: "fake-file", file_unique_id: "fake", width: 320 }]] } : { total_count: 0, photos: [] };
  },
  getFileStream() { return Readable.from([PNG]); },
});

await User.create([
  { telegramId: OWNER, firstName: "Olive", lastName: "Fake", username: "olive_fake", createdAt: ago(400 * DAY) },
  { telegramId: LEAD, firstName: "دانا", lastName: "نمونه", username: "dana_fake", createdAt: ago(90 * DAY) },
  { telegramId: QUIET, firstName: "Quinn", createdAt: ago(20 * DAY) },
  { telegramId: FLAGGED, firstName: "Finley", lastName: "With A Remarkably Long Family Name That Must Not Break The Card", username: "finley_fake", createdAt: ago(50 * DAY), isBanned: true, blockedBy: "system", blockedAt: ago(3 * DAY) },
  { telegramId: FORMER, firstName: "Former", username: "former_fake", createdAt: ago(200 * DAY) },
]);
await AdminAccount.create([
  { telegramId: LEAD, displayName: "Support lead", addedBy: OWNER, addedAt: ago(30 * DAY) },
  { telegramId: QUIET, addedBy: OWNER, addedAt: ago(10 * DAY) },
  { telegramId: FLAGGED, addedBy: OWNER, addedAt: ago(9 * DAY) },
  { telegramId: STRANGER, displayName: "Not yet met", addedBy: OWNER, addedAt: ago(DAY) },
  { telegramId: FORMER, displayName: "Former admin", addedBy: OWNER, addedAt: ago(60 * DAY), removedAt: ago(5 * DAY), removedBy: OWNER },
]);
const audit = (actorTelegramId, action, createdAt, fields = {}) => ({ operationId: randomUUID(), actorTelegramId, action, status: "succeeded", createdAt, ...fields });
await AdminAuditLog.insertMany([
  audit(LEAD, "ADMIN_LOGIN", ago(90 * MIN), { ipAddress: "192.0.2.10", targetType: "session", targetId: "web" }),
  audit(LEAD, "USER_BALANCE_CHANGED", ago(20 * MIN), { targetType: "user", targetId: "1001" }),
  audit(LEAD, "USER_BALANCE_CHANGED", ago(2 * DAY), { targetType: "user", targetId: "1002", status: "failed", errorCode: "insufficient_balance" }),
  audit(OWNER, "ADMIN_ADDED", ago(30 * DAY), { targetType: "admin", targetId: LEAD }),
  audit(OWNER, "ADMIN_ADDED", ago(60 * DAY), { targetType: "admin", targetId: FORMER }),
  audit(OWNER, "ADMIN_REMOVED", ago(5 * DAY), { targetType: "admin", targetId: FORMER }),
]);
await presenceStore.set(`admin:web:presence:${LEAD}`, String(Date.now() - MIN));
await presenceStore.set(`admin:web:presence:${QUIET}`, String(Date.now() - 2 * DAY));

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
process.env.PORT = String(server.address().port);
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ADMIN_ALLOWED_ORIGINS = base;
const session = await auth.createAdminSession(OWNER);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = { passed: 0, failed: [] };
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

async function newPage({ width = 1440, height = 900, theme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, baseURL: base, colorScheme: theme });
  await context.addInitScript((value) => { try { localStorage.setItem("theme", value); } catch { /* the page still renders */ } }, theme);
  await context.addCookies(["/api/admin", "/panel"].map((path) => ({ name: auth.ADMIN_SESSION_COOKIE, value: session.token, domain: "127.0.0.1", path, httpOnly: true, secure: false, sameSite: "Lax" })));
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error" && /Content Security Policy|hydrat/i.test(message.text())) problems.push(message.text()); });
  return { page, context, problems };
}

async function step(name, body) {
  if (only && !only.test(name)) return;
  try {
    await body();
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.failed.push(name);
    console.log(`  FAIL ${name}\n       ${String(error?.message || error).split("\n").slice(0, 4).join("\n       ")}`);
  }
}

const card = (page, id) => page.getByTestId(`admin-card-${id}`);
const open = (page, query = "") => page.goto(`/panel/admins${query}`, { waitUntil: "networkidle" });
const visibleCards = (page) => page.locator('[data-testid^="admin-card-"]').count();

for (const [theme, width] of [["light", 1440], ["dark", 1440], ["light", 820], ["dark", 390], ["light", 320]]) {
  await step(`layout: ${theme} ${width}px has every admin and no sideways scroll`, async () => {
    const { page, context, problems } = await newPage({ width, theme, height: 800 });
    await open(page);
    assert.equal(await visibleCards(page), 6);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main");
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth };
    });
    assert.ok(overflow.page <= 0 && overflow.main <= 0, JSON.stringify(overflow));
    // Measured because the status filter once shrank to "All..." beside Add admin on a phone.
    const clipped = await page.locator('main [role="combobox"] > span').evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.textContent));
    assert.deepEqual(clipped, [], "filter labels are readable");
    const search = await page.getByLabel("Search admins").evaluate((node) => node.clientWidth);
    if (width >= 390) assert.ok(search >= 280, `search box is ${search}px wide`);
    await page.screenshot({ path: join(shots, `directory-${theme}-${width}.png`), fullPage: true });
    assert.deepEqual(problems, []);
    await context.close();
  });
}

await step("cards: a profile states what is known and labels what is not", async () => {
  const { page, context } = await newPage();
  await open(page);
  const owner = card(page, OWNER);
  await owner.getByText("Olive Fake").waitFor();
  await owner.getByText("@olive_fake").waitFor();
  await owner.getByText(`ID ${OWNER}`).waitFor();
  await owner.getByText("Owner", { exact: true }).waitFor();
  await owner.getByText("Active", { exact: true }).waitFor();

  const stranger = card(page, STRANGER);
  await stranger.getByText("Not yet met").waitFor();
  await stranger.getByText("No username on record").waitFor();
  await stranger.getByText("No bot profile").waitFor();
  await stranger.getByText("Not seen in panel").waitFor();
  assert.equal(await stranger.locator("[data-presence]").getAttribute("data-presence"), "unknown");
  await card(page, FORMER).getByText("Removed", { exact: true }).waitFor();
  await card(page, FLAGGED).getByText("Blocked in bot").waitFor();
  await context.close();
});

await step("presence: the viewer and a recent admin are online, an old record is offline, none is unknown", async () => {
  const { page, context } = await newPage();
  await open(page);
  const state = (id) => card(page, id).locator("[data-presence]").getAttribute("data-presence");
  assert.equal(await state(OWNER), "online");
  assert.equal(await state(LEAD), "online");
  assert.equal(await state(QUIET), "offline");
  assert.equal(await state(STRANGER), "unknown");
  await context.close();
});

await step("presence: a broken store reads as unknown, and the rest of the page stays", async () => {
  presence.setAdminPresenceRedisForTests({ set: async () => { throw new Error("down"); }, mGet: async () => { throw new Error("down"); } });
  const { page, context } = await newPage();
  try {
    await open(page);
    await page.getByText("Online status is unavailable because Redis could not be read.").waitFor();
    assert.equal(await card(page, LEAD).locator("[data-presence]").getAttribute("data-presence"), "unknown");
    await card(page, LEAD).getByText("Status unavailable").waitFor();
    await page.getByText("Unknown", { exact: true }).first().waitFor();
    assert.equal(await visibleCards(page), 6);
  } finally {
    presence.setAdminPresenceRedisForTests(presenceStore);
    await context.close();
  }
});

await step("photos: a real photo renders, and no photo or no bot profile falls back without a request", async () => {
  const { page, context } = await newPage();
  const asked = [];
  page.on("request", (request) => { if (/\/users\/\d+\/photo/.test(request.url())) asked.push(request.url().match(/users\/(\d+)/)[1]); });
  await open(page);
  await card(page, LEAD).locator("img").waitFor();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="admin-card-${id}"] img`)?.naturalWidth > 0, LEAD);
  await page.waitForFunction((id) => !document.querySelector(`[data-testid="admin-card-${id}"] img`), OWNER);
  await card(page, OWNER).getByText("OL", { exact: true }).waitFor();
  assert.equal(await card(page, STRANGER).locator("img").count(), 0);
  assert.equal(asked.includes(STRANGER), false, "no request for an account the bot has never met");
  await context.close();
});

await step("search: matches name, username and ID, keeps focus, and survives a reload", async () => {
  const { page, context } = await newPage();
  await open(page);
  const box = page.getByLabel("Search admins");
  await box.click();
  await box.pressSequentially("dana", { delay: 30 });
  await page.waitForURL(/search=dana/);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="admin-card-"]').length === 1);
  await card(page, LEAD).waitFor();
  assert.equal(await box.evaluate((node) => node === document.activeElement), true, "focus stays in the box");
  assert.equal(await box.inputValue(), "dana");

  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.getByLabel("Search admins").inputValue(), "dana");
  assert.equal(await visibleCards(page), 1);

  for (const [query, id] of [["search=olive", OWNER], ["search=900102", QUIET], ["search=Support+lead", LEAD], ["search=%D8%AF%D8%A7%D9%86%D8%A7", LEAD]]) {
    await open(page, `?${query}`);
    assert.equal(await visibleCards(page), 1, query);
    await card(page, id).waitFor();
  }
  await context.close();
});

await step("filters: role and status narrow the list, and the empty state offers the way back", async () => {
  const { page, context } = await newPage();
  await open(page);
  const choose = async (label, option) => {
    await page.getByRole("combobox", { name: label }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  await choose("Filter by role", "Owner");
  await page.waitForURL(/role=owner/);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="admin-card-"]').length === 1);
  await card(page, OWNER).waitFor();

  await choose("Filter by account status", "Removed");
  await page.waitForURL(/status=removed/);
  await page.getByText("No admins match these filters.").waitFor();
  assert.equal(await visibleCards(page), 0);
  await page.getByText("Current admins").waitFor();

  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="admin-card-"]').length === 6);

  await open(page, "?status=removed");
  await card(page, FORMER).waitFor();
  assert.equal(await visibleCards(page), 1);
  await open(page, "?status=blocked");
  await card(page, FLAGGED).waitFor();
  assert.equal(await visibleCards(page), 1);
  await context.close();
});

await step("drawer: profile, activity and security tabs show the admin's real records", async () => {
  const { page, context, problems } = await newPage();
  await open(page);
  await card(page, LEAD).getByRole("button", { name: /دانا/ }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByText("Support lead").waitFor();
  await drawer.getByText("Added in panel").waitFor();
  await drawer.getByRole("link", { name: "@dana_fake" }).waitFor();
  assert.equal(await drawer.getByRole("link", { name: "@dana_fake" }).getAttribute("href"), "https://t.me/dana_fake");
  await page.screenshot({ path: join(shots, "drawer-profile.png") });

  await drawer.getByRole("tab", { name: "Activity" }).click();
  await drawer.getByText("Failed, 30 days").waitFor();
  await drawer.getByRole("region", { name: "Recent actions" }).getByText("User balance changed").first().waitFor();
  await drawer.getByText("user 1001").waitFor();
  assert.match(await drawer.getByRole("link", { name: "Open audit log" }).getAttribute("href"), new RegExp(`/panel/audit\\?actor=${LEAD}$`));
  await page.screenshot({ path: join(shots, "drawer-activity.png") });

  await drawer.getByRole("tab", { name: "Security" }).click();
  await drawer.getByRole("region", { name: "Web sign-in history" }).getByText("Signed in").waitFor();
  await drawer.getByText("IP 192.0.2.10").waitFor();
  await drawer.getByRole("region", { name: "Account changes" }).getByText("Admin added").waitFor();
  await drawer.getByText(`by ${OWNER}`).waitFor();
  await drawer.getByText("Failed sign-ins: only successful ones are logged").waitFor();
  await page.screenshot({ path: join(shots, "drawer-security.png") });
  assert.deepEqual(problems, []);
  await context.close();
});

await step("drawer: an account that blocked the bot, and one the bot never met, are explained", async () => {
  const { page, context } = await newPage();
  await open(page);
  await card(page, FLAGGED).getByRole("button", { name: /Finley/ }).click();
  await page.getByRole("dialog").getByText("This account blocked the bot", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  await card(page, STRANGER).getByRole("button", { name: "Not yet met" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByText("This account has not messaged the bot").waitFor();
  await drawer.getByRole("tab", { name: "Security" }).click();
  await drawer.getByText("No web sign-ins recorded.").waitFor();
  await context.close();
});

await step("drawer: a failed load says so, retries, and keeps the header", async () => {
  const { page, context } = await newPage();
  await open(page);
  let failing = true;
  await page.route(`**/api/admin/admins/directory/${LEAD}`, (route) => (failing ? route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false,"error":"internal_error"}' }) : route.continue()));
  await card(page, LEAD).getByRole("button", { name: /دانا/ }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("alert").waitFor();
  await drawer.getByText(`Telegram ID ${LEAD}`).waitFor();
  failing = false;
  await drawer.getByRole("button", { name: "Try again" }).click();
  await drawer.getByText("Support lead").waitFor();
  assert.equal(await drawer.getByRole("alert").count(), 0);
  await context.close();
});

await step("drawer: a slow load shows a skeleton, not an empty panel", async () => {
  const { page, context } = await newPage();
  await open(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(`**/api/admin/admins/directory/${OWNER}`, async (route) => { await held; await route.continue(); });
  await card(page, OWNER).getByRole("button", { name: "Olive Fake" }).click();
  await page.getByRole("status", { name: "Loading profile" }).waitFor();
  release();
  await page.getByRole("dialog").getByRole("tab", { name: "Profile" }).waitFor();
  await context.close();
});

await step("keyboard: a card opens from the keyboard, and closing returns focus to it", async () => {
  const { page, context } = await newPage();
  await open(page);
  const button = card(page, QUIET).getByRole("button", { name: "Quinn" });
  await button.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("tab", { name: "Profile" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await button.evaluate((node) => node === document.activeElement), true);
  await context.close();
});

await step("permissions: Remove is offered exactly where it was, and clicking it does not open the profile", async () => {
  const { page, context } = await newPage();
  await open(page);
  assert.equal(await page.getByRole("button", { name: `Remove ${OWNER}` }).count(), 0, "the owner");
  assert.equal(await page.getByRole("button", { name: `Remove ${FORMER}` }).count(), 0, "already removed");
  await page.getByRole("button", { name: `Remove ${LEAD}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await context.close();
});

await step("signed out: the directory never renders", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
  const page = await context.newPage();
  await page.goto("/panel/admins", { waitUntil: "networkidle" });
  assert.match(page.url(), /sign-in/);
  assert.equal(await visibleCards(page), 0);
  await context.close();
});

if (process.env.AXE_PATH) {
  const axe = readFileSync(process.env.AXE_PATH, "utf8");
  // Evaluated through the DevTools protocol, because the panel's CSP correctly refuses an injected script.
  const audit11y = async (page, label) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Runtime.evaluate", { expression: axe });
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] }).then((r) => JSON.stringify(r.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))))",
      awaitPromise: true, returnByValue: true,
    });
    assert.equal(result.value, "[]", label);
  };
  for (const theme of ["light", "dark"]) {
    await step(`accessibility: ${theme} list and every drawer tab`, async () => {
      const { page, context } = await newPage({ theme });
      await open(page);
      await page.waitForTimeout(600);
      await audit11y(page, "list");
      await card(page, LEAD).getByRole("button", { name: /دانا/ }).click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("tab", { name: "Profile" }).waitFor();
      await page.waitForTimeout(600);
      await audit11y(page, "profile tab");
      for (const tab of ["Activity", "Security"]) {
        await drawer.getByRole("tab", { name: tab }).click();
        await page.waitForTimeout(200);
        await audit11y(page, `${tab} tab`);
      }
      await context.close();
    });
  }
}

await browser.close();
await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
await disconnectTestDB();
console.log(`\n${results.passed} passed, ${results.failed.length} failed. Screenshots: ${shots}`);
for (const name of results.failed) console.log(`  failed: ${name}`);
process.exit(results.failed.length ? 1 : 0);
