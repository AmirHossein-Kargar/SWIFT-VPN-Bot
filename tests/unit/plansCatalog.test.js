/**
 * Product catalog as the shop's source of truth (services/plans.js).
 *
 * The Telegram shop must sell only what the admin panel manages: enabled
 * products with database prices. These tests inject an in-memory product
 * model through the test seam and pin the money-path behaviours:
 *   - shop menus read active (enabled) products only
 *   - checkout resolves authoritative prices by product id
 *   - a populated catalog never falls back to stale hardcoded prices
 *   - duration groups are derived from the catalog
 *   - an empty/unreachable catalog falls back to the shipped catalog
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const {
  setProductModelForTests,
  getActiveProducts,
  getActiveProductById,
  getAvailableDurations,
  seedDefaultProducts,
  defaultPlans,
} = await import("../../services/plans.js");

/** Minimal in-memory AdminProduct model implementing the operations used. */
function makeMemoryModel(rows = []) {
  return {
    __rows: rows,
    find(query = {}) {
      const sort = (docs) => [...docs].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || String(a.productId).localeCompare(String(b.productId)));
      const matches = () => sort(rows.filter((row) => {
        if (query.enabled !== undefined && row.enabled !== query.enabled) return false;
        if (query.durationDays !== undefined && row.durationDays !== query.durationDays) return false;
        if (query.productId !== undefined && row.productId !== query.productId) return false;
        return true;
      }));
      const cursor = {
        sort() { return cursor; },
        lean() { return Promise.resolve(matches().map((row) => ({ ...row }))); },
        then(resolve, reject) { return this.lean().then(resolve, reject); },
      };
      return cursor;
    },
    findOne(query = {}) {
      const hit = rows.find((row) => {
        if (query.enabled !== undefined && row.enabled !== query.enabled) return false;
        if (query.productId !== undefined && row.productId !== query.productId) return false;
        return true;
      });
      // Mongoose-style Query: chainable .lean() returning a thenable.
      const query2 = {
        lean() { return Promise.resolve(hit ? { ...hit } : null); },
        then(resolve, reject) { return this.lean().then(resolve, reject); },
      };
      return query2;
    },
    countDocuments() { return Promise.resolve(rows.length); },
    bulkWrite(operations) {
      let upsertedCount = 0;
      for (const op of operations) {
        const { filter, update } = op.updateOne;
        const existing = rows.find((row) => row.productId === filter.productId);
        if (!existing) {
          rows.push({ ...filter, ...update.$setOnInsert });
          upsertedCount++;
        }
      }
      return Promise.resolve({ upsertedCount });
    },
  };
}

const CATALOG = [
  { productId: "plan30_10", name: "🔹 10 گیگ - 30 روزه", durationDays: 30, trafficGb: 10, priceToman: 18000, enabled: true, displayOrder: 0 },
  { productId: "plan30_50", name: "🔹 50 گیگ - 30 روزه", durationDays: 30, trafficGb: 50, priceToman: 42000, enabled: true, displayOrder: 1 },
  { productId: "plan60_50", name: "🔸 50 گیگ - 60 روزه", durationDays: 60, trafficGb: 50, priceToman: 54000, enabled: true, displayOrder: 2 },
  { productId: "plan120_50", name: "💎 50 گیگ - 120 روزه", durationDays: 120, trafficGb: 50, priceToman: 99000, enabled: true, displayOrder: 3 },
  { productId: "plan30_off", name: "Disabled plan", durationDays: 30, trafficGb: 100, priceToman: 1, enabled: false, displayOrder: 4 },
];

beforeEach(() => {
  setProductModelForTests(makeMemoryModel(CATALOG.map((row) => ({ ...row }))));
});

after(() => {
  setProductModelForTests(null);
});

describe("getActiveProducts", () => {
  test("returns ONLY enabled catalog products with normalized plan fields", async () => {
    const products = await getActiveProducts();
    assert.ok(products.every((plan) => typeof plan.id === "string" && typeof plan.price === "number"));
    assert.equal(products.some((plan) => plan.id === "plan30_off"), false, "disabled product must not be sold");
    assert.equal(products.length, 4);
  });

  test("filters by duration days", async () => {
    const thirty = await getActiveProducts({ durationDays: 30 });
    assert.equal(thirty.length, 2);
    assert.ok(thirty.every((plan) => plan.days === 30));
  });

  test("empty catalog falls back to the shipped catalog", async () => {
    setProductModelForTests(makeMemoryModel([]));
    const products = await getActiveProducts();
    assert.equal(products.length, defaultPlans.length);
    assert.deepEqual(products.map((p) => p.id), defaultPlans.map((p) => p.id));
  });

  test("database failure falls back instead of emptying the shop", async () => {
    setProductModelForTests({
      find() {
        const cursor = {
          sort() { return cursor; },
          lean() { return Promise.reject(new Error("connection lost")); },
          then(resolve, reject) { return this.lean().then(resolve, reject); },
        };
        return cursor;
      },
      findOne() {
        return { lean: () => Promise.reject(new Error("connection lost")) };
      },
      countDocuments() { return Promise.reject(new Error("connection lost")); },
      bulkWrite() { return Promise.reject(new Error("connection lost")); },
    });
    const products = await getActiveProducts();
    assert.equal(products.length, defaultPlans.length);
    const byId = await getActiveProductById("plan30_10");
    assert.equal(byId.id, "plan30_10");
    assert.deepEqual(await getAvailableDurations(), [30, 60, 90]);
  });
});

describe("getActiveProductById (authoritative checkout price)", () => {
  test("resolves an enabled product with its database price", async () => {
    const plan = await getActiveProductById("plan60_50");
    assert.deepEqual(plan, { id: "plan60_50", name: "🔸 50 گیگ - 60 روزه", days: 60, gig: 50, price: 54000 });
  });

  test("a populated catalog returns null for disabled/unknown products — never a stale hardcoded price", async () => {
    assert.equal(await getActiveProductById("plan30_off"), null);
    assert.equal(await getActiveProductById("plan30_100"), null); // exists in shipped catalog only
    assert.equal(await getActiveProductById("nope_nope"), null);
  });

  test("malformed ids are rejected before any lookup", async () => {
    for (const bad of ["", "has space", "x".repeat(100), "abc/def", null, 42, "../etc/passwd"]) {
      assert.equal(await getActiveProductById(bad), null);
    }
  });

  test("empty catalog keeps backward compatibility with shipped plan ids", async () => {
    setProductModelForTests(makeMemoryModel([]));
    const plan = await getActiveProductById("plan30_10");
    assert.equal(plan.id, "plan30_10");
    assert.equal(plan.price, 18000);
  });
});

describe("getAvailableDurations (shop duration menu)", () => {
  test("derives distinct durations from the ACTIVE catalog, sorted ascending", async () => {
    const durations = await getAvailableDurations();
    assert.deepEqual(durations, [30, 60, 120]);
  });

  test("a new admin-created duration appears automatically", async () => {
    const model = makeMemoryModel(CATALOG.map((row) => ({ ...row })));
    model.__rows.push({ productId: "plan200_50", name: "200 روزه", durationDays: 200, trafficGb: 50, priceToman: 150000, enabled: true, displayOrder: 9 });
    setProductModelForTests(model);
    const durations = await getAvailableDurations();
    assert.deepEqual(durations, [30, 60, 120, 200]);
  });

  test("disabled-only durations disappear from the menu", async () => {
    const model = makeMemoryModel([{ productId: "p30", name: "p", durationDays: 30, trafficGb: 10, priceToman: 1000, enabled: false, displayOrder: 0 }]);
    setProductModelForTests(model);
    // The only duration (30) exists in the catalog but is disabled, so the
    // active set is empty → shipped default groups apply.
    assert.deepEqual(await getAvailableDurations(), [30, 60, 90]);
  });

  test("empty catalog falls back to the shipped 30/60/90 groups", async () => {
    setProductModelForTests(makeMemoryModel([]));
    assert.deepEqual(await getAvailableDurations(), [30, 60, 90]);
  });
});

describe("seedDefaultProducts (idempotent bootstrap)", () => {
  test("inserts missing shipped products without overwriting admin edits", async () => {
    const model = makeMemoryModel([
      { productId: "plan30_10", name: "ادیت‌شده توسط مدیر", durationDays: 30, trafficGb: 10, priceToman: 999999, enabled: true, displayOrder: 0 },
    ]);
    setProductModelForTests(model);
    const inserted = await seedDefaultProducts();
    assert.equal(inserted, defaultPlans.length - 1);
    const edited = model.__rows.find((row) => row.productId === "plan30_10");
    assert.equal(edited.priceToman, 999999, "admin price edit must survive reseeding");
    assert.equal(model.__rows.length, defaultPlans.length);
  });
});
