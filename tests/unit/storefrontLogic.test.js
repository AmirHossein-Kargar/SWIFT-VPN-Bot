/**
 * Pure storefront logic (storefront/lib/store.ts, format.ts): which plans are
 * shown, how the saved duration is restored, how the order-review dialog
 * reacts to server answers, and which links may be rendered. These files have
 * no imports, so Node loads the TypeScript directly.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

const store = await import("../../storefront/lib/store.ts");
const format = await import("../../storefront/lib/format.ts");

const catalog = {
  durations: [{ days: 30, title: "یک‌ماهه" }, { days: 90, title: "سه‌ماهه" }],
  plans: [
    { id: "p30-50", days: 30, gig: 50, price: 250000 },
    { id: "p30-10", days: 30, gig: 10, price: 70000 },
    { id: "p90-10", days: 90, gig: 10, price: 180000 },
    { id: "free", days: 30, gig: 0, price: 0 },
  ],
  paymentMethods: [{ id: "hooshpay", available: true }, { id: "crypto", available: false }, { id: "mystery", available: true }],
  checkout: { available: true, botUrl: "https://t.me/Swift_servicebot" },
  support: { url: null },
};

describe("duration selection", () => {
  test("restores the saved duration only while it is still sold", () => {
    assert.equal(store.pickDuration(catalog.durations, 90), 90);
    assert.equal(store.pickDuration(catalog.durations, 365), 30, "a retired duration falls back to the first");
    assert.equal(store.pickDuration(catalog.durations, null), 30);
    assert.equal(store.pickDuration(catalog.durations, undefined), 30);
    assert.equal(store.pickDuration([], 30), null, "nothing sold → no selection");
  });

  test("duration titles come from the catalog, with a computed fallback", () => {
    assert.equal(store.durationTitle(catalog, 30, (d) => `${d} d`), "یک‌ماهه");
    assert.equal(store.durationTitle(catalog, 7, (d) => `${d} d`), "7 d");
  });
});

describe("plans", () => {
  test("a duration shows only its own plans, smallest volume first, without mutating the catalog", () => {
    const before = catalog.plans.map((plan) => plan.id).join();
    assert.deepEqual(store.plansFor(catalog, 30).map((plan) => plan.id), ["free", "p30-10", "p30-50"]);
    assert.deepEqual(store.plansFor(catalog, 90).map((plan) => plan.id), ["p90-10"]);
    assert.deepEqual(store.plansFor(catalog, 365), []);
    assert.deepEqual(store.plansFor(catalog, null), []);
    assert.equal(catalog.plans.map((plan) => plan.id).join(), before);
  });

  test("price per GB is rounded and never divides by zero", () => {
    assert.equal(store.pricePerGb({ gig: 50, price: 250000 }), 5000);
    assert.equal(store.pricePerGb({ gig: 3, price: 10000 }), 3333);
    assert.equal(store.pricePerGb({ gig: 0, price: 0 }), null);
  });

  test("the lowest price per GB is highlighted only when it is a strict, comparable fact", () => {
    assert.equal(store.lowestPerGbPlanId(store.plansFor(catalog, 30)), "p30-50", "5000/GB beats 7000/GB; the free (0 GB) plan is ignored");
    assert.equal(store.lowestPerGbPlanId([{ id: "only", gig: 10, price: 70000 }]), null, "nothing to compare");
    assert.equal(store.lowestPerGbPlanId([{ id: "a", gig: 10, price: 50000 }, { id: "b", gig: 20, price: 100000 }]), null, "a tie highlights nothing");
    assert.equal(store.lowestPerGbPlanId([]), null);
  });

  test("only available, known payment methods are advertised", () => {
    assert.deepEqual(store.visiblePayMethods(catalog).map((method) => method.id), ["hooshpay"]);
    assert.deepEqual(store.visiblePayMethods({ paymentMethods: [] }), []);
  });

  test("an empty catalog is its own state", () => {
    assert.equal(store.catalogView({ plans: [] }), "empty");
    assert.equal(store.catalogView(catalog), "ready");
  });
});

describe("order review", () => {
  test("a 404 means the plan is no longer sold; anything else is retryable", () => {
    assert.equal(store.classifyPlanCheckFailure(404), "gone");
    for (const status of [undefined, 0, 429, 500, 503]) assert.equal(store.classifyPlanCheckFailure(status), "retry", String(status));
  });

  test("the hand-off link comes only from the server's answer, and only when checkout is available", () => {
    assert.equal(store.handoffUrl({ plan: catalog.plans[0], checkout: { available: true, url: "https://t.me/Swift_servicebot?start=plan_p30-50" } }), "https://t.me/Swift_servicebot?start=plan_p30-50");
    assert.equal(store.handoffUrl({ plan: catalog.plans[0], checkout: { available: false, url: "https://t.me/x" } }), null);
    assert.equal(store.handoffUrl({ plan: catalog.plans[0], checkout: { available: true, url: null } }), null);
  });

  test("links are rendered only for http(s) targets", () => {
    assert.equal(store.safeExternalUrl("https://t.me/Swift_servicebot"), "https://t.me/Swift_servicebot");
    assert.equal(store.safeExternalUrl("http://example.com/x"), null, "plain http is not a hand-off target");
    assert.equal(store.safeExternalUrl("https://user:pw@t.me/x"), null, "credentials in a URL are refused");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "not a url", "", null, undefined]) {
      assert.equal(store.safeExternalUrl(bad), null, String(bad));
    }
  });
});

describe("formatting", () => {
  test("numbers use Persian digits with grouping", () => {
    assert.match(format.fa(150000), /^[۰-۹٬,]+$/);
    assert.equal(format.fa(150000).replace(/[٬,]/g, ""), "۱۵۰۰۰۰");
    assert.equal(format.fa(0), "۰");
  });

  test("the footer year is a four-digit Persian-calendar year", () => {
    assert.match(format.currentYearLabel(new Date("2026-10-21T00:00:00Z")), /^[۰-۹]{4}$/);
    assert.equal(format.currentYearLabel(new Date("2026-10-21T00:00:00Z")), "۱۴۰۵");
  });

  test("storage helpers never throw when storage is blocked or missing", () => {
    assert.equal(format.storageGet("swift.theme"), null, "no localStorage in Node");
    assert.doesNotThrow(() => format.storageSet("swift.theme", "dark"));
  });

  test("storage keys match the external theme-init.js and the legacy page", async () => {
    const { readFileSync } = await import("node:fs");
    const init = readFileSync(new URL("../../web/public/store/theme-init.js", import.meta.url), "utf8");
    assert.ok(init.includes(`"${store.THEME_STORAGE_KEY}"`), "theme key shared with theme-init.js");
    const legacy = readFileSync(new URL("../../web/public/store/store.js", import.meta.url), "utf8");
    assert.ok(legacy.includes(`"${store.DURATION_STORAGE_KEY}"`), "duration key shared with the legacy page");
  });
});
