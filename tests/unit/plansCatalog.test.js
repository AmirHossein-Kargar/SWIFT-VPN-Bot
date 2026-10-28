/**
 * Product catalog resolution (services/plans.js).
 *
 * The admin product collection is the source of truth for what the bot and the
 * storefront sell. These tests pin the resolution rules against an in-memory
 * model: enabled/archived/published/duration gating, the shipped-catalog
 * fallback, fail-closed purchase lookups and the idempotent seed + legacy
 * retirement. Real-Mongo coverage lives in catalogManagement.test.js.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const {
  setProductModelForTests,
  getSellablePlans,
  getSellablePlanById,
  getActiveProducts,
  getAvailableDurations,
  seedDefaultProducts,
  customerPlans,
  defaultPlans,
  isShippedPlanId,
  isProductReferencable,
  DELETE_LOCK_MS,
} = await import("../../services/plans.js");

const matchesDuration = (row, wanted) => {
  if (wanted === undefined) return true;
  if (wanted && typeof wanted === "object" && Array.isArray(wanted.$in)) return wanted.$in.includes(row.durationDays);
  return row.durationDays === wanted;
};

/** Minimal in-memory AdminProduct model implementing the operations used. */
function makeMemoryModel(rows = []) {
  const select = (query) => rows.filter((row) => {
    if (query.enabled !== undefined && row.enabled !== query.enabled) return false;
    if (query.archivedAt === null && row.archivedAt) return false;
    if (query.published && query.published.$ne === false && row.published === false) return false;
    if (!matchesDuration(row, query.durationDays)) return false;
    if (query.productId !== undefined && row.productId !== query.productId) return false;
    return true;
  });
  const sorted = (docs) => [...docs].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || String(a.productId).localeCompare(String(b.productId)));
  return {
    __rows: rows,
    find(query = {}) {
      const cursor = {
        sort() { return cursor; },
        lean() { return Promise.resolve(sorted(select(query)).map((row) => ({ ...row }))); },
        then(resolve, reject) { return this.lean().then(resolve, reject); },
      };
      return cursor;
    },
    findOne(query = {}) {
      const hit = select(query)[0];
      return { lean: () => Promise.resolve(hit ? { ...hit } : null) };
    },
    countDocuments() { return Promise.resolve(rows.length); },
    bulkWrite(operations) {
      let upsertedCount = 0;
      for (const op of operations) {
        const { filter, update } = op.updateOne;
        if (!rows.find((row) => row.productId === filter.productId)) {
          rows.push({ ...filter, ...update.$setOnInsert });
          upsertedCount++;
        }
      }
      return Promise.resolve({ upsertedCount });
    },
    updateMany(filter, update) {
      let modifiedCount = 0;
      for (const row of rows) {
        if (!filter.productId.$in.includes(row.productId) || "archivedAt" in row) continue;
        Object.assign(row, update.$set);
        row.revision = (row.revision || 0) + 1;
        modifiedCount++;
      }
      return Promise.resolve({ modifiedCount });
    },
  };
}

const failingModel = () => {
  const boom = () => Promise.reject(new Error("connection lost"));
  return {
    find() {
      const cursor = { sort() { return cursor; }, lean: boom, then(resolve, reject) { return boom().then(resolve, reject); } };
      return cursor;
    },
    findOne() { return { lean: boom }; },
    countDocuments: boom,
    bulkWrite: boom,
    updateMany: boom,
  };
};

const CATALOG = [
  { productId: "s30_10", name: "10 GB monthly", durationDays: 30, trafficGb: 10, priceToman: 25_000, enabled: true, published: true, displayOrder: 0 },
  { productId: "s30_50", name: "50 GB monthly", durationDays: 30, trafficGb: 50, priceToman: 90_000, enabled: true, published: false, displayOrder: 1 },
  { productId: "s90_50", name: "50 GB quarterly", durationDays: 90, trafficGb: 50, priceToman: 99_000, enabled: true, displayOrder: 2 },
  { productId: "odd_45", name: "45 days", durationDays: 45, trafficGb: 20, priceToman: 1, enabled: true, displayOrder: 3 },
  { productId: "off_30", name: "Disabled plan", durationDays: 30, trafficGb: 100, priceToman: 1, enabled: false, displayOrder: 4 },
  { productId: "old_30", name: "Archived plan", durationDays: 30, trafficGb: 200, priceToman: 1, enabled: true, archivedAt: new Date(), displayOrder: 5 },
];

beforeEach(() => {
  setProductModelForTests(makeMemoryModel(CATALOG.map((row) => ({ ...row }))));
});

after(() => {
  setProductModelForTests(null);
});

describe("getSellablePlans", () => {
  test("returns only enabled, non-archived products with a supported duration, in customer-safe shape", async () => {
    const plans = await getSellablePlans();
    assert.deepEqual(plans.map((plan) => plan.id), ["s30_10", "s30_50", "s90_50"]);
    for (const plan of plans) {
      assert.deepEqual(Object.keys(plan).sort(), ["days", "durationLabel", "gig", "id", "name", "price"]);
    }
  });

  test("storefront listing additionally drops unpublished products; the bot still sells them", async () => {
    assert.deepEqual((await getSellablePlans({ storefront: true })).map((plan) => plan.id), ["s30_10", "s90_50"]);
    assert.ok((await getActiveProducts({ durationDays: 30 })).some((plan) => plan.id === "s30_50"));
  });

  test("filters by duration and rejects unsupported durations", async () => {
    assert.deepEqual((await getSellablePlans({ durationDays: 30 })).map((plan) => plan.id), ["s30_10", "s30_50"]);
    assert.deepEqual(await getSellablePlans({ durationDays: 45 }), []);
  });

  test("a populated catalog with nothing sellable yields an empty menu, never the shipped prices", async () => {
    setProductModelForTests(makeMemoryModel([{ ...CATALOG[4] }]));
    assert.deepEqual(await getSellablePlans(), []);
  });

  test("an empty catalog falls back to the shipped customer catalog", async () => {
    setProductModelForTests(makeMemoryModel([]));
    assert.deepEqual((await getSellablePlans()).map((plan) => plan.id), customerPlans.map((plan) => plan.id));
  });

  test("a database failure falls back to the shipped catalog instead of emptying the shop", async () => {
    setProductModelForTests(failingModel());
    assert.equal((await getSellablePlans()).length, customerPlans.length);
  });
});

describe("getSellablePlanById (authoritative checkout lookup)", () => {
  test("resolves an enabled product with its database price", async () => {
    const plan = await getSellablePlanById("s90_50");
    assert.equal(plan.price, 99_000);
    assert.equal(plan.days, 90);
    assert.equal(plan.gig, 50);
    assert.equal(plan.name, "50 GB quarterly");
  });

  test("disabled, archived and unsupported-duration products are not purchasable", async () => {
    for (const id of ["off_30", "old_30", "odd_45"]) assert.equal(await getSellablePlanById(id), null, id);
  });

  test("unpublished products stay purchasable in the bot but not through the storefront", async () => {
    assert.equal((await getSellablePlanById("s30_50")).price, 90_000);
    assert.equal(await getSellablePlanById("s30_50", { storefront: true }), null);
  });

  test("a database row overrides the shipped price for the same id", async () => {
    const shipped = customerPlans.find((plan) => plan.id === "s30_10");
    const plan = await getSellablePlanById("s30_10");
    assert.notEqual(plan.price, shipped.price);
    assert.equal(plan.price, 25_000);
  });

  test("ids missing from the database fall back to the shipped catalog; legacy ids are not storefront-sellable", async () => {
    assert.equal((await getSellablePlanById("s365_30")).price, customerPlans.find((plan) => plan.id === "s365_30").price);
    assert.equal((await getSellablePlanById("mini")).price, 25_000);
    assert.equal(await getSellablePlanById("mini", { storefront: true }), null);
    assert.equal(await getSellablePlanById("nope_nope"), null);
  });

  test("malformed ids are rejected before any lookup", async () => {
    for (const bad of ["", "has space", "x".repeat(100), "abc/def", null, 42, "../etc/passwd"]) {
      assert.equal(await getSellablePlanById(bad), null);
    }
  });

  test("a database error propagates so a purchase never proceeds on unknown state", async () => {
    setProductModelForTests(failingModel());
    await assert.rejects(() => getSellablePlanById("s30_10"), /connection lost/);
  });
});

describe("requireDatabase (purchase authorization)", () => {
  test("without a live connection the shipped fallback serves display only; authorization throws instead", async () => {
    setProductModelForTests(null); // real model, but this process never connected to MongoDB
    assert.equal((await getSellablePlanById("s30_10")).id, "s30_10", "display lookups may use the shipped catalog");
    assert.ok((await getSellablePlans()).length > 0);
    await assert.rejects(() => getSellablePlanById("s30_10", { requireDatabase: true }), /not connected/);
    await assert.rejects(() => getSellablePlans({ durationDays: 30, requireDatabase: true }), /not connected/);
    await assert.rejects(() => isProductReferencable("s30_10", { requireDatabase: true }), /not connected/);
  });

  test("a delete lock hides a product until it expires", async () => {
    const model = makeMemoryModel([{ ...CATALOG[0], deleteLockedAt: new Date() }]);
    setProductModelForTests(model);
    assert.equal(await getSellablePlanById("s30_10"), null);
    assert.equal(await isProductReferencable("s30_10"), false);
    model.__rows[0].deleteLockedAt = new Date(Date.now() - DELETE_LOCK_MS - 1);
    assert.ok(await getSellablePlanById("s30_10"));
    assert.equal(await isProductReferencable("s30_10"), true);
  });
});

describe("getAvailableDurations (shop duration menu)", () => {
  test("lists the fixed durations that have a sellable plan, ascending", async () => {
    assert.deepEqual(await getAvailableDurations(), [30, 90]);
  });

  test("empty catalog falls back to every shipped duration", async () => {
    setProductModelForTests(makeMemoryModel([]));
    assert.deepEqual(await getAvailableDurations(), [30, 90, 180, 365]);
  });
});

describe("seedDefaultProducts (idempotent bootstrap)", () => {
  test("inserts the shipped catalog without overwriting admin edits and retires legacy rows once", async () => {
    const model = makeMemoryModel([
      { productId: "s30_10", name: "edited by admin", durationDays: 30, trafficGb: 10, priceToman: 999_999, enabled: true, displayOrder: 0 },
      { productId: "plan30_10", name: "legacy", durationDays: 30, trafficGb: 10, priceToman: 18_000, enabled: true, displayOrder: 1 },
    ]);
    setProductModelForTests(model);
    const inserted = await seedDefaultProducts();
    assert.equal(inserted, customerPlans.length - 1);
    assert.equal(model.__rows.find((row) => row.productId === "s30_10").priceToman, 999_999, "admin price edit must survive reseeding");
    const legacy = model.__rows.find((row) => row.productId === "plan30_10");
    assert.equal(legacy.enabled, false);
    assert.ok(legacy.archivedAt);

    // An admin who restores a legacy row (archivedAt: null) is not re-retired by the next boot.
    legacy.archivedAt = null;
    legacy.enabled = true;
    assert.equal(await seedDefaultProducts(), 0);
    assert.equal(legacy.enabled, true);
  });

  test("shipped ids are recognised so they are never hard-deleted", () => {
    assert.ok(isShippedPlanId("s30_10"));
    assert.ok(isShippedPlanId("plan30_10"));
    assert.ok(isShippedPlanId("mini"));
    assert.equal(isShippedPlanId("svc_abc"), false);
    assert.ok(defaultPlans.length > 0);
  });
});
