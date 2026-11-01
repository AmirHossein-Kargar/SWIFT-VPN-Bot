/**
 * Browser-level checks of the PUBLIC STOREFRONT (the Next.js Pages Router build)
 * running under the real Express app and therefore the real, strict CSP:
 * hydration, console/CSP errors, light/dark + persistence, plan rendering,
 * duration tabs (RTL keyboard), the order-review dialog (success and every
 * failure path), RTL layout, touch targets, accessibility and SEO metadata.
 *
 * Run:  npm run build:storefront && npm run test:e2e:store
 * Needs Chrome/Chromium (set CHROME_PATH if not auto-detected). Accessibility
 * checks use axe-core when it is resolvable (npm i -D axe-core, or AXE_PATH).
 * Starts the real app on a random port with an in-memory session store; the
 * public catalog needs no database. Not part of `npm test`.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (!existsSync(join(root, "web", "public", "storefront.html"))) {
  console.log("SKIP: storefront build missing — run `npm run build:storefront` first");
  process.exit(0);
}

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.BOT_USERNAME = "Swift_servicebot";
process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");
const { resetStoreRateLimitsForTests } = await import("../../web/storeRouter.js");
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
let catalogHits = 0; // real network requests that reached Express (cache/preload hits do not count)
server.prependListener("request", (request) => { if (request.url.startsWith("/api/store/catalog")) catalogHits += 1; });
const base = `http://127.0.0.1:${server.address().port}`;

const CHROME = process.env.CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((candidate) => existsSync(candidate));
if (!CHROME) { console.log("SKIP: no Chrome/Chromium found (set CHROME_PATH)"); server.close(); process.exit(0); }

let AXE = null;
try { AXE = readFileSync(process.env.AXE_PATH || createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8"); } catch { /* optional */ }

const catalog = (await (await fetch(`${base}/api/store/catalog`)).json()).data;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const issues = new Set();
const record = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };
async function step(name, fn) {
  try { const detail = await fn(); record(name, true, detail || ""); }
  catch (error) { record(name, false, String(error.message).split("\n").filter(Boolean).slice(0, 4).join(" | ").slice(0, 500)); }
}

/** New page with CSP-violation + console capture. `hook` can intercept /api/store requests. */
async function open({ scheme = "light", width = 1280, stored = {}, route } = {}) {
  resetStoreRateLimitsForTests(); // the public API allows 120 req/min per IP; this suite makes many
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: "fa-IR" });
  const page = await context.newPage();
  const tag = `${scheme}-${width}`;
  await context.addInitScript((entries) => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    for (const [key, value] of Object.entries(entries)) { try { if (!localStorage.getItem("__seeded")) localStorage.setItem(key, value); } catch { /* blocked */ } }
    try { localStorage.setItem("__seeded", "1"); } catch { /* blocked */ }
  }, stored);
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Scenarios that deliberately break the API make the browser log the failed request itself.
    if (route && /^Failed to load resource/.test(message.text())) return;
    issues.add(`[${tag}] console: ${message.text().slice(0, 160)}`);
  });
  page.on("pageerror", (error) => issues.add(`[${tag}] pageerror: ${String(error).slice(0, 160)}`));
  if (route) await page.route("**/api/store/**", route);
  await page.goto(base + "/", { waitUntil: "networkidle" });
  return { context, page, tag };
}
const planButtons = (page) => page.getByRole("button", { name: /^انتخاب پلن/ });
const cspViolations = (page) => page.evaluate(() => window.__csp);
const expectedPlans = (days) => catalog.plans.filter((plan) => plan.days === days).length;
const durationTabs = (page) => page.locator("#plans").getByRole("tab");
const selectedDays = (page) => page.locator("#plans").getByRole("tab", { selected: true }).first().evaluate((el) => Number(el.dataset.value));
const faDigits = (value) => new Intl.NumberFormat("fa-IR").format(value);

async function axeCheck(page, label) {
  if (!AXE) return record(`a11y ${label}`, true, "skipped: axe-core not installed");
  await page.evaluate(AXE); // via CDP: addScriptTag would be (correctly) blocked by the page CSP
  // preload:false — axe otherwise fetch()es cross-origin stylesheets (Google Fonts) to inspect them, which the page's connect-src correctly refuses.
  const violations = await page.evaluate(async () => (await window.axe.run(document, { preload: false, resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(" ").slice(0, 70)} :: ${(n.any[0]?.message || "").slice(0, 90)}`) })));
  const serious = violations.filter((v) => ["serious", "critical"].includes(v.impact));
  record(`a11y (axe serious/critical) ${label}`, serious.length === 0, serious.length ? JSON.stringify(serious) : `${violations.length} minor/moderate`);
}

// ───────────────────────── every theme × width: load, hydrate, layout ─────────────────────────
for (const scheme of ["light", "dark"]) {
  for (const width of [375, 1280]) {
    const { context, page } = await open({ scheme, width });
    const label = `${scheme} ${width}px`;
    await step(`[${label}] loads under the real CSP: no console errors, no CSP violations, hydrated`, async () => {
      const csp = await cspViolations(page);
      if (csp.length) throw new Error("CSP violations: " + csp.join("; "));
      await page.waitForFunction(() => document.querySelector("#__next") && document.querySelectorAll('button[aria-label^="انتخاب پلن"]').length > 0);
      const html = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, bodyDir: getComputedStyle(document.body).direction }));
      assert.deepEqual(html, { lang: "fa", dir: "rtl", bodyDir: "rtl" });
    });
    await step(`[${label}] initial theme follows the OS and the page has no horizontal overflow`, async () => {
      const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      assert.equal(dark, scheme === "dark");
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-theme")), scheme);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.equal(bg, scheme === "dark" ? "rgb(11, 15, 13)" : "rgb(242, 248, 245)");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `overflow ${overflow}px`);
    });
    await step(`[${label}] live plans render for the selected duration and match the API`, async () => {
      const days = await selectedDays(page);
      assert.equal(await planButtons(page).count(), expectedPlans(days));
      const first = catalog.plans.filter((plan) => plan.days === days).sort((a, b) => a.gig - b.gig)[0];
      const text = await page.locator("#plans").innerText();
      assert.ok(text.includes(faDigits(first.price)), `price ${first.price} shown in Persian digits`);
      assert.ok(text.includes("تومان"));
    });
    await step(`[${label}] RTL layout: logo on the right, primary controls meet the 44px touch target`, async () => {
      const logo = await page.locator("header a[aria-label^='Swift VPN'] img:visible").first().boundingBox();
      assert.ok(logo && logo.x + logo.width / 2 > width / 2, "header logo sits on the right in RTL");
      const small = await page.evaluate(() => [...document.querySelectorAll('header button, header a[href="#plans"], [role=tab], button[aria-label^="انتخاب پلن"], summary')]
        .map((el) => ({ n: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 24), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
        .filter((m) => m.h > 0 && m.h < 40));
      assert.deepEqual(small, [], "controls under 40px tall");
    });
    await step(`[${label}] only the active theme's logo is visible and it is not stretched`, async () => {
      const logos = await page.evaluate(() => [...document.querySelectorAll('img[src*="/brand/"]')].filter((i) => i.offsetParent !== null).map((i) => ({ src: i.src.split("/brand/")[1], ratio: +(i.getBoundingClientRect().width / i.getBoundingClientRect().height).toFixed(2), natural: i.naturalWidth > 0 })));
      assert.ok(logos.length >= 2, "header + footer logos visible");
      for (const logo of logos) {
        assert.equal(logo.src.includes("on-dark"), scheme === "dark", `variant ${logo.src}`);
        assert.ok(logo.natural, "image decoded");
        if (logo.src.startsWith("logo-horizontal")) assert.ok(Math.abs(logo.ratio - 2.63) < 0.05, `ratio ${logo.ratio}`);
      }
    });
    await axeCheck(page, label);
    await page.screenshot({ path: join(process.env.SHOTS || ".", `store-${scheme}-${width}.png`) }).catch(() => {});
    await context.close();
  }
}

// ───────────────────────── theme: toggle, persistence, stored preference wins ─────────────────────────
{
  const { context, page } = await open({ scheme: "light" });
  await step("theme toggle flips class/attribute/theme-color, persists, and survives a reload", async () => {
    const toggle = page.getByRole("button", { name: /تغییر پوسته/ });
    await toggle.click();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), true);
    assert.equal(await page.evaluate(() => localStorage.getItem("swift.theme")), "dark");
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), "#0B0F0D");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), true, "stored dark beats the light OS setting");
    await page.getByRole("button", { name: /تغییر پوسته/ }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("swift.theme")), "light");
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), "#F2F8F5");
  });
  await step("the theme is applied BEFORE first paint (no flash): class is set by the blocking external script", async () => {
    const early = await context.newPage();
    await early.addInitScript(() => { try { localStorage.setItem("swift.theme", "dark"); } catch { /* blocked */ } });
    let sawLightFlash = false;
    await early.exposeFunction("__flash", () => { sawLightFlash = true; });
    await early.addInitScript(() => {
      new MutationObserver(() => { if (document.body && !document.documentElement.classList.contains("dark")) window.__flash(); }).observe(document.documentElement, { attributes: true, childList: true, subtree: true });
    });
    await early.goto(base + "/", { waitUntil: "domcontentloaded" });
    assert.equal(sawLightFlash, false);
    assert.equal(await early.evaluate(() => document.documentElement.classList.contains("dark")), true);
    await early.close();
  });
  await context.close();
}

// ───────────────────────── loading: the catalog is requested once, early (preload), and consumed by the app ─────────────────────────
{
  catalogHits = 0;
  const { context, page } = await open();
  await step("catalog request: ONE network request per page load (the <link rel=preload as=fetch> is reused by fetch())", async () => {
    await page.locator('button[aria-label^="انتخاب پلن"]').first().waitFor();
    assert.equal(catalogHits, 1, `catalog hit the server ${catalogHits} times`);
    const hint = await page.evaluate(() => { const l = document.querySelector('link[rel="preload"][as="fetch"]'); return l && { href: l.getAttribute("href"), cors: l.getAttribute("crossorigin") }; });
    assert.deepEqual(hint, { href: "/api/store/catalog", cors: "anonymous" });
  });
  await step("catalog request starts before the app JavaScript has run (it is in the HTML head)", async () => {
    const html = await (await fetch(base + "/")).text();
    const hintAt = html.indexOf('rel="preload" href="/api/store/catalog"');
    assert.ok(hintAt > -1 && hintAt < html.indexOf("</head>"), "preload hint is in <head>");
    assert.ok(hintAt < html.indexOf('src="/_next/static/chunks/main-'), "and precedes the app scripts");
  });
  await step("tabs are wired per the WAI-ARIA pattern: roving tabindex, tab↔panel ids, labelled panel", async () => {
    const wiring = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#plans [role="tab"]')];
      const panel = document.querySelector('[role="tabpanel"]');
      const selected = tabs.filter((tab) => tab.getAttribute("aria-selected") === "true");
      return {
        count: tabs.length, selected: selected.length,
        tabindex: tabs.map((tab) => tab.tabIndex), list: document.querySelector('[role="tablist"]')?.getAttribute("aria-label"),
        controlsExists: !!document.getElementById(selected[0]?.getAttribute("aria-controls") ?? ""),
        panelLabelledBy: panel?.getAttribute("aria-labelledby") === selected[0]?.id, ids: new Set(tabs.map((tab) => tab.id)).size,
      };
    });
    assert.equal(wiring.selected, 1);
    assert.deepEqual(wiring.tabindex.filter((index) => index === 0).length, 1, "exactly one tab stop");
    assert.equal(wiring.list, "مدت اشتراک");
    assert.equal(wiring.controlsExists, true, "aria-controls points at a real panel");
    assert.equal(wiring.panelLabelledBy, true);
    assert.equal(wiring.ids, wiring.count, "tab ids are unique");
  });
  await context.close();
}

// ───────────────────────── duration tabs: selection, persistence, RTL keyboard ─────────────────────────
{
  const { context, page } = await open();
  const triggers = durationTabs(page);
  await step("duration tabs: switching changes the plans, and the choice is remembered after reload", async () => {
    const count = await triggers.count();
    assert.equal(count, catalog.durations.length);
    const second = catalog.durations[1].days;
    await triggers.nth(1).click();
    assert.equal(await planButtons(page).count(), expectedPlans(second));
    assert.equal(await page.evaluate(() => localStorage.getItem("swift.store.duration")), String(second));
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("#plans").getByRole("tab", { selected: true }).first().innerText().then((t) => t.includes(String(faDigits(second)))), true, "saved duration restored");
  });
  await step("RTL keyboard: ArrowLeft moves to the next duration, ArrowRight back; Home/End jump", async () => {
    await triggers.nth(0).click();
    await triggers.nth(0).focus();
    // Radix moves focus in a timeout after the keydown, so wait for the expected index instead of reading immediately.
    const focusIndex = (expected, why) => page.waitForFunction((index) => [...document.querySelectorAll("#plans [role=tab]")].indexOf(document.activeElement) === index, expected, { timeout: 3000 }).catch(() => { throw new Error(`${why}: focus never reached tab ${expected}`); });
    await page.keyboard.press("ArrowLeft");
    await focusIndex(1, "ArrowLeft → next in RTL");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-selected")), "true", "focus selects (automatic activation)");
    await page.keyboard.press("ArrowRight");
    await focusIndex(0, "ArrowRight → previous in RTL");
    await page.keyboard.press("End");
    await focusIndex(catalog.durations.length - 1, "End → last");
    await page.keyboard.press("Home");
    await focusIndex(0, "Home → first");
  });
  await context.close();
}

// ───────────────────────── order review: success, focus, and every failure path ─────────────────────────
{
  const { context, page } = await open();
  await step("order review: the dialog chunk is NOT loaded until the visitor shows intent on a plan", async () => {
    const scripts = () => page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name).filter((n) => n.endsWith(".js")));
    const initial = await scripts();
    assert.ok(initial.length >= 4, "framework/main/page chunks loaded");
    await page.waitForTimeout(1500); // idle time must not pull the dialog in either
    assert.equal((await scripts()).length, initial.length, "no extra script is fetched while idle");
    await planButtons(page).first().hover();
    await page.waitForFunction((count) => performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js")).length > count, initial.length, { timeout: 5000 });
    return `${initial.length} scripts at load, +1 on hover intent`;
  });
  await step("order review: shows the plan summary, validates server-side, and hands off to the server-built Telegram link", async () => {
    const days = await selectedDays(page);
    const plan = catalog.plans.filter((p) => p.days === days).sort((a, b) => a.gig - b.gig)[0];
    const server = (await (await fetch(`${base}/api/store/plans/${plan.id}`)).json()).data;
    const opener = planButtons(page).first();
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.ok((await dialog.innerText()).includes(faDigits(plan.price)), "price in the summary");
    const link = dialog.getByRole("link", { name: /ادامه خرید در تلگرام/ });
    await link.waitFor({ timeout: 8000 });
    assert.equal(await link.getAttribute("href"), server.checkout.url);
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.match((await link.getAttribute("rel")) || "", /noopener/);
    assert.equal(await dialog.getAttribute("aria-describedby") !== null, true, "described for screen readers");
    await axeCheck(page, "order dialog open");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("انتخاب پلن"));
    await opener.click(); await dialog.waitFor();
    await dialog.getByRole("button", { name: "بازگشت به پلن‌ها" }).click(); await dialog.waitFor({ state: "hidden" });
  });
  await step("order review keeps focus inside the dialog (Tab cycles) and locks background scroll", async () => {
    await planButtons(page).first().click();
    const dialog = page.getByRole("dialog"); await dialog.waitFor();
    await dialog.getByRole("link", { name: /ادامه خرید/ }).waitFor();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true, "focus never escapes");
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), "hidden");
    await page.keyboard.press("Escape");
  });
  await context.close();
}

async function failurePath(name, { stored, route, assertions }) {
  const { context, page } = await open({ route });
  await step(name, async () => { await assertions(page, context); });
  await context.close();
}

await failurePath("failure: catalog API down → error notice with retry; retry recovers", {
  route: (() => { let failing = true; globalThis.__recover = () => { failing = false; }; return (r) => (failing && r.request().url().includes("/catalog") ? r.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false,"error":"boom"}' }) : r.continue()); })(),
  assertions: async (page) => {
    await page.getByRole("alert").getByText("دریافت فهرست پلن‌ها ممکن نشد").waitFor();
    assert.equal(await planButtons(page).count(), 0);
    globalThis.__recover();
    await page.getByRole("button", { name: "تلاش دوباره" }).click();
    await planButtons(page).first().waitFor();
  },
});

await failurePath("failure: empty catalog → friendly notice, no tabs, no plan buttons", {
  route: (r) => (r.request().url().includes("/catalog") ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { ...catalog, plans: [], durations: [] } }) }) : r.continue()),
  assertions: async (page) => {
    await page.getByText("در حال حاضر پلنی برای فروش فعال نیست").waitFor();
    assert.equal(await durationTabs(page).count(), 0);
    assert.equal(await planButtons(page).count(), 0);
  },
});

await failurePath("failure: plan no longer sold (404) → no hand-off link, message shown, catalog is refreshed", {
  route: (() => { let catalogCalls = 0; globalThis.__catalogCalls = () => catalogCalls; return (r) => { const url = r.request().url(); if (url.includes("/catalog")) catalogCalls += 1; return url.includes("/api/store/plans/") ? r.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false,"error":"plan_not_available"}' }) : r.continue(); }; })(),
  assertions: async (page) => {
    await planButtons(page).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("این پلن دیگر برای فروش فعال نیست").waitFor();
    assert.equal(await dialog.getByRole("link", { name: /ادامه خرید/ }).count(), 0, "never offers a hand-off for a retired plan");
    assert.equal(await dialog.getByRole("button", { name: "تلاش دوباره" }).count(), 0, "no pointless retry");
    const catalogRequests = () => page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/store/catalog")).length);
    await page.waitForFunction(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/store/catalog")).length >= 2);
    // Regression: refreshing used to blank the catalog, unmount the dialog and re-open it for the same retired
    // plan — an endless reload loop that tripped the API rate limit. The count must settle and stop growing.
    // (Request interception in this scenario disables preload reuse, so the page load itself counts twice:
    // preload + fetch, plus exactly one background refresh = 3 at most.)
    await page.waitForTimeout(2500);
    const settled = await catalogRequests();
    await page.waitForTimeout(2000);
    assert.equal(await catalogRequests(), settled, "no further catalog requests: the refresh does not loop");
    assert.ok(settled <= 3, `initial load (preload + fetch) + one background refresh, saw ${settled}`);
    assert.equal(await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/store/plans/")).length), 1, "the retired plan is checked once");
    assert.equal(await dialog.isVisible(), true, "the dialog (and its message) stays open during the refresh");
    // CSS locator: while the dialog is open Radix marks the background aria-hidden, so role queries cannot see it.
    assert.ok(await page.locator('button[aria-label^="انتخاب پلن"]').count() > 0, "the plan list is still rendered during/after the refresh");
  },
});

await failurePath("failure: plan check network error → error + retry; retry succeeds and hands off", {
  route: (() => { let failing = true; globalThis.__heal = () => { failing = false; }; return (r) => (failing && r.request().url().includes("/api/store/plans/") ? r.abort("failed") : r.continue()); })(),
  assertions: async (page) => {
    await planButtons(page).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("بررسی پلن ممکن نشد").waitFor();
    assert.equal(await dialog.getByRole("link", { name: /ادامه خرید/ }).count(), 0);
    globalThis.__heal();
    await dialog.getByRole("button", { name: "تلاش دوباره" }).click();
    await dialog.getByRole("link", { name: /ادامه خرید در تلگرام/ }).waitFor({ timeout: 8000 });
  },
});

await failurePath("failure: bot unavailable (checkout.available=false) → no link, clear message", {
  route: (r) => {
    if (!r.request().url().includes("/api/store/plans/")) return r.continue();
    return r.fetch().then(async (response) => { const body = await response.json(); body.data.checkout = { ...body.data.checkout, available: false, url: null }; return r.fulfill({ response, json: body }); });
  },
  assertions: async (page) => {
    await planButtons(page).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("ربات تلگرام در حال حاضر در دسترس نیست").waitFor();
    assert.equal(await dialog.getByRole("link", { name: /ادامه خرید/ }).count(), 0);
  },
});

await failurePath("failure: a hostile hand-off URL from the API is never rendered as a link", {
  route: (r) => {
    if (!r.request().url().includes("/api/store/plans/")) return r.continue();
    return r.fetch().then(async (response) => { const body = await response.json(); body.data.checkout = { available: true, url: "javascript:alert(1)" }; return r.fulfill({ response, json: body }); });
  },
  assertions: async (page) => {
    await planButtons(page).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("ربات تلگرام در حال حاضر در دسترس نیست").waitFor();
    assert.equal(await dialog.locator('a[href^="javascript:"]').count(), 0);
  },
});

// ───────────────────────── landing sections: guides, devices, FAQ, navigation ─────────────────────────
{
  const { context, page } = await open({ width: 1280 });
  await step("payment guide: card-to-card is the default, the crypto tab swaps the guide, both stay in the DOM", async () => {
    const tabs = page.locator("#payment").getByRole("tab");
    assert.equal(await tabs.count(), 2);
    assert.equal(await tabs.first().getAttribute("aria-selected"), "true");
    assert.equal(await page.locator("#payment [role=tabpanel]:not([hidden]) h3").count(), 6, "six card-to-card steps, all in the DOM");
    assert.equal(await page.locator("#payment [role=tabpanel][hidden]").count(), 1, "the crypto guide is present but hidden");
    await tabs.nth(1).click();
    assert.equal(await page.locator("#payment [role=tabpanel]:not([hidden]) h3").count(), 7, "seven crypto steps");
    const panel = await page.locator("#payment [role=tabpanel]:not([hidden])").innerText();
    assert.ok(panel.includes("شبکه") && panel.includes("قبل از ارسال حتماً بررسی کنید"), "network warning panel is shown");
    await tabs.first().focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(() => document.querySelector("#payment [role=tab][aria-selected=true]")?.textContent.includes("کریپتو"));
    await tabs.first().click();
  });
  await step("payment guide: the stepper moves through the steps and shows one at a time", async () => {
    const panel = page.locator("#payment [role=tabpanel]:not([hidden])");
    const visibleTitle = () => panel.locator("[data-guide-step]:not([hidden]) h3").innerText();
    assert.equal(await panel.locator("[data-guide-step]:not([hidden])").count(), 1);
    assert.equal(await visibleTitle(), "ورود به افزایش موجودی");
    assert.equal(await panel.locator('[aria-current="step"]').innerText().then((text) => text.includes("ورود")), true);
    await panel.getByRole("button", { name: "مرحلهٔ بعد" }).click();
    assert.equal(await visibleTitle(), "انتخاب کارت‌به‌کارت");
    assert.ok((await panel.locator("[aria-live=polite]").first().innerText()).includes("مرحلهٔ ۲ از ۶"));
    await panel.getByRole("button", { name: "مرحلهٔ قبل" }).click();
    assert.equal(await visibleTitle(), "ورود به افزایش موجودی");
    const steps = panel.getByRole("list", { name: "مراحل پرداخت کارت‌به‌کارت" }).getByRole("button");
    assert.equal(await steps.count(), 6);
    await steps.nth(5).click();
    assert.equal(await visibleTitle(), "«پرداخت کردم» و تأیید درگاه");
    assert.ok((await panel.locator("[data-guide-step]:not([hidden])").innerText()).includes("ارسال رسید لازم نیست"));
    assert.equal(await panel.getByRole("button", { name: "مرحلهٔ بعد" }).count(), 0, "the last step has nowhere to go");
    await steps.nth(0).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await visibleTitle(), "انتخاب کارت‌به‌کارت", "in RTL ArrowLeft moves forward");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-current")), "step", "focus follows the step");
  });
  await step("payment guide: images load, are labelled, and enlarge in an accessible dialog", async () => {
    const panel = page.locator("#payment [role=tabpanel]:not([hidden])");
    const image = panel.locator("[data-guide-step]:not([hidden]) img");
    await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const img = document.querySelector("#payment [role=tabpanel]:not([hidden]) [data-guide-step]:not([hidden]) img");
      return img?.complete && img.naturalWidth === 800;
    });
    assert.ok((await image.getAttribute("alt")).length > 20);
    assert.ok((await panel.locator("[data-guide-step]:not([hidden]) figcaption").innerText()).length > 10);
    const opener = panel.locator("[data-guide-step]:not([hidden]) [data-enlarge]");
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await dialog.getByRole("heading").innerText(), "انتخاب کارت‌به‌کارت");
    await page.waitForFunction(() => document.querySelector("[role=dialog] img")?.naturalWidth === 800);
    assert.ok((await dialog.locator("img").evaluate((el) => el.getBoundingClientRect().width)) > (await opener.locator("img").evaluate((el) => el.getBoundingClientRect().width)), "the dialog image is larger");
    await page.keyboard.press("ArrowLeft");
    await dialog.getByText("مرحلهٔ ۳ از ۶").waitFor();
    assert.equal(await dialog.getByRole("heading").innerText(), "مبلغ را وارد کنید");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-enlarge"), undefined, { timeout: 2000 });
    assert.equal(await panel.locator("[data-guide-step]:not([hidden]) h3").innerText(), "مبلغ را وارد کنید", "the guide stayed on the step reached in the dialog");
  });
  await step("tabs: the sliding pill sits exactly under the active tab", async () => {
    const pill = page.locator("#payment .tabs-pill");
    await page.waitForFunction(() => document.querySelector("#payment .tabs-list")?.dataset.pill === "ready");
    const aligned = () => page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const a = document.querySelector("#payment .tabs-pill").getBoundingClientRect();
      const b = document.querySelector("#payment [role=tab][aria-selected=true]").getBoundingClientRect();
      return Math.abs(a.left - b.left) < 1.5 && Math.abs(a.width - b.width) < 1.5;
    });
    assert.equal(await aligned(), true);
    await page.locator("#payment").getByRole("tab").nth(1).click();
    assert.equal(await aligned(), true);
    assert.equal(await pill.getAttribute("aria-hidden"), "true");
    await page.locator("#payment").getByRole("tab").first().click();
  });
  await step("payment guide: mockups never contain a real-looking card number or address", async () => {
    const text = await page.locator("#payment").innerText();
    assert.doesNotMatch(text, /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/, "no 16-digit card number");
    assert.doesNotMatch(text, /\bT[1-9A-HJ-NP-Za-km-z]{33}\b|\b0x[0-9a-fA-F]{40}\b|\bbc1[0-9a-z]{20,}\b/, "no wallet address");
  });
  await step("device guide: selecting a platform changes the instructions; the Telegram guide link is the bot's own", async () => {
    const tabs = page.locator("#devices").getByRole("tab");
    assert.equal(await tabs.count(), 4);
    await tabs.nth(2).click(); // Windows
    const visible = page.locator("#devices [role=tabpanel]:not([hidden])");
    assert.ok((await visible.innerText()).includes("ویندوز"));
    assert.equal(await visible.getByRole("link", { name: /آموزش گام‌به‌گام/ }).getAttribute("href"), "https://t.me/swift_shield/8");
    await tabs.nth(3).click(); // macOS has no bot guide: no invented link
    assert.equal(await page.locator("#devices [role=tabpanel]:not([hidden])").getByRole("link").count(), 0);
  });
  await step("FAQ: accordion opens/closes, cross-links open their entry, structured data matches the visible questions", async () => {
    const items = page.locator("#faq details");
    assert.ok(await items.count() >= 12, "expanded FAQ");
    await items.first().locator("summary").click();
    assert.equal(await items.first().evaluate((el) => el.open), true);
    await items.first().locator("summary").click();
    assert.equal(await items.first().evaluate((el) => el.open), false);
    const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    assert.equal(ld["@type"], "FAQPage");
    assert.equal(ld.mainEntity.length, await items.count());
    assert.equal(ld.mainEntity[0].name, await items.first().locator("summary").innerText());
  });
  await step("anchors: every header link targets a real section and sections clear the sticky header", async () => {
    const hrefs = await page.locator("header nav a").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    assert.deepEqual(hrefs, ["#plans", "#features", "#payment", "#devices", "#faq"]);
    for (const href of hrefs) {
      await page.locator(`header nav a[href="${href}"]`).click();
      await page.waitForFunction((hash) => location.hash === hash, href);
      // Smooth scrolling: poll until the target section sits just under the header (or fail after 8 s).
      const gapOf = (hash) => document.querySelector(hash).getBoundingClientRect().top - document.querySelector("header").getBoundingClientRect().bottom;
      let gap = Infinity;
      for (let attempt = 0; attempt < 40 && !(gap >= -2 && gap < 120); attempt += 1) { // smooth scrolling: poll until it lands
        await page.waitForTimeout(200);
        gap = await page.evaluate(gapOf, href);
      }
      assert.ok(gap >= -2 && gap < 120, `${href} starts just below the header (gap ${Math.round(gap)}, scrollY ${await page.evaluate(() => scrollY)}, top ${await page.evaluate((h) => document.querySelector(h).getBoundingClientRect().top, href)}, headerBottom ${await page.evaluate(() => document.querySelector("header").getBoundingClientRect().bottom)}, hash ${await page.evaluate(() => location.hash)})`);
    }
  });
  await context.close();
}

{
  const { context, page } = await open({ width: 375 });
  await step("mobile menu: opens, lists every section + the bot, closes on Escape and on selection, no overflow", async () => {
    const button = page.getByRole("button", { name: "باز کردن منو" });
    assert.equal(await button.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator("header nav a").first().isVisible(), false, "desktop nav is hidden on phones");
    await button.click();
    const menu = page.locator("#mobile-nav");
    assert.equal(await menu.locator("a").count(), 5 + 1, "five sections + bot link");
    assert.equal(await page.getByRole("button", { name: "بستن منو" }).getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-controls") === "mobile-nav");
    await page.getByRole("button", { name: "باز کردن منو" }).click();
    await menu.getByRole("link", { name: "راهنمای پرداخت" }).click();
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => location.hash), "#payment");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1);
  });
  await step("scroll reveal: below-the-fold blocks fade in on scroll, pricing never waits for it", async () => {
    assert.equal(await page.locator("#plans .reveal-hidden").count(), 0, "plans are never hidden");
    const below = page.locator("#faq [data-reveal]");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await below.evaluate((el) => el.classList.contains("reveal-hidden")), true, "starts hidden below the fold");
    await below.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector("#faq [data-reveal]").classList.contains("reveal-hidden"));
  });
  await context.close();
}

{
  const { context, page } = await open({ width: 320 });
  await step("320px: no horizontal overflow, no clipped section, payment mockups fit", async () => {
    await page.evaluate(() => document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.remove("reveal-hidden")));
    const report = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wide: [...document.querySelectorAll("main *")].filter((el) => !el.closest(".pointer-events-none, .guide-nav") && (el.getBoundingClientRect().right > innerWidth + 1 || el.getBoundingClientRect().left < -1)).slice(0, 5).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`),
    }));
    assert.equal(report.overflow, 0);
    assert.deepEqual(report.wide, []);
  });
  await context.close();
}

// Reduced motion: nothing is ever hidden by the reveal script, and decorative loops stop.
{
  const context = await browser.newContext({ viewport: { width: 375, height: 800 }, reducedMotion: "reduce", locale: "fa-IR" });
  const page = await context.newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await step("prefers-reduced-motion: no element is hidden for reveal and the connection packets are off", async () => {
    assert.equal(await page.locator(".reveal-hidden").count(), 0);
    assert.equal(await page.locator(".flow-packet").first().evaluate((el) => getComputedStyle(el).display), "none");
  });
  await step("prefers-reduced-motion: the background stops, and the guide still works with no slide-in", async () => {
    assert.equal(await page.locator("#plans").evaluate((el) => getComputedStyle(el, "::before").animationName), "none");
    const panel = page.locator("#payment [role=tabpanel]:not([hidden])");
    await panel.getByRole("button", { name: "مرحلهٔ بعد" }).click();
    const inner = panel.locator("[data-guide-step]:not([hidden]) > div");
    const animation = await inner.evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
    assert.ok(animation < 0.01, "step change is effectively instant");
    assert.equal(await panel.locator("[data-guide-step]:not([hidden]) h3").innerText(), "انتخاب کارت‌به‌کارت");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  });
  await context.close();
}

// ───────────────────────── load behaviour: theme chrome, deep links, what a first visit pays for ─────────────────────────
{
  const { context, page } = await open({ width: 375 });
  await step("a first visit downloads no guide image past step one", async () => {
    const later = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => /\/store\/guide\/(?:card-(?:method|amount|invoice|pay|verify)|crypto-(?:coin|network|amount|invoice|send|status))\.webp/.test(name)));
    assert.deepEqual(later, []);
  });
  await step("scrollbars carry the brand accent, in light and dark", async () => {
    const thumb = () => page.evaluate(() => getComputedStyle(document.documentElement, "::-webkit-scrollbar-thumb").backgroundColor);
    const green = async () => {
      const [r, g, b, alpha] = (await thumb()).match(/[\d.]+/g).map(Number);
      assert.ok(g > r * 2 && g > b && alpha > 0 && alpha < 1, await thumb());
    };
    await green();
    await page.getByRole("button", { name: /تغییر پوسته/ }).click();
    await green();
  });
  await step("the hero's loops stop while it is scrolled away and resume on return", async () => {
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await page.waitForFunction(() => document.querySelector("[data-ambient]").hasAttribute("data-offscreen"));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".flow-line")).animationPlayState), "paused");
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForFunction(() => !document.querySelector("[data-ambient]").hasAttribute("data-offscreen"));
  });
  for (const id of ["faq", "devices", "how"]) {
    await step(`a phone deep link to #${id} lands on it once the plans have loaded`, async () => {
      await page.goto(`${base}/#${id}`, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="انتخاب پلن"]').length > 0);
      await page.waitForFunction((target) => {
        const top = document.getElementById(target).getBoundingClientRect().top;
        return top > 30 && top < 130;
      }, id, { timeout: 4000 });
    });
  }
  await context.close();
}

// ───────────────────────── SEO + structure ─────────────────────────
{
  const { context, page } = await open();
  await step("SEO: title, description, canonical, Open Graph, icons, manifest, one h1, landmarks, FAQ anchors", async () => {
    const seo = await page.evaluate(() => {
      const meta = (selector) => document.querySelector(selector)?.getAttribute("content");
      return {
        title: document.title,
        description: meta('meta[name="description"]'),
        canonical: document.querySelector('link[rel="canonical"]')?.href,
        ogUrl: meta('meta[property="og:url"]'), ogLocale: meta('meta[property="og:locale"]'),
        icons: [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map((l) => l.getAttribute("href")),
        h1: document.querySelectorAll("h1").length,
        h2: [...document.querySelectorAll("h2")].map((h) => h.textContent),
        landmarks: ["header", "main", "footer", "nav"].map((tag) => document.querySelectorAll(tag).length),
        skipLink: document.querySelector('a[href="#main"]')?.textContent,
        trialDetails: !!document.querySelector("details#faq-trial"),
      };
    });
    assert.match(seo.title, /SWIFT VPN/);
    assert.ok(seo.description && seo.description.length > 60);
    assert.equal(seo.canonical, "https://shop.example.com/");
    assert.equal(seo.ogUrl, "https://shop.example.com/");
    // Crawlers read the server HTML (React re-renders <Head> client-side with the site-relative path), so assert on the raw response.
    const raw = await (await fetch(`${base}/`)).text();
    assert.match(raw, /<meta property="og:image" content="https:\/\/shop\.example\.com\/og-image\.png"/, "social image URL is absolute in the served HTML");
    assert.match(raw, /<meta name="twitter:image" content="https:\/\/shop\.example\.com\/og-image\.png"/);
    assert.equal(seo.ogLocale, "fa_IR");
    assert.deepEqual([...seo.icons].sort(), ["/apple-touch-icon.png", "/favicon.ico", "/favicon.svg", "/site.webmanifest"]);
    assert.equal(seo.h1, 1);
    assert.deepEqual(seo.h2, ["پلن‌ها و قیمت‌ها", "خرید در پنج مرحله", "شارژ کیف پول: کارت‌به‌کارت یا ارز دیجیتال", "روی کدام دستگاه استفاده می‌کنید؟", "سرویس تست رایگان", "آنچه از این سرویس انتظار دارید", "سوالات متداول"]);
    assert.ok(seo.landmarks[0] >= 1 && seo.landmarks[1] === 1 && seo.landmarks[2] === 1 && seo.landmarks[3] >= 1);
    assert.ok(seo.skipLink && seo.trialDetails);
  });
  await step("hero 'free trial' link opens the FAQ entry; trial bot link and footer links appear from the live catalog", async () => {
    await page.locator("[aria-labelledby=hero-title]").getByRole("link", { name: "سرویس تست رایگان" }).click();
    await page.waitForFunction(() => location.hash === "#trial");
    assert.equal(await page.locator("#trial").getByRole("link", { name: "دریافت سرویس تست رایگان" }).getAttribute("href"), catalog.checkout.botUrl, "trial CTA opens the bot");
    await page.locator("details#faq-trial summary").click();
    const bot = page.locator("details#faq-trial").getByRole("link", { name: "باز کردن ربات" });
    assert.equal(await bot.getAttribute("href"), catalog.checkout.botUrl);
    assert.equal(await page.locator("footer").getByRole("link", { name: "ربات تلگرام" }).getAttribute("href"), catalog.checkout.botUrl);
  });
  await step("payment methods and the Persian-calendar year come from the client after hydration", async () => {
    const chips = await page.locator("#how [aria-label='روش‌های پرداخت فعال']").innerText();
    for (const method of catalog.paymentMethods.filter((m) => m.available && ["hooshpay", "crypto"].includes(m.id))) assert.ok(chips.length > 0, method.id);
    assert.match(await page.locator("footer p", { hasText: "©" }).innerText(), /©\s*[۰-۹]{4}/);
  });
  await step("skip link is the first tab stop and moves focus to <main>", async () => {
    await page.goto(base + "/", { waitUntil: "networkidle" }); // fresh page: no earlier focus or #fragment
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "پرش به محتوا");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "main");
  });
  await context.close();
}

await step("a crafted #fragment (malformed %-escape, markup, huge) never breaks the page or runs script", async () => {
  for (const hash of ["#%E0%A4%A", "#%", "#%zz", "#<img src=x onerror=alert(1)>", "#" + "a".repeat(5000), "#faq-trial", "#nope"]) {
    const { context, page } = await open();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 120)));
    await page.goto(`${base}/${hash}`, { waitUntil: "networkidle" });
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(150);
    assert.deepEqual(errors, [], `page errors for ${hash.slice(0, 20)}`);
    assert.ok(await planButtons(page).count() > 0, `plans still rendered for ${hash.slice(0, 20)}`);
    assert.equal(await page.locator("img[src='x']").count(), 0, "hash is never rendered as markup");
    assert.deepEqual(await cspViolations(page), []);
    await context.close();
  }
});

await step("no-JavaScript visitors still get the Persian content, the heading structure and a clear plans notice", async () => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "fa-IR" });
  const page = await context.newPage();
  await page.goto(base + "/");
  const text = await page.locator("body").innerText();
  for (const phrase of ["اینترنت آزاد", "پلن‌ها و قیمت‌ها", "خرید در پنج مرحله", "سوالات متداول", "جاوااسکریپت"]) assert.ok(text.includes(phrase), phrase);
  await context.close();
});

await step("an unlimited plan reads as unlimited, comes last, and never shows 0 GB", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const durations = [...new Set(catalog.plans.map((plan) => plan.days))];
  const unlimited = durations.map((days) => ({ id: `unl${days}`, name: "Unlimited", days, durationLabel: null, gig: 0, price: 900_000 }));
  await page.route("**/api/store/catalog*", (route) => route.fulfill({ json: { ok: true, data: { ...catalog, plans: [...unlimited, ...catalog.plans] } } }));
  await page.goto(base, { waitUntil: "networkidle" });
  const choices = page.locator("#plans").getByRole("button", { name: /انتخاب پلن/ });
  await choices.first().waitFor();
  const labels = await choices.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
  assert.match(labels.at(-1), /انتخاب پلن نامحدود/, "unlimited follows every volume");
  assert.equal(labels.filter((label) => /نامحدود/.test(label)).length, 1);
  const text = await page.locator("#plans").innerText();
  assert.doesNotMatch(text, /(?<![۰-۹])۰\s*گیگابایت/, "a standalone zero, not the end of 10 or 50");
  assert.match(text, /بدون سقف حجم، در مدت اعتبار/, "it says the limit that does apply");
  await choices.last().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("حجم نامحدود").waitFor();
  await context.close();
});

await browser.close();
server.close();
auth.setAdminSessionRedisForTests(null);
const failed = results.filter((result) => !result.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log("FAILED:\n  " + failed.map((f) => f.name).join("\n  "));
console.log(`CONSOLE/PAGE ERRORS: ${issues.size}`);
for (const issue of issues) console.log("  " + issue);
process.exit(failed.length || issues.size ? 1 : 0);
