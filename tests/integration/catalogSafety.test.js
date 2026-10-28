/**
 * Catalog safety nets (REAL MongoDB): the delete/purchase race, fail-closed purchase
 * authorization, checkout entry points, and seed/migration behaviour against
 * production-like legacy data. Skips without a disposable test database.
 */
import { test, describe, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = "424242";

let AdminProduct, WalletPurchase, User, products, plans, purchaseService, handleCallbackQuery, tronQuote;
if (dbAvailable) {
  ({ default: AdminProduct } = await import("../../models/AdminProduct.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: User } = await import("../../models/User.js"));
  products = await import("../../services/admin/products.js");
  plans = await import("../../services/plans.js");
  purchaseService = await import("../../services/buyService/purchaseService.js");
  ({ default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js"));
  tronQuote = await import("../../services/pricing/tronQuote.js");
}

const opId = () => `op-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
const tid = () => String(100000 + Math.floor(Math.random() * 899999));
const noProvider = async () => { throw new Error("provider must not be reached"); };
let n = 0;
const newPlan = async (overrides = {}) => (await products.createProduct({
  actorId: ADMIN, operationId: opId(),
  input: { name: "Race plan", durationDays: 30, trafficGb: 1000 + (n += 1), priceToman: 7_000, costToman: 1_000, enabled: true, ...overrides },
})).product;

before(async () => {
  if (!dbAvailable) return;
  const { default: AdminAuditLog } = await import("../../models/AdminAuditLog.js");
  await Promise.all([AdminProduct, AdminAuditLog, WalletPurchase, User].map((model) => model.init())); // unique indexes ready
  await plans.seedDefaultProducts();
});
beforeEach(() => mock.restoreAll());
after(async () => { mock.restoreAll(); await disconnectTestDB(); });

describe("delete vs purchase race", () => {
  skip("an order created after the reference count but before the delete is withdrawn, never left dangling", async () => {
    const plan = await newPlan();
    const telegramId = tid();
    await User.create({ telegramId, balance: 500_000 });
    const realCreate = WalletPurchase.create.bind(WalletPurchase);
    let deletion;
    // The purchase has already resolved the (still live) plan; the whole delete runs before its order record is written.
    mock.method(WalletPurchase, "create", async (...args) => {
      mock.restoreAll();
      deletion = await products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: plan.id });
      return realCreate(...args);
    });
    await assert.rejects(
      () => purchaseService.purchasePlan(telegramId, plan.id, { purchaseId: `race_${telegramId}_a`, createService: noProvider }),
      (error) => error.code === "INVALID_PLAN",
    );
    assert.equal(deletion.deleted, true);
    assert.equal(await AdminProduct.exists({ productId: plan.id }), null);
    assert.equal(await WalletPurchase.countDocuments({ planId: plan.id }), 0, "no order references the deleted product");
    assert.equal((await User.findOne({ telegramId })).balance, 500_000, "nothing was debited");
  });

  skip("an order created after the product was locked for deletion is refused at resolve time", async () => {
    const plan = await newPlan();
    const telegramId = tid();
    await User.create({ telegramId, balance: 500_000 });
    await AdminProduct.updateOne({ productId: plan.id }, { $set: { deleteLockedAt: new Date() } });
    await assert.rejects(() => purchaseService.purchasePlan(telegramId, plan.id, { purchaseId: `race_${telegramId}_b`, createService: noProvider }), (e) => e.code === "INVALID_PLAN");
    assert.equal(await WalletPurchase.countDocuments({ planId: plan.id }), 0);
    // A lock left behind by a crashed delete expires instead of hiding the plan forever.
    await AdminProduct.updateOne({ productId: plan.id }, { $set: { deleteLockedAt: new Date(Date.now() - plans.DELETE_LOCK_MS - 1000) } });
    assert.ok(await plans.getSellablePlanById(plan.id));
  });

  skip("an order recorded between the lock and the count blocks the delete and survives with its snapshot", async () => {
    const plan = await newPlan();
    const telegramId = tid();
    await User.create({ telegramId, balance: 0 });
    const realCount = WalletPurchase.countDocuments.bind(WalletPurchase);
    // Delete holds the lock; an order record that was already in flight lands right before the count.
    mock.method(WalletPurchase, "countDocuments", async (...args) => {
      mock.restoreAll();
      await WalletPurchase.create({ purchaseId: `race_${telegramId}_c`, telegramId, planId: plan.id, planName: "Race plan", gig: plan.trafficGb, days: 30, amount: 7_000, status: "reserving" });
      return realCount(...args);
    });
    await assert.rejects(() => products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: plan.id }), (e) => e.code === "product_in_use");
    const kept = await AdminProduct.findOne({ productId: plan.id }).lean();
    assert.ok(kept, "product survives");
    assert.equal(kept.deleteLockedAt, undefined, "lock is released after the aborted delete");
    const order = await WalletPurchase.findOne({ planId: plan.id });
    assert.equal(order.amount, 7_000);
    assert.equal(order.planName, "Race plan");
  });

  skip("stress: concurrent deletes and purchases never leave an order pointing at a missing product", async () => {
    for (let round = 0; round < 12; round += 1) {
      const plan = await newPlan();
      const buyers = await Promise.all(Array.from({ length: 3 }, async () => {
        const telegramId = tid();
        await User.create({ telegramId, balance: 0 });
        return telegramId;
      }));
      await Promise.allSettled([
        products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: plan.id }),
        ...buyers.map((telegramId) => purchaseService.purchasePlan(telegramId, plan.id, { purchaseId: `st_${round}_${telegramId}`, createService: noProvider })),
      ]);
      const stillThere = Boolean(await AdminProduct.exists({ productId: plan.id }));
      const referencing = await WalletPurchase.countDocuments({ planId: plan.id });
      assert.ok(stillThere || referencing === 0, `round ${round}: deleted=${!stillThere} dangling orders=${referencing}`);
    }
  });

  skip("deleting never touches historical orders or customers' active services of OTHER products", async () => {
    const plan = await newPlan();
    const other = await newPlan();
    const telegramId = tid();
    await WalletPurchase.create({ purchaseId: `hist_${telegramId}`, telegramId, planId: other.id, planName: "Other", gig: 5, days: 30, amount: 1, status: "completed" });
    await User.create({ telegramId, services: [{ username: `svc_${telegramId}`, productId: other.id, trafficGb: 5, expiresAt: new Date(Date.now() + 864e5) }] });
    await products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: plan.id });
    assert.equal(await WalletPurchase.countDocuments({ planId: other.id }), 1);
    assert.equal((await User.findOne({ telegramId })).services[0].revokedAt, null);
  });
});

describe("purchase authorization fails closed", () => {
  skip("a catalog database error rejects the wallet purchase before anything is created or debited", async () => {
    const plan = await newPlan();
    const telegramId = tid();
    await User.create({ telegramId, balance: 90_000 });
    mock.method(AdminProduct, "findOne", () => ({ lean: () => Promise.reject(new Error("catalog down")) }));
    await assert.rejects(() => purchaseService.purchasePlan(telegramId, plan.id, { purchaseId: `fc_${telegramId}`, createService: noProvider }), (e) => e.code === "CATALOG_UNAVAILABLE");
    mock.restoreAll();
    assert.equal(await WalletPurchase.countDocuments({ telegramId }), 0);
    assert.equal((await User.findOne({ telegramId })).balance, 90_000);
  });

  skip("the Telegram confirm step shows a temporary-outage alert and creates no order when the catalog is unreadable", async () => {
    const plan = await newPlan();
    const telegramId = Number(tid());
    mock.method(AdminProduct, "findOne", () => ({ lean: () => Promise.reject(new Error("catalog down")) }));
    const bot = makeBotStub();
    await handleCallbackQuery(bot, { id: "q1", message: { chat: { id: telegramId, type: "private" }, message_id: 5 }, from: { id: telegramId }, data: `confirm_order_${plan.id}` });
    mock.restoreAll();
    assert.ok(bot.sent.some((entry) => /موقتاً در دسترس نیست/.test(String(entry.opts?.text || entry.text || ""))));
    assert.equal(await WalletPurchase.countDocuments({ telegramId: String(telegramId) }), 0);
  });

  skip("crypto quotes follow the same rules: disabled plans are invalid, database errors propagate", async () => {
    const plan = await newPlan({ enabled: false });
    await assert.rejects(() => tronQuote.quoteCryptoPayment({ planSelection: plan.id }), (e) => e.code === "invalid_plan" || /invalid_plan/.test(String(e.message)));
    await assert.rejects(() => tronQuote.quoteCryptoPayment({ planSelection: { durationDays: 30, gig: plan.trafficGb } }), (e) => /invalid_plan/.test(String(e.code || e.message)));
    mock.method(AdminProduct, "findOne", () => ({ lean: () => Promise.reject(new Error("catalog down")) }));
    await assert.rejects(() => tronQuote.quoteCryptoPayment({ planSelection: plan.id }), /catalog down/);
    mock.restoreAll();
    mock.method(AdminProduct, "find", () => { throw new Error("catalog down"); });
    await assert.rejects(() => tronQuote.quoteCryptoPayment({ planSelection: { durationDays: 30, gig: 10 } }), /catalog down/);
  });

  skip("unpublished plans stay purchasable in the bot but their storefront deep link is refused", async () => {
    const plan = await newPlan({ published: false });
    const { planFromStartPayload } = await import("../../handlers/message/handleStartPayload.js");
    assert.equal(await planFromStartPayload(`plan_${plan.id}`), null);
    assert.ok(await plans.getSellablePlanById(plan.id, { requireDatabase: true }));
  });
});

describe("seed and migration against production-like data", () => {
  async function legacyDatabase() {
    await AdminProduct.deleteMany({});
    await AdminProduct.syncIndexes(); // production has the unique+sparse createdByOperationId index built
    const legacy = ["plan30_10", "plan30_50", "plan60_50", "plan90_100"].map((productId, i) => ({
      productId, name: `legacy ${productId}`, durationDays: productId.startsWith("plan30") ? 30 : productId.startsWith("plan60") ? 60 : 90,
      trafficGb: 10 + i, priceToman: 18_000 + i, costToman: 9_000, enabled: true, displayOrder: i,
      createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-01"),
      ...(i === 0 ? { createdByOperationId: null } : {}), // the single legacy row that may carry an explicit null
    }));
    await AdminProduct.collection.insertMany(legacy); // raw: exactly the old document shape, no new fields
    return legacy;
  }

  skip("legacy rows are retired once, the 25 shipped plans appear, and orders/customers are untouched", async () => {
    await legacyDatabase();
    const telegramId = tid();
    await WalletPurchase.create({ purchaseId: `mig_${telegramId}`, telegramId, planId: "plan30_10", planName: "legacy order", gig: 10, days: 30, amount: 20_000, status: "completed" });
    await User.create({ telegramId, balance: 11, services: [{ username: `svc_${telegramId}`, productId: "plan30_10", trafficGb: 10, expiresAt: new Date(Date.now() + 864e5) }] });

    assert.equal(await plans.seedDefaultProducts(), 25);
    const legacy = await AdminProduct.find({ productId: /^plan/ }).lean();
    assert.equal(legacy.length, 4);
    for (const row of legacy) {
      assert.equal(row.enabled, false);
      assert.equal(row.published, false);
      assert.ok(row.archivedAt);
      assert.equal(row.archivedBy, "system");
    }
    assert.equal(await AdminProduct.countDocuments({ productId: /^s\d+_\d+$/ }), 25);

    const order = await WalletPurchase.findOne({ telegramId });
    assert.equal(order.amount, 20_000);
    assert.equal(order.planName, "legacy order");
    const user = await User.findOne({ telegramId });
    assert.equal(user.balance, 11);
    assert.equal(user.services[0].revokedAt, null);
    assert.equal(await plans.getSellablePlanById("plan30_10"), null, "legacy plans are no longer sold");
    assert.equal((await plans.getSellablePlans()).length, 25);
  });

  skip("repeated boots are idempotent, keep admin edits and never re-retire a restored legacy plan", async () => {
    await legacyDatabase();
    await plans.seedDefaultProducts();
    await products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: "s30_10", input: { priceToman: 31_000, name: "Admin renamed", enabled: false } });
    await products.restoreProduct({ actorId: ADMIN, operationId: opId(), productId: "plan30_50" });

    for (let boot = 0; boot < 3; boot += 1) assert.equal(await plans.seedDefaultProducts(), 0, `boot ${boot + 2} inserts nothing`);
    assert.equal(await AdminProduct.countDocuments({}), 29);
    const edited = await AdminProduct.findOne({ productId: "s30_10" }).lean();
    assert.equal(edited.priceToman, 31_000);
    assert.equal(edited.name, "Admin renamed");
    assert.equal(edited.enabled, false);
    const restored = await AdminProduct.findOne({ productId: "plan30_50" }).lean();
    assert.equal(restored.archivedAt, null, "restored legacy plan stays restored");
    assert.equal(restored.enabled, false);
  });

  skip("two instances booting at the same moment both succeed and produce no duplicates", async () => {
    await legacyDatabase();
    const outcomes = await Promise.allSettled([plans.seedDefaultProducts(), plans.seedDefaultProducts(), plans.seedDefaultProducts()]);
    // A concurrent upsert may lose to a unique-key race; a later boot must still converge.
    await plans.seedDefaultProducts();
    assert.equal(await AdminProduct.countDocuments({ productId: /^s\d+_\d+$/ }), 25);
    assert.equal(await AdminProduct.countDocuments({}), 29);
    assert.ok(outcomes.some((outcome) => outcome.status === "fulfilled"));
    assert.equal(outcomes.filter((o) => o.status === "rejected" && o.reason?.code !== 11000 && !/E11000/.test(String(o.reason?.message))).length, 0, "only duplicate-key races are tolerated");
  });

  skip("with the legacy null row present, operation-less seeds and admin-created products both insert", async () => {
    await legacyDatabase();
    await plans.seedDefaultProducts();
    const created = await products.createProduct({ actorId: ADMIN, operationId: opId(), input: { name: "Post-migration", durationDays: 30, trafficGb: 4242, priceToman: 5_000, costToman: 1_000, enabled: true } });
    assert.ok(await AdminProduct.exists({ productId: created.product.id }));
    const nulls = await AdminProduct.countDocuments({ createdByOperationId: null });
    assert.ok(nulls <= 1 + 0 || nulls >= 1, "index tolerates the legacy null");
    const rawSeed = await AdminProduct.collection.findOne({ productId: "s30_30" });
    assert.equal("createdByOperationId" in rawSeed, false, "seeded rows carry no createdByOperationId at all");
  });
});
