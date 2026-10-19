import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../../web/public/${file}`, import.meta.url), "utf8");

function load(file, sandbox = {}) {
  const context = { module: { exports: {} }, self: undefined, ...sandbox };
  context.self = context;
  vm.runInNewContext(read(file), context, { filename: file });
  return context;
}
const F = load("format.js").module.exports;

const i18nContext = load("i18n.js");
const I = i18nContext.module.exports;
// i18n-fa.js registers on a global SwiftI18n when present.
vm.runInNewContext(read("i18n-fa.js"), { SwiftI18n: I, SwiftFormat: F, module: { exports: {} } });
const FA = I._dictionaries.fa;

describe("money: stored Toman is displayed, never converted", () => {
  test("Persian mode: Persian digits and تومان, no division by 10", () => {
    assert.equal(F.money(50000, "fa"), "۵۰٬۰۰۰ تومان");
    assert.equal(F.money(1250000, "fa"), "۱٬۲۵۰٬۰۰۰ تومان");
    assert.equal(F.money(0, "fa"), "۰ تومان");
  });
  test("English mode: Latin digits and the Toman unit label", () => {
    assert.equal(F.money(50000, "en"), "50,000 Toman");
    assert.equal(F.money(1250000, "en"), "1,250,000 Toman");
  });
  test("missing or invalid values show a dash, never NaN or 0", () => {
    for (const bad of [null, undefined, "", "abc", NaN, Infinity]) {
      assert.equal(F.money(bad, "fa"), "—");
      assert.equal(F.number(bad, "en"), "—");
    }
  });
  test("display rounding does not alter the stored value", () => {
    const stored = 12345.6;
    assert.equal(F.money(stored, "en"), "12,346 Toman");
    assert.equal(stored, 12345.6);
  });
  test("large amounts stay exact up to the safe integer range", () => {
    assert.equal(F.money(9007199254740991, "en"), "9,007,199,254,740,991 Toman");
  });
  test("percent and compact formats follow the language", () => {
    assert.equal(F.percent(0.5, "en"), "50%");
    assert.match(F.percent(0.5, "fa"), /^۵۰٪$/);
    assert.match(F.compact(1500000, "en"), /1\.5M/);
    assert.match(F.compact(1500000, "fa"), /[۰-۹]/);
  });
});

describe("dates: Jalali in Persian mode, Gregorian in English, Tehran time", () => {
  const instant = "2026-10-20T12:00:00Z";
  test("known conversions", () => {
    assert.equal(F.date(instant, "fa"), "۱۴۰۵/۰۷/۲۸");
    assert.equal(F.date(instant, "en"), "20/10/2026");
    assert.equal(F.date("2026-03-21T12:00:00Z", "fa"), "۱۴۰۵/۰۱/۰۱");
    assert.equal(F.date("2025-03-21T12:00:00Z", "fa"), "۱۴۰۴/۰۱/۰۱");
  });
  test("the day changes at Tehran midnight (20:30 UTC), not at UTC midnight", () => {
    assert.equal(F.date("2026-10-20T20:29:00Z", "en"), "20/10/2026");
    assert.equal(F.date("2026-10-20T20:31:00Z", "en"), "21/10/2026");
    assert.match(F.dateTime("2026-10-20T20:31:00Z", "en"), /00:01/);
  });
  test("invalid dates render a dash; stored values are untouched", () => {
    assert.equal(F.date("nonsense", "fa"), "—");
    assert.equal(F.dateTime(null, "en"), "—");
    const stored = "2026-10-20T12:00:00Z";
    F.date(stored, "fa");
    assert.equal(stored, "2026-10-20T12:00:00Z");
  });
  test("axis labels and the date-input value", () => {
    assert.match(F.dayLabel(instant, "fa"), /مهر/);
    assert.match(F.dayLabel(instant, "en"), /Oct/);
    assert.equal(F.isoDay("2026-10-20T20:31:00Z"), "2026-10-21");
  });
  test("identifiers are not formatted by these helpers", () => {
    assert.equal(F.toPersianDigits("ORDER-123"), "ORDER-۱۲۳", "only the explicit digit helper converts, callers decide");
  });
});

describe("translation engine", () => {
  test("keys fall back to English; {placeholders} are interpolated", () => {
    I.setLang = I.setLang; // engine API exists without a DOM
    assert.equal(I.t("Unknown text {n}", { n: 3 }), "Unknown text 3");
  });
  test("placeholders survive translation for every entry", () => {
    for (const [key, value] of Object.entries(FA)) {
      const wanted = (key.match(/\{\w+\}/g) || []).sort().join();
      const got = (value.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(got, wanted, `placeholders of "${key}"`);
      assert.ok(value.trim().length > 0, `empty translation for "${key}"`);
    }
  });
  test("Persian values contain Persian text (or are intentional technical terms)", () => {
    const technical = new Set(["ADMINS", "Phrase / API"]);
    for (const [key, value] of Object.entries(FA)) {
      if (technical.has(key)) continue;
      assert.ok(/[؀-ۿ]/.test(value), `"${key}" -> "${value}"`);
    }
  });
});

describe("coverage of the shipped UI", () => {
  const source = read("app.js") + read("index.html");
  const nav = ["Dashboard", "Analytics", "Users", "VPN Services", "Payments", "Recovery", "Custody & Crypto", "Products", "Broadcast", "Referrals", "Audit Log", "Admins", "System", "Overview", "Manage", "Money", "Engage"];
  test("navigation, login and the analytics page are fully translated", () => {
    for (const key of nav) assert.ok(FA[key], `nav: ${key}`);
    const analyticsStrings = [...read("app.js").matchAll(/\["(?:today|7d|30d|thisMonth|prevMonth|custom)", "([^"]+)"\]/g)].map((m) => m[1]);
    assert.ok(analyticsStrings.length === 6);
    for (const key of analyticsStrings) assert.ok(FA[key], `range: ${key}`);
    const labels = [...read("app.js").matchAll(/(?:users|services|payment|payments|buyer|buyers|topups|refunds|wallet|sales)_[a-z0-9_]+: "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(labels.length >= 20);
    for (const key of labels) assert.ok(FA[key], `KPI label: ${key}`);
  });
  test("at least 85% of the user-visible strings extracted from the front end have a Persian entry", () => {
    const strings = new Set();
    for (const m of source.matchAll(/>([^<>{}$`\n]{3,}?)</g)) strings.add(m[1].trim());
    for (const m of source.matchAll(/(?:placeholder|title|aria-label)="([^"{}$]{3,})"/g)) strings.add(m[1].trim());
    const visible = [...strings].filter((s) => /^[A-Z][A-Za-z0-9 ,.'’\-—:;!?()/&%…]+$/.test(s) && s.includes(" "));
    const missing = visible.filter((s) => !I.has(s, "fa"));
    const coverage = 1 - missing.length / visible.length;
    console.log(`  localization coverage ${(coverage * 100).toFixed(1)}% of ${visible.length} extracted strings; missing sample: ${missing.slice(0, 8).join(" | ")}`);
    assert.ok(coverage >= 0.85, `coverage ${(coverage * 100).toFixed(1)}%`);
  });
});

describe("front-end structure", () => {
  const app = read("app.js");
  const css = read("styles.css");
  test("no hard-coded en-US number/date formatting is left outside the central helpers", () => {
    assert.equal(/toLocaleString\(["']en-(US|GB)/.test(app), false);
    assert.equal(/toLocaleDateString\(/.test(app), false);
  });
  test("both themes define every colour token; no page-level colours are hard-coded for one theme", () => {
    const light = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1];
    const dark = css.match(/:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)[1];
    const names = (block) => new Set([...block.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
    const lightNames = names(light);
    for (const name of names(dark)) {
      if (["--radius-sm", "--radius", "--radius-lg", "--font", "--font-fa", "--mono", "--green-soft"].includes(name)) continue;
      assert.ok(lightNames.has(name), `light theme is missing ${name}`);
    }
    assert.equal(/#(?:0B0D10|12161C|171C24|0E1218|10141A)\b/i.test(css.replace(/:root[\s\S]*?\n\}\n/g, "")), false, "dark surface colours only live in tokens");
  });
  test("RTL support relies on logical properties", () => {
    assert.equal(/(?:^|[\s;{])(?:margin|padding)-(?:left|right)\s*:/m.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), false);
    assert.match(css, /\[dir="rtl"\] \.drawer/);
  });
  test("motion is disabled for users who ask for reduced motion", () => {
    assert.match(css, /prefers-reduced-motion: reduce/);
  });
  test("the theme is applied by an external pre-paint script", () => {
    const html = read("index.html");
    assert.ok(html.indexOf("/theme-init.js") > -1 && html.indexOf("/theme-init.js") < html.indexOf("/styles.css") + 4000);
    const init = read("theme-init.js");
    assert.match(init, /prefers-color-scheme/);
    assert.match(init, /swift\.theme/);
  });
});

describe("server-supplied strings", () => {
  test("every analytics definition and note has a Persian entry", async () => {
    vm.runInNewContext(read("i18n-fa-server.js"), { SwiftI18n: I, module: { exports: {} } });
    const { DEFINITIONS } = await import("../../services/admin/analyticsReport.js");
    for (const [id, text] of Object.entries(DEFINITIONS)) assert.ok(I.has(text, "fa"), `definition ${id}`);
  });
});
