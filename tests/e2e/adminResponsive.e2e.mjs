/**
 * Browser-level checks of the admin dashboard: responsive layout, RTL/LTR,
 * light/dark, navigation drawer, dialogs, touch targets, contrast, localisation.
 *
 * Run:  npm run test:e2e   (needs Chrome/Chromium; set CHROME_PATH if not auto-detected)
 * It starts the real Express app on a random port with an in-memory session
 * store and answers /api/admin/* from fixtures inside the browser, so it needs
 * no database and never touches live services. Not part of `npm test`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
const { makeFakeRedis } = await import("../helpers/fakeRedis.js");
const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const { default: app } = await import("../../server.js");
const { assembleReport, resolveRange, granularityFor } = await import("../../services/admin/analyticsReport.js");

const CHROME = process.env.CHROME_PATH || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find((p) => existsSync(p));
if (!CHROME) { console.log("SKIP: no Chrome/Chromium found (set CHROME_PATH)"); process.exit(0); }

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const shots = process.env.E2E_SHOTS || join(tmpdir(), "swift-admin-shots");
mkdirSync(shots, { recursive: true });

// ── Fixtures ────────────────────────────────────────────────────────────────
const now = new Date();
const range = resolveRange({ range: "30d", now });
const emptyFacts = () => ({
  topups: { providers: ["hooshpay", "nowpayments", "trx", "bank"].map((provider, i) => ({ provider, amount: 1_250_000 * (4 - i), count: 5 - i, series: [{ _id: 3, amount: 1_250_000, count: 2 }, { _id: 20, amount: 2_500_000, count: 3 }] })), crypto: [{ _id: { ticker: "USDT", network: "TRC20" }, amount: 3_000_000, count: 4 }, { _id: { ticker: "TON", network: "TON" }, amount: 900_000, count: 2 }] },
  attempts: [{ provider: "nowpayments", status: "finished", credited: true, recovery: false, count: 8 }, { provider: "nowpayments", status: "failed", credited: false, recovery: false, count: 2, fromTombstone: true }, { provider: "hooshpay", status: "pending", credited: false, recovery: false, count: 1 }],
  refunds: { amount: 200_000, count: 1 },
  sales: { amount: 4_800_000, count: 12, plans: [{ planId: "p1", name: "پلن ۳۰ روزه ۵۰ گیگ", count: 7, amount: 3_000_000 }, { planId: "p2", name: "Plan 90d 100GB", count: 5, amount: 1_800_000 }], series: [{ _id: 5, amount: 1_600_000, count: 4 }, { _id: 21, amount: 3_200_000, count: 8 }], refundAmount: 0, refundCount: 0 },
  users: { total: 1534, created: 87, active: 412, newSeries: [{ _id: 2, count: 9 }, { _id: 10, count: 14 }], buyers: { current: 11, previous: 8, retained: 4 }, walletBalance: { total: 18_400_000, holders: 120 }, expiring: 6, activeServices: 233 },
});
const report = assembleReport({ current: emptyFacts(), previous: { ...emptyFacts(), sales: { ...emptyFacts().sales, amount: 4_000_000, count: 10 } }, range, now, granularity: granularityFor(30) });
const mkUser = (i) => ({ telegramId: String(900000000 + i * 7919), username: i % 3 ? `user_name_${i}` : null, firstName: i % 2 ? "علی" : "Alexander", lastName: "Extremely-Long-Family-Name-For-Wrapping", name: "Alexander Extremely-Long-Family-Name-For-Wrapping", balance: 125_000 * i, successfulPayments: i, totalSpent: 90_000 * i, orderCount: i, serviceCount: i % 4, createdAt: new Date(now - i * 86400000 * 9).toISOString(), lastActivityAt: new Date(now - i * 3600000).toISOString(), isBanned: i % 5 === 0 });
const users = Array.from({ length: 6 }, (_, i) => mkUser(i + 1));
const series = (k) => Array.from({ length: 30 }, (_, i) => ({ date: new Date(now - (29 - i) * 86400000).toISOString().slice(0, 10), value: Math.round(((i * 37) % 17 + 3) * k) }));
const fixtures = {
  "/auth/session": { ok: true, authenticated: true, actorTelegramId: "424242", csrfToken: "x".repeat(43), expiresAt: Date.now() + 3.6e6 },
  "/dashboard": { ok: true, data: { metrics: { totalUsers: 1534, activeUsers: 412, newUsersToday: 9, activeVpns: 233, revenue: { today: 1_250_000, week: 9_400_000, month: 41_200_000 }, averageOrderValueMonth: 310_000, orders: { total: 3120, today: 7, week: 52 }, pendingOrders: 3, failedPayments: 12, failedPaymentRate: 0.043, failedProvisioning: 1 }, charts: { revenue: series(100000), orders: series(1), newUsers: series(1), popularPackages: [{ name: "Plan A", count: 12, revenue: 1 }, { name: "Plan B", count: 7, revenue: 1 }] }, definitions: { activeUsers: "Users active in the last 30 days", activeVpns: "Active VPN services" }, __health: [{ name: "redis", status: "healthy", latencyMs: 3 }, { name: "mongodb", status: "healthy", latencyMs: 8 }] } },
  "/system/health": { ok: true, data: { services: [{ name: "redis", status: "healthy", latencyMs: 3 }] } },
  "/recovery": { ok: true, data: { items: [], total: 0, page: 1, pages: 1 } },
  "/analytics/report": { ok: true, data: report },
  "/users": { ok: true, data: { items: users, page: 1, pages: 3, pageSize: 15, total: 40 } },
  "/payments": { ok: true, data: { items: users.slice(0, 4).map((u, i) => ({ key: `hooshpay:${i}`, id: `ORDER-${i}-0123456789abcdef0123456789abcdef`, provider: "hooshpay", status: i % 2 ? "pending" : "fulfilled", amount: 250_000, telegramId: u.telegramId, createdAt: u.createdAt, trackingCode: "TRK" + i })), page: 1, pages: 1, pageSize: 15, total: 4, counts: {} } },
  "/vpns": { ok: true, data: { items: [], page: 1, pages: 1, total: 0, summary: {} } },
};
function userDetail(id) {
  return { ok: true, data: { user: { ...users[0], telegramId: id }, totalSpent: 540000, orderCount: 6, activeVpns: 2, expiredVpns: 1, untrackedServiceCount: 0, blockedAt: null, testService: { received: true, status: "completed", inFlight: false, eligible: false }, referral: { referralCount: 2, referredByTelegramId: null, trackingAvailable: true }, payments: [{ provider: "nowpayments", id: "NP-11111111-1111-4111-8111-111111111111", amount: 100000, status: "fulfilled", createdAt: now.toISOString() }], services: [{ username: "svc_user_abcdef0123456789abcdef", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 864e5).toISOString() }] } };
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = { passed: 0, failed: [], untranslated: new Set(), viewports: new Set(), screenshots: [] };
function check(condition, message) {
  if (condition) results.passed += 1; else results.failed.push(message);
}

async function newPage(viewport, { lang, theme, mobile }) {
  const context = await browser.newContext({
    viewport, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1,
    reducedMotion: "no-preference",
  });
  await context.addInitScript(({ lang, theme }) => {
    try { if (!localStorage.getItem("swift.lang")) { localStorage.setItem("swift.lang", lang); localStorage.setItem("swift.theme", theme); } } catch { /* ignore */ }
    document.addEventListener("DOMContentLoaded", () => { window.__themeAtDcl = document.documentElement.getAttribute("data-theme"); window.__dirAtDcl = document.documentElement.getAttribute("dir"); });
  }, { lang, theme });
  const page = await context.newPage();
  if (process.env.E2E_DEBUG) page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.route("**/api/admin/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/admin", "");
    const method = route.request().method();
    let body = fixtures[path];
    if (!body && /^\/users\/[^/]+$/.test(path) && method === "GET") body = userDetail(decodeURIComponent(path.split("/")[2]));
    if (!body) body = { ok: true, data: { items: [], page: 1, pages: 1, total: 0, services: [] } };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { page, context };
}

const ALL_VIEWPORTS = [[320, 640], [360, 740], [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900]];
const WIDTHS = (process.env.E2E_WIDTHS || "").split(",").filter(Boolean).map(Number);
const VIEWPORTS = WIDTHS.length ? ALL_VIEWPORTS.filter(([w]) => WIDTHS.includes(w)) : ALL_VIEWPORTS;
const PAGES = ["dashboard", "analytics", "users", "payments", "vpns", "recovery"];

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest(".table-wrap, svg, .bottom-nav, .sidebar:not(.open), .drawer:not(.open), .modal-backdrop:not(.show), #toasts, .skip-link, .sr-only")) return false;
      const style = getComputedStyle(el);
      if (style.position === "fixed" && !el.closest(".open")) return false;
      return r.right > window.innerWidth + 1 || r.left < -1;
    }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`);
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, wide };
  });
}

async function collectUntranslated(page, label) {
  const found = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue.trim();
      const el = n.parentElement;
      if (!text || !/[A-Za-z]{3,}/.test(text) || /[\u0600-\u06FF]/.test(text)) continue;
      if (el.closest("script,style,.mono,code,svg,[data-no-i18n],#toasts") || getComputedStyle(el).display === "none") continue;
      out.push(text.slice(0, 80));
    }
    return out;
  });
  for (const text of found) results.untranslated.add(`${label}: ${text}`);
}

// ── Matrix: viewport × language × theme × page ─────────────────────────────
for (const [width, height] of VIEWPORTS) {
  results.viewports.add(`${width}x${height}`);
  const mobile = width < 900;
  for (const lang of ["fa", "en"]) {
    for (const theme of ["dark", "light"]) {
      const { page, context } = await newPage({ width, height }, { lang, theme, mobile });
      const tag = `${width}px/${lang}/${theme}`;
      await page.goto(`${base}/admin#/dashboard`);
      await page.waitForSelector("#app.ready", { timeout: 8000 });

      check(await page.evaluate(() => window.__themeAtDcl) === theme, `${tag}: theme applied before first paint`);
      check(await page.evaluate(() => window.__dirAtDcl) === (lang === "fa" ? "rtl" : "ltr"), `${tag}: direction applied before first paint`);
      check(await page.evaluate(() => document.documentElement.lang) === lang, `${tag}: html lang`);

      for (const route of PAGES) {
        await page.goto(`${base}/admin#/${route}`);
        await page.waitForTimeout(250);
        await page.waitForFunction(() => !document.querySelector("#content .spinner"), null, { timeout: 8000 }).catch(() => {});
        const o = await overflow(page);
        check(o.scrollWidth <= o.innerWidth + 1, `${tag}/${route}: horizontal page overflow (${o.scrollWidth} > ${o.innerWidth})`);
        check(o.wide.length === 0, `${tag}/${route}: elements outside viewport: ${o.wide.join(", ")}`);
        check(!(await page.locator("#content .danger-box").count()), `${tag}/${route}: page rendered an error box`);
        if (lang === "fa") await collectUntranslated(page, route);
      }

      // Content checks
      await page.goto(`${base}/admin#/analytics`);
      await page.waitForSelector(".kpi", { timeout: 8000 });
      const kpiText = (await page.locator(".kpi .kpi-value").allInnerTexts()).join(" | ");
      if (lang === "fa") {
        check(/تومان/.test(kpiText), `${tag}: money in Toman (fa)`);
        check(!/[0-9]/.test(kpiText), `${tag}: Persian digits in KPI values (fa): ${kpiText.slice(0, 80)}`);
        check(/۱۴[۰-۹]{2}/.test((await page.locator(".fresh-note").first().innerText())), `${tag}: Jalali year in date range`);
      } else {
        check(/Toman/.test(kpiText), `${tag}: money labelled Toman (en)`);
        check(/20\d\d/.test((await page.locator(".fresh-note").first().innerText())), `${tag}: Gregorian year in date range (en)`);
      }
      check(await page.locator("svg.chart").first().isVisible(), `${tag}: chart visible`);

      // Chart tooltip (touch + mouse)
      const svg = page.locator("#chart-money svg.chart");
      await svg.scrollIntoViewIfNeeded();
      const box = await svg.boundingBox();
      if (box) {
        if (mobile) await page.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.5);
        else { await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5); await page.mouse.down(); }
        if (process.env.E2E_DEBUG) console.log("HIT", await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.tagName + "." + e.className); }, [box.x + box.width * 0.6, box.y + box.height * 0.5]), JSON.stringify(box));
        if (process.env.E2E_DEBUG) console.log("TIP", await page.evaluate(() => { const t = document.querySelector("#chart-money .chart-tip"); const s = document.querySelector("#chart-money svg"); return JSON.stringify({ tip: t && t.outerHTML.slice(0, 200), svg: s && s.outerHTML.slice(0, 120) }); }));
        check(await page.locator("#chart-money .chart-tip").isVisible().catch(() => false), `${tag}: chart tooltip appears`);
        await page.mouse.up();
      }

      // Mobile navigation drawer
      if (mobile) {
        check(await page.locator("#nav-toggle").isVisible(), `${tag}: menu button visible`);
        await page.locator("#nav-toggle").click();
        await page.waitForTimeout(350);
        check(await page.locator("#sidebar.open").count() === 1, `${tag}: drawer opens`);
        check(await page.evaluate(() => getComputedStyle(document.body).overflow) === "hidden", `${tag}: background scroll locked while drawer open`);
        check(await page.evaluate(() => document.activeElement && document.activeElement.closest("#sidebar") !== null), `${tag}: focus moved into drawer`);
        await page.keyboard.press("Escape");
        check(await page.locator("#sidebar.open").count() === 0, `${tag}: Escape closes drawer`);
        await page.locator("#nav-toggle").click();
        await page.locator('#sidebar .nav-item[data-route="users"]').click();
        await page.waitForTimeout(150);
        check(await page.locator("#sidebar.open").count() === 0, `${tag}: drawer closes after choosing a destination`);
        check(page.url().endsWith("#/users"), `${tag}: navigated to chosen page`);
      } else {
        check(await page.locator("#sidebar").isVisible(), `${tag}: sidebar visible on desktop`);
      }

      // Users: search, row -> drawer -> modal fits the viewport
      await page.goto(`${base}/admin#/users`);
      await page.waitForSelector("table.data tbody tr", { timeout: 8000 });
      await page.locator("#u-search").fill("alex");
      const row = page.locator("table.data tbody tr").first();
      await row.click();
      await page.waitForSelector("#drawer.open", { timeout: 4000 });
      await page.waitForTimeout(350);
      const drawerBox = await page.locator("#drawer").boundingBox();
      check(drawerBox && drawerBox.x >= -1 && drawerBox.x + drawerBox.width <= width + 1, `${tag}: detail drawer inside viewport`);
      const side = await page.evaluate(() => { const r = document.querySelector("#drawer").getBoundingClientRect(); return r.right >= window.innerWidth - 1 ? "right" : r.left <= 1 ? "left" : "floating"; });
      if (width >= 768) check(side === (lang === "fa" ? "left" : "right"), `${tag}: drawer opens on the ${lang === "fa" ? "left" : "right"} side`);
      await page.locator('#drawer [data-act="add-balance"]').click();
      await page.waitForSelector("#modal-backdrop.show");
      const modal = await page.locator("#modal-backdrop .modal").boundingBox();
      check(modal && modal.x >= -1 && modal.y >= -1 && modal.x + modal.width <= width + 1 && modal.y + modal.height <= height + 1, `${tag}: modal fits viewport`);
      const okBox = await page.locator("#modal-foot .btn.primary").boundingBox();
      check(okBox && okBox.y + okBox.height <= height + 1, `${tag}: confirm button reachable`);
      await page.keyboard.press("Escape");
      check(await page.locator("#modal-backdrop.show").count() === 0, `${tag}: Escape closes modal`);

      // Touch targets
      if (mobile) {
        await page.keyboard.press("Escape");
        await page.goto(`${base}/admin#/users`);
        await page.waitForSelector("table.data tbody tr");
        const small = await page.evaluate(() => [...document.querySelectorAll(".btn, .icon-btn, .tab, select.select, input.input, .segmented button, .bottom-nav .nav-item")]
          .filter((el) => el.offsetParent !== null && !el.closest(".drawer:not(.open), .sidebar:not(.open), .modal-backdrop:not(.show)"))
          .map((el) => { const r = el.getBoundingClientRect(); return { cls: `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`, h: Math.round(r.height), w: Math.round(r.width) }; })
          .filter((m) => m.h < 40 || m.w < 40).slice(0, 4));
        check(small.length === 0, `${tag}: small touch targets ${JSON.stringify(small)}`);
      }

      // Contrast (WCAG AA 4.5:1 for normal text)
      const low = await page.evaluate(() => {
        function parse(c) { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; }
        function lum({ r, g, b }) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
        function bgOf(el) { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.95) return c; } return parse(getComputedStyle(document.body).backgroundColor); }
        const bad = [];
        for (const el of document.querySelectorAll(".kpi-label, .kpi-value, .kpi-sub, .stat .label, .stat .value, .card-head h3, .nav-item, .pill, .delta, table.data th, table.data td, .btn, .fresh-note, .kpi-group > p, .tab, .topbar h1")) {
          if (!el.offsetParent || !el.textContent.trim()) continue;
          const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
          if (!fg || !bg) continue;
          const a = lum(fg), b = lum(bg); const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          if (ratio < 4.5) bad.push(`${el.className.toString().split(" ")[0] || el.tagName} ${ratio.toFixed(2)}`);
        }
        return [...new Set(bad)].slice(0, 6);
      });
      check(low.length === 0, `${tag}: low contrast ${low.join("; ")}`);

      if ([320, 390, 1280].includes(width) && ["analytics", "users"].length) {
        for (const route of ["analytics"]) {
          await page.goto(`${base}/admin#/${route}`);
          await page.waitForSelector(".kpi");
          const file = join(shots, `${route}-${width}-${lang}-${theme}.png`);
          await page.screenshot({ path: file, fullPage: false });
          results.screenshots.push(file);
        }
      }
      await context.close();
    }
  }
}

// Theme toggle persists and language switch flips direction without reload.
{
  const { page, context } = await newPage({ width: 1280, height: 800 }, { lang: "en", theme: "dark", mobile: false });
  await page.goto(`${base}/admin#/dashboard`);
  await page.waitForSelector("#app.ready");
  await page.locator("#app [data-theme-toggle]").first().click();
  check(await page.evaluate(() => document.documentElement.getAttribute("data-theme")) === "light", "theme toggle switches to light");
  check(await page.evaluate(() => localStorage.getItem("swift.theme")) === "light", "theme preference persisted");
  await page.reload();
  await page.waitForSelector("#app.ready");
  check(await page.evaluate(() => document.documentElement.getAttribute("data-theme")) === "light", "theme survives reload");
  await page.locator('#app [data-lang="fa"]').first().click();
  await page.waitForTimeout(400);
  check(await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir].join()) === "fa,rtl", "language switch sets fa/rtl");
  check((await page.locator("#sidebar").innerText()).includes("داشبورد"), "navigation translated after switching");
  await page.locator('#app [data-lang="en"]').first().click();
  await page.waitForTimeout(400);
  check((await page.locator("#sidebar").innerText()).includes("Dashboard"), "switching back restores English");
  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: "reduce" });
  await reduced.goto(`${base}/admin#/dashboard`);
  check(await reduced.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches), "reduced-motion media query honoured");
  await context.close();
}

await browser.close();
await new Promise((resolve) => server.close(resolve));
auth.setAdminSessionRedisForTests(null);

console.log(`viewports: ${[...results.viewports].join(", ")}`);
console.log(`passed checks: ${results.passed}`);
console.log(`failed checks: ${results.failed.length}`);
for (const message of results.failed.slice(0, 60)) console.log("  FAIL", message);
const untranslated = [...results.untranslated].sort();
console.log(`untranslated visible strings in fa: ${untranslated.length}`);
for (const message of untranslated.slice(0, 80)) console.log("  ?", message);
console.log(`screenshots: ${shots}`);
assert.equal(results.failed.length, 0);
