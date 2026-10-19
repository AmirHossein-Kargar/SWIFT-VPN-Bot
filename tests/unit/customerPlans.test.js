import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  customerPlans,
  getCustomerPlanById,
  getCustomerPlans,
  getCustomerPlanByDurationAndVolume,
  getCustomerDurations,
  getSubscriptionDurations,
  getSubscriptionDurationOptions,
  getInternalPlanCatalog,
  getInternalPlanById,
  getInternalPlanByDurationAndVolume,
  calculatePlanProfit,
} from "../../services/plans.js";

const EXPECTED_INTERNAL_CATALOG = [
  // 30-Day Plans: [id, days, gig, purchaseCost, sellingPrice, profit]
  ["s30_10", 30, 10, 13_000, 20_000, 7_000],
  ["s30_30", 30, 30, 33_000, 50_000, 17_000],
  ["s30_50", 30, 50, 53_000, 80_000, 27_000],
  ["s30_100", 30, 100, 103_000, 155_000, 52_000],
  ["s30_200", 30, 200, 203_000, 305_000, 102_000],
  ["s30_300", 30, 300, 303_000, 455_000, 152_000],
  ["s30_500", 30, 500, 503_000, 755_000, 252_000],

  // 90-Day Plans
  ["s90_30", 90, 30, 39_000, 59_000, 20_000],
  ["s90_50", 90, 50, 59_000, 89_000, 30_000],
  ["s90_100", 90, 100, 109_000, 164_000, 55_000],
  ["s90_200", 90, 200, 209_000, 314_000, 105_000],
  ["s90_300", 90, 300, 309_000, 464_000, 155_000],
  ["s90_500", 90, 500, 509_000, 764_000, 255_000],

  // 180-Day Plans
  ["s180_30", 180, 30, 48_000, 72_000, 24_000],
  ["s180_50", 180, 50, 68_000, 102_000, 34_000],
  ["s180_100", 180, 100, 118_000, 177_000, 59_000],
  ["s180_200", 180, 200, 218_000, 327_000, 109_000],
  ["s180_300", 180, 300, 318_000, 477_000, 159_000],
  ["s180_500", 180, 500, 518_000, 777_000, 259_000],

  // 365-Day Plans
  ["s365_30", 365, 30, 66_500, 100_000, 33_500],
  ["s365_50", 365, 50, 86_500, 130_000, 43_500],
  ["s365_100", 365, 100, 136_500, 205_000, 68_500],
  ["s365_200", 365, 200, 236_500, 355_000, 118_500],
  ["s365_300", 365, 300, 336_500, 505_000, 168_500],
  ["s365_500", 365, 500, 536_500, 805_000, 268_500],
];

describe("server-side customer selling plans", () => {
  test("internal catalog exactly matches the approved duration, volume, purchaseCost, sellingPrice, and profit", () => {
    const internal = getInternalPlanCatalog();
    assert.equal(internal.length, 25);
    assert.deepEqual(
      internal.map(({ id, days, gig, purchaseCost, sellingPrice, profit }) => [
        id, days, gig, purchaseCost, sellingPrice, profit,
      ]),
      EXPECTED_INTERNAL_CATALOG,
    );

    for (const plan of internal) {
      assert.equal(plan.price, plan.sellingPrice);
      assert.equal(plan.profit, calculatePlanProfit(plan.sellingPrice, plan.purchaseCost));
      assert.equal(plan.profit, plan.sellingPrice - plan.purchaseCost);
      assert.deepEqual(getInternalPlanById(plan.id), plan);
      assert.deepEqual(getInternalPlanByDurationAndVolume(plan.days, plan.gig), plan);
    }
  });

  test("customer-facing catalog and resolvers never expose internal purchaseCost or profit", () => {
    assert.equal(customerPlans.length, 25);
    assert.deepEqual(
      customerPlans.map(({ id, days, gig, price }) => [id, days, gig, price]),
      EXPECTED_INTERNAL_CATALOG.map(([id, days, gig, , sellingPrice]) => [id, days, gig, sellingPrice]),
    );

    const forbiddenKeys = ["purchaseCost", "cost", "costToman", "profit", "margin", "sellingPrice"];
    for (const plan of customerPlans) {
      for (const key of forbiddenKeys) {
        assert.equal(Object.hasOwn(plan, key), false, `customer plan must not expose ${key}`);
      }
      const byId = getCustomerPlanById(plan.id);
      const byPair = getCustomerPlanByDurationAndVolume(plan.days, plan.gig);
      for (const key of forbiddenKeys) {
        assert.equal(Object.hasOwn(byId, key), false);
        assert.equal(Object.hasOwn(byPair, key), false);
      }
    }
  });

  test("resolves only known plan IDs (including legacy orders) and returns isolated copies", () => {
    const mini = getCustomerPlanById("mini");
    assert.deepEqual(mini, { id: "mini", name: "Mini", days: 7, gig: 5, price: 25_000 });
    mini.price = 1;
    mini.gig = 100;
    assert.equal(getCustomerPlanById("mini").price, 25_000);
    assert.equal(getCustomerPlanById("mini").gig, 5);

    const s90 = getCustomerPlanById("s90_100");
    assert.equal(s90.days, 90);
    assert.equal(s90.gig, 100);
    assert.equal(s90.price, 164_000);
    s90.price = 1;
    assert.equal(getCustomerPlanById("s90_100").price, 164_000);

    // 10 GB is only offered for 30 days, not 90/180/365 days
    assert.equal(getCustomerPlanByDurationAndVolume(30, 10)?.price, 20_000);
    assert.equal(getCustomerPlanByDurationAndVolume(90, 10), null);
    assert.equal(getCustomerPlanByDurationAndVolume(180, 10), null);
    assert.equal(getCustomerPlanByDurationAndVolume(365, 10), null);

    for (const invalid of ["", "old_admin_product", "plan30_10", "s90_10", "max+", "../test", "test;price=1", 1, null, {}]) {
      assert.equal(getCustomerPlanById(invalid), null);
    }
  });

  test("exposes the four subscription durations (30, 90, 180, 365 days) with exact Persian labels and matching plans", () => {
    assert.deepEqual(getCustomerDurations(), [30, 90, 180, 365]);
    assert.deepEqual(getSubscriptionDurations(), [30, 90, 180, 365]);

    const options = getSubscriptionDurationOptions();
    assert.deepEqual(
      options.map(({ days, months, title, label }) => [days, months, title, label]),
      [
        [30, 1, "یک‌ماهه", "🗓️ یک‌ماهه"],
        [90, 3, "سه‌ماهه", "🗓️ سه‌ماهه"],
        [180, 6, "شش‌ماهه", "🗓️ شش‌ماهه"],
        [365, 12, "یک‌ساله", "🗓️ یک‌ساله"],
      ],
    );

    assert.deepEqual(
      getCustomerPlans({ durationDays: 30 }).map((p) => [p.id, p.gig, p.price]),
      [
        ["s30_10", 10, 20_000],
        ["s30_30", 30, 50_000],
        ["s30_50", 50, 80_000],
        ["s30_100", 100, 155_000],
        ["s30_200", 200, 305_000],
        ["s30_300", 300, 455_000],
        ["s30_500", 500, 755_000],
      ],
    );

    assert.deepEqual(
      getCustomerPlans({ durationDays: 90 }).map((p) => [p.id, p.gig, p.price]),
      [
        ["s90_30", 30, 59_000],
        ["s90_50", 50, 89_000],
        ["s90_100", 100, 164_000],
        ["s90_200", 200, 314_000],
        ["s90_300", 300, 464_000],
        ["s90_500", 500, 764_000],
      ],
    );

    assert.deepEqual(
      getCustomerPlans({ durationDays: 180 }).map((p) => [p.id, p.gig, p.price]),
      [
        ["s180_30", 30, 72_000],
        ["s180_50", 50, 102_000],
        ["s180_100", 100, 177_000],
        ["s180_200", 200, 327_000],
        ["s180_300", 300, 477_000],
        ["s180_500", 500, 777_000],
      ],
    );

    assert.deepEqual(
      getCustomerPlans({ durationDays: 365 }).map((p) => [p.id, p.gig, p.price]),
      [
        ["s365_30", 30, 100_000],
        ["s365_50", 50, 130_000],
        ["s365_100", 100, 205_000],
        ["s365_200", 200, 355_000],
        ["s365_300", 300, 505_000],
        ["s365_500", 500, 805_000],
      ],
    );

    // Legacy duration lookup still resolves for backward compatibility
    assert.deepEqual(getCustomerPlans({ durationDays: 7 }).map((plan) => plan.id), ["mini"]);

    for (const unsupported of [45, 60, 120, 0, -30]) {
      assert.deepEqual(getCustomerPlans({ durationDays: unsupported }), []);
    }
  });
});
