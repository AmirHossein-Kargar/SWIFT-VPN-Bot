import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { customerPlans, getCustomerPlanById, getCustomerPlans, getCustomerDurations } from "../../services/plans.js";

const EXPECTED = [
  ["test", 1, 1, 1_000],
  ["mini", 7, 5, 25_000],
  ["basic", 15, 10, 45_000],
  ["standard", 30, 20, 79_000],
  ["plus", 30, 30, 109_000],
  ["pro", 30, 50, 169_000],
  ["premium", 30, 75, 229_000],
  ["ultra", 30, 100, 279_000],
  ["max", 30, 150, 389_000],
  ["max_plus", 30, 200, 499_000],
];

describe("server-side customer selling plans", () => {
  test("central catalog exactly matches the approved customer prices and service limits", () => {
    assert.deepEqual(
      customerPlans.map(({ id, days, gig, price }) => [id, days, gig, price]),
      EXPECTED,
    );
    assert.equal(customerPlans.length, 10);
    assert.ok(customerPlans.every((plan) => Number.isSafeInteger(plan.price) && plan.price > 0));
    assert.ok(customerPlans.every((plan) => Number.isSafeInteger(plan.days) && plan.days > 0));
    assert.ok(customerPlans.every((plan) => Number.isSafeInteger(plan.gig) && plan.gig > 0));
    assert.ok(customerPlans.every((plan) => !/unlimited|نامحدود/i.test(plan.name)));
  });

  test("resolves only known plan IDs and returns isolated copies", () => {
    const mini = getCustomerPlanById("mini");
    assert.deepEqual(mini, { id: "mini", name: "Mini", days: 7, gig: 5, price: 25_000 });
    mini.price = 1;
    mini.gig = 100;
    assert.equal(getCustomerPlanById("mini").price, 25_000);
    assert.equal(getCustomerPlanById("mini").gig, 5);

    for (const invalid of ["", "old_admin_product", "max+", "../test", "test;price=1", 1, null, {}]) {
      assert.equal(getCustomerPlanById(invalid), null);
    }
  });

  test("returns only configured duration groups and matching plans", () => {
    assert.deepEqual(getCustomerDurations(), [1, 7, 15, 30]);
    assert.deepEqual(getCustomerPlans({ durationDays: 30 }).map((plan) => plan.id), [
      "standard", "plus", "pro", "premium", "ultra", "max", "max_plus",
    ]);
    assert.deepEqual(getCustomerPlans({ durationDays: 7 }).map((plan) => plan.id), ["mini"]);
  });
});
