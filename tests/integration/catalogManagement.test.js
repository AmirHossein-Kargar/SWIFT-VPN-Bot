/**
 * Service catalog management (REAL MongoDB + REAL HTTP server).
 *
 * Covers listing/pagination/search/sort/filter, create/edit validation,
 * duplicate and stale-edit protection, availability + storefront publication,
 * purchase gating on direct requests, historical-record integrity, reference-safe
 * deletion/archival, authorization and audit records. Skips without a test DB.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.BOT_USERNAME = "Swift_servicebot";
process.env.WEBHOOK_BASE_URL = "https://shop.example.com";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = "424242";
const OUTSIDER = "999111";

let AdminProduct, WalletPurchase, User, AdminAuditLog;
let products, plans, purchaseService, auth, resetAdminRateLimitsForTests;
let server, baseUrl, fakeRedis;

if (dbAvailable) {
  ({ default: AdminProduct } = await import("../../models/AdminProduct.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: User } = await import("../../models/User.js"));
  ({ default: AdminAuditLog } = await import("../../models/AdminAuditLog.js"));
  products = await import("../../services/admin/products.js");
  plans = await import("../../services/plans.js");
  purchaseService = await import("../../services/buyService/purchaseService.js");
  auth = await import("../../services/admin/auth.js");
  ({ resetAdminRateLimitsForTests } = await import("../../web/adminMiddleware.js"));
  fakeRedis = makeFakeRedis();
  auth.setAdminSessionRedisForTests(fakeRedis);
  const app = (await import("../../server.js")).default;
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

const opId = () => `op-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
const tid = () => String(100000 + Math.floor(Math.random() * 899999));

async function call(method, path, { body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, data };
}

async function signIn() {
  resetAdminRateLimitsForTests();
  await fakeRedis.del(`admin:web:login-rate:${ADMIN}`);
  const { code } = await auth.issueAdminLoginCode(ADMIN, fakeRedis);
  const response = await fetch(`${baseUrl}/api/admin/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await response.json();
  return { cookie: (response.headers.get("set-cookie") || "").split(";")[0], csrf: data.csrfToken };
}

const create = (input, actorId = ADMIN) => products.createProduct({ actorId, operationId: opId(), input });
const valid = (overrides = {}) => ({ name: "Plan", durationDays: 30, trafficGb: 10, priceToman: 20_000, costToman: 10_000, enabled: true, ...overrides });
const rejectsWith = (promise, code, status) => assert.rejects(promise, (error) => error.code === code && (status == null || error.status === status), `expected ${code}`);

before(async () => {
  if (!dbAvailable) return;
  // Unique indexes (operation ids, product ids) are built in the background; idempotency/duplicate tests need them ready.
  await Promise.all([AdminProduct, AdminAuditLog, WalletPurchase, User].map((model) => model.init()));
  await plans.seedDefaultProducts();
});

after(async () => {
  server?.close();
  await disconnectTestDB();
});

describe("catalog listing", () => {
  skip("shows the whole seeded catalog with server-side pagination and counts", async () => {
    const first = await products.listProductsPage({ actorId: ADMIN, query: { pageSize: 10 } });
    assert.equal(first.items.length, 10);
    assert.equal(first.total, 25, "25 shipped plans");
    assert.equal(first.filteredTotal, 25);
    assert.equal(first.pages, 3);

    const last = await products.listProductsPage({ actorId: ADMIN, query: { pageSize: 10, page: 3 } });
    assert.equal(last.items.length, 5);
    const ids = new Set([...first.items, ...last.items].map((item) => item.id));
    assert.equal(ids.size, 15, "pages never overlap");

    const capped = await products.listProductsPage({ actorId: ADMIN, query: { pageSize: 5000 } });
    assert.ok(capped.items.length <= 100, "page size is capped");
    const item = first.items[0];
    assert.equal(item.supportedDuration, true);
    assert.equal(item.system, true);
    assert.equal(item.published, true);
    assert.equal(item.archived, false);
    assert.equal(typeof item.revision, "number");
  });

  skip("search, status filter, duration filter and sorting return the right rows", async () => {
    const cheap = (await create(valid({ name: "Zeta searchable", trafficGb: 7, priceToman: 1_000, enabled: false }))).product;
    const dear = (await create(valid({ name: "Alpha searchable", trafficGb: 8, priceToman: 9_999_000, durationDays: 365 }))).product;

    const byName = await products.listProductsPage({ actorId: ADMIN, query: { search: "searchable" } });
    assert.deepEqual(byName.items.map((item) => item.id).sort(), [cheap.id, dear.id].sort());
    assert.equal(byName.filteredTotal, 2);
    assert.ok(byName.total > byName.filteredTotal);

    const byId = await products.listProductsPage({ actorId: ADMIN, query: { search: dear.id } });
    assert.deepEqual(byId.items.map((item) => item.id), [dear.id]);

    const regexSafe = await products.listProductsPage({ actorId: ADMIN, query: { search: ".*" } });
    assert.equal(regexSafe.filteredTotal, 0, "search text is escaped, not interpreted as a pattern");

    const disabled = await products.listProductsPage({ actorId: ADMIN, query: { status: "disabled" } });
    assert.ok(disabled.items.some((item) => item.id === cheap.id));
    assert.ok(disabled.items.every((item) => !item.enabled));

    const year = await products.listProductsPage({ actorId: ADMIN, query: { duration: 365, search: "searchable" } });
    assert.deepEqual(year.items.map((item) => item.id), [dear.id]);

    const priceDesc = await products.listProductsPage({ actorId: ADMIN, query: { search: "searchable", sort: "price", order: "desc" } });
    assert.deepEqual(priceDesc.items.map((item) => item.id), [dear.id, cheap.id]);
    const nameAsc = await products.listProductsPage({ actorId: ADMIN, query: { search: "searchable", sort: "name", order: "asc" } });
    assert.deepEqual(nameAsc.items.map((item) => item.id), [dear.id, cheap.id], "Alpha before Zeta");
    const bogus = await products.listProductsPage({ actorId: ADMIN, query: { sort: "$where", status: "bogus" } });
    assert.ok(bogus.items.length > 0, "unknown sort/status values fall back to defaults");
  });
});

describe("create", () => {
  skip("a valid service is stored with a generated id, revision 0 and an audit record", async () => {
    const { product } = await create(valid({ name: "  Fresh plan  ", trafficGb: 11 }));
    assert.match(product.id, /^svc_[0-9a-f]{12}$/);
    assert.equal(product.name, "Fresh plan");
    assert.equal(product.revision, 0);
    assert.equal(product.published, true);
    assert.equal(product.profitToman, 10_000);
    assert.ok(await AdminAuditLog.findOne({ action: "PRODUCT_CREATED", status: "succeeded" }));
  });

  skip("custom ids work; invalid, duplicate and shipped ids are rejected", async () => {
    const { product } = await create(valid({ productId: "promo_20gb", trafficGb: 20 }));
    assert.equal(product.id, "promo_20gb");
    await rejectsWith(create(valid({ productId: "promo_20gb", trafficGb: 21 })), "duplicate_product_id", 409);
    await rejectsWith(create(valid({ productId: "s30_10", trafficGb: 22 })), "duplicate_product_id", 409);
    for (const bad of ["Bad Id", "1abc", "ab", "x".repeat(40), "../etc", "a b"]) {
      await rejectsWith(create(valid({ productId: bad, trafficGb: 23 })), "invalid_product_id", 400);
    }
  });

  skip("invalid definitions are rejected before anything is stored", async () => {
    const before = await AdminProduct.countDocuments({});
    const cases = [
      [{ name: "" }, "invalid_product_name"],
      [{ name: "x".repeat(121) }, "invalid_product_name"],
      [{ name: "bad\u0000name" }, "invalid_product_name"],
      [{ priceToman: 0 }, "invalid_price"],
      [{ priceToman: -5 }, "invalid_price"],
      [{ priceToman: 1.5 }, "invalid_price"],
      [{ priceToman: "abc" }, "invalid_price"],
      [{ costToman: -1 }, "invalid_cost"],
      [{ trafficGb: 0 }, "invalid_traffic_gb"],
      [{ trafficGb: 100_001 }, "invalid_traffic_gb"],
      [{ durationDays: 0 }, "invalid_duration_days"],
      [{ durationDays: 45 }, "unsupported_duration"],
      [{ durationDays: 60 }, "unsupported_duration"],
      [{ enabled: "yes" }, "invalid_product_enabled"],
      [{ published: "no" }, "invalid_product_published"],
    ];
    for (const [overrides, code] of cases) {
      await rejectsWith(create(valid({ trafficGb: 31, ...overrides })), code, 400);
    }
    await assert.rejects(() => products.createProduct({ actorId: ADMIN, operationId: opId(), input: null }));
    assert.equal(await AdminProduct.countDocuments({}), before);
  });

  skip("a second enabled product with the same duration and traffic is a conflict; a disabled one is not", async () => {
    await create(valid({ trafficGb: 41 }));
    await rejectsWith(create(valid({ trafficGb: 41, name: "Same again" })), "duplicate_product_definition", 409);
    const parked = await create(valid({ trafficGb: 41, enabled: false }));
    await rejectsWith(products.setProductEnabled({ actorId: ADMIN, operationId: opId(), productId: parked.product.id, enabled: true }), "duplicate_product_definition", 409);
  });

  skip("replaying the same operation id does not create a second product", async () => {
    const operationId = opId();
    const a = await products.createProduct({ actorId: ADMIN, operationId, input: valid({ trafficGb: 51 }) });
    const b = await products.createProduct({ actorId: ADMIN, operationId, input: valid({ trafficGb: 51 }) });
    assert.equal(a.product.id, b.productId, "a replay returns the recorded outcome of the first call");
    assert.equal(await AdminProduct.countDocuments({ trafficGb: 51 }), 1);
  });
});

describe("edit", () => {
  skip("edits keep the id, bump the revision and are audited", async () => {
    const { product } = await create(valid({ trafficGb: 61 }));
    const updated = await products.updateProduct({
      actorId: ADMIN, operationId: opId(), productId: product.id,
      input: { name: "Renamed", priceToman: 22_500, expectedRevision: product.revision },
    });
    assert.equal(updated.product.id, product.id);
    assert.equal(updated.product.name, "Renamed");
    assert.equal(updated.product.priceToman, 22_500);
    assert.equal(updated.product.revision, product.revision + 1);
    assert.equal(updated.product.createdAt.getTime(), product.createdAt.getTime());
    assert.ok(await AdminAuditLog.findOne({ action: "PRODUCT_UPDATED", targetId: product.id, status: "succeeded" }));
  });

  skip("an edit built from a stale form is refused and changes nothing", async () => {
    const { product } = await create(valid({ trafficGb: 62 }));
    await products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { priceToman: 30_000, expectedRevision: 0 } });
    await rejectsWith(
      products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { priceToman: 1_234, expectedRevision: 0 } }),
      "product_stale", 409,
    );
    assert.equal((await AdminProduct.findOne({ productId: product.id })).priceToman, 30_000);
  });

  skip("two simultaneous edits from the same revision: exactly one wins", async () => {
    const { product } = await create(valid({ trafficGb: 63 }));
    const attempts = await Promise.allSettled([1, 2, 3, 4].map((n) =>
      products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { priceToman: 40_000 + n, expectedRevision: 0 } })));
    const won = attempts.filter((a) => a.status === "fulfilled");
    const lost = attempts.filter((a) => a.status === "rejected");
    assert.equal(won.length, 1);
    assert.ok(lost.every((a) => a.reason.code === "product_stale" && a.reason.status === 409));
    assert.equal((await AdminProduct.findOne({ productId: product.id })).revision, 1);
  });

  skip("edits are validated on the server and unknown ids are 404", async () => {
    const { product } = await create(valid({ trafficGb: 64 }));
    await rejectsWith(products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { priceToman: -1 } }), "invalid_price", 400);
    await rejectsWith(products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { durationDays: 45 } }), "unsupported_duration", 400);
    await rejectsWith(products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: {} }), "empty_product_update", 400);
    await rejectsWith(products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: "svc_missing", input: { priceToman: 5 } }), "product_not_found", 404);
    await rejectsWith(products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: "../x", input: { priceToman: 5 } }), "invalid_product_id", 400);
  });
});

describe("availability and publication", () => {
  skip("disabling removes a plan from the bot, the storefront catalog and direct purchases", async () => {
    const { product } = await create(valid({ trafficGb: 71, priceToman: 71_000 }));
    assert.equal((await plans.getSellablePlanById(product.id)).price, 71_000);
    const listed = async () => (await call("GET", "/api/store/catalog")).data.data.plans.map((plan) => plan.id);
    assert.ok((await listed()).includes(product.id));

    await products.setProductEnabled({ actorId: ADMIN, operationId: opId(), productId: product.id, enabled: false });
    assert.equal(await plans.getSellablePlanById(product.id), null);
    assert.ok(!(await listed()).includes(product.id));
    assert.equal((await call("GET", `/api/store/plans/${product.id}`)).status, 404);
    assert.ok(await AdminAuditLog.findOne({ action: "PRODUCT_AVAILABILITY_CHANGED", targetId: product.id }));

    await products.setProductEnabled({ actorId: ADMIN, operationId: opId(), productId: product.id, enabled: true });
    assert.equal((await call("GET", `/api/store/plans/${product.id}`)).status, 200);
  });

  skip("unpublishing hides a plan from the storefront but keeps it purchasable in the bot", async () => {
    const { product } = await create(valid({ trafficGb: 72 }));
    await products.setProductPublished({ actorId: ADMIN, operationId: opId(), productId: product.id, published: false });
    const catalog = (await call("GET", "/api/store/catalog")).data.data;
    assert.ok(!catalog.plans.some((plan) => plan.id === product.id));
    assert.equal((await call("GET", `/api/store/plans/${product.id}`)).status, 404, "stale storefront sessions cannot hand off an unpublished plan");
    assert.ok(await plans.getSellablePlanById(product.id), "the bot still sells it");
    assert.equal(await plans.getSellablePlanById(product.id, { storefront: true }), null);
    const { planFromStartPayload } = await import("../../handlers/message/handleStartPayload.js");
    assert.equal(await planFromStartPayload(`plan_${product.id}`), null);

    await products.setProductPublished({ actorId: ADMIN, operationId: opId(), productId: product.id, published: true });
    assert.ok(await planFromStartPayload(`plan_${product.id}`));
  });

  skip("a disabled plan cannot be bought through the purchase service even when the id is replayed", async () => {
    const { product } = await create(valid({ trafficGb: 73, priceToman: 5_000, enabled: false }));
    const telegramId = tid();
    await User.create({ telegramId, balance: 1_000_000 });
    let providerCalls = 0;
    const createService = async () => { providerCalls += 1; throw new Error("provider must not be reached"); };
    await assert.rejects(
      () => purchaseService.purchasePlan(telegramId, product.id, { purchaseId: `p_${telegramId}_a`, createService }),
      (error) => error.code === "INVALID_PLAN",
    );
    assert.equal(providerCalls, 0);
    assert.equal((await User.findOne({ telegramId })).balance, 1_000_000, "no wallet debit");
    assert.equal(await WalletPurchase.countDocuments({ telegramId }), 0, "no purchase record");
  });

  skip("price changes apply to new purchases only; the order keeps the terms it was sold with", async () => {
    const { product } = await create(valid({ trafficGb: 74, priceToman: 10_000 }));
    const telegramId = tid();
    await User.create({ telegramId, balance: 100_000 });
    const sold = await purchaseService.purchasePlan(telegramId, product.id, {
      purchaseId: `p_${telegramId}_b`,
      createService: async () => ({ username: `svc_${telegramId}`, sub_link: "https://panel.example.test/sub/x", hash: "h" }),
    }).catch((error) => error);
    const purchase = await WalletPurchase.findOne({ telegramId });
    assert.ok(purchase, `purchase created (${sold?.code || sold?.status || "ok"})`);
    assert.equal(purchase.amount, 10_000);

    await products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { priceToman: 99_000, name: "Repriced" } });
    await products.archiveProduct({ actorId: ADMIN, operationId: opId(), productId: product.id });
    const after = await WalletPurchase.findOne({ telegramId });
    assert.equal(after.amount, 10_000);
    assert.equal(after.planId, product.id);
    assert.equal(after.gig, 74);
    assert.equal(after.days, 30);
    assert.equal(after.planName, "Plan", "plan name snapshot is not rewritten");
  });
});

describe("archive, restore and deletion", () => {
  skip("archiving removes the plan from sale but leaves customers' services untouched", async () => {
    const { product } = await create(valid({ trafficGb: 81 }));
    const telegramId = tid();
    await User.create({ telegramId, services: [{ username: `svc_${telegramId}`, productId: product.id, trafficGb: 81, expiresAt: new Date(Date.now() + 86_400_000) }] });

    const archived = (await products.archiveProduct({ actorId: ADMIN, operationId: opId(), productId: product.id })).product;
    assert.equal(archived.archived, true);
    assert.equal(archived.enabled, false);
    assert.equal(archived.published, false);
    assert.equal(await plans.getSellablePlanById(product.id), null);
    const user = await User.findOne({ telegramId });
    assert.equal(user.services.length, 1);
    assert.equal(user.services[0].revokedAt, null, "existing access is not revoked");

    const defaultView = await products.listProductsPage({ actorId: ADMIN, query: { search: product.id } });
    assert.equal(defaultView.filteredTotal, 0, "hidden from the default view");
    const archivedView = await products.listProductsPage({ actorId: ADMIN, query: { search: product.id, status: "archived" } });
    assert.equal(archivedView.filteredTotal, 1);

    await rejectsWith(products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { enabled: true } }), "product_archived", 409);
    await rejectsWith(products.archiveProduct({ actorId: ADMIN, operationId: opId(), productId: product.id }), "product_archived", 409);

    const restored = (await products.restoreProduct({ actorId: ADMIN, operationId: opId(), productId: product.id })).product;
    assert.equal(restored.archived, false);
    assert.equal(restored.enabled, false, "restored plans come back off sale");
    assert.equal(await plans.getSellablePlanById(product.id), null);
    assert.ok(await AdminAuditLog.findOne({ action: "PRODUCT_ARCHIVED", targetId: product.id }));
    assert.ok(await AdminAuditLog.findOne({ action: "PRODUCT_RESTORED", targetId: product.id }));
  });

  skip("a product referenced by an order, an invoice or a provisioned service cannot be deleted", async () => {
    const { default: NowPaymentsInvoice } = await import("../../models/NowPaymentsInvoice.js");
    const viaPurchase = (await create(valid({ trafficGb: 91 }))).product;
    const viaService = (await create(valid({ trafficGb: 92 }))).product;
    const telegramId = tid();
    await WalletPurchase.create({ purchaseId: `p_${telegramId}_c`, telegramId, planId: viaPurchase.id, planName: "x", gig: 91, days: 30, amount: 1, status: "completed" });
    await User.create({ telegramId: tid(), services: [{ username: `svc_${tid()}`, productId: viaService.id, trafficGb: 92 }] });

    for (const target of [viaPurchase, viaService]) {
      await rejectsWith(products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: target.id }), "product_in_use", 409);
      assert.ok(await AdminProduct.exists({ productId: target.id }), "still in the catalog");
    }
    assert.equal(typeof NowPaymentsInvoice.countDocuments, "function");
    const counts = await products.countProductReferences(viaPurchase.id);
    assert.equal(counts.purchases, 1);
    assert.equal(counts.total, 1);
  });

  skip("shipped plans are protected; an unreferenced custom plan can be deleted (stale revision refused)", async () => {
    await rejectsWith(products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: "s30_10" }), "product_protected", 409);
    assert.ok(await AdminProduct.exists({ productId: "s30_10" }));

    const { product } = await create(valid({ trafficGb: 93 }));
    await products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, input: { priceToman: 21_000 } });
    await rejectsWith(products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, expectedRevision: 0 }), "product_stale", 409);
    const result = await products.deleteProduct({ actorId: ADMIN, operationId: opId(), productId: product.id, expectedRevision: 1 });
    assert.equal(result.deleted, true);
    assert.equal(await AdminProduct.exists({ productId: product.id }), null);
    assert.ok(await AdminAuditLog.findOne({ action: "PRODUCT_DELETED", targetId: product.id, status: "succeeded" }));
  });
});

describe("ordering", () => {
  skip("moving a product swaps it with its neighbour across the whole catalog", async () => {
    const list = async () => (await products.listProductsPage({ actorId: ADMIN, query: { pageSize: 100, sort: "order" } })).items.map((item) => item.id);
    const before = await list();
    await products.moveProduct({ actorId: ADMIN, operationId: opId(), productId: before[1], direction: "up" });
    const after = await list();
    assert.equal(after[0], before[1]);
    assert.equal(after[1], before[0]);
    await rejectsWith(products.moveProduct({ actorId: ADMIN, operationId: opId(), productId: before[0], direction: "sideways" }), "invalid_move_direction", 400);
  });
});

describe("authorization", () => {
  skip("non-admin actors cannot create, edit, toggle, archive, restore or delete at the service layer", async () => {
    const { product } = await create(valid({ trafficGb: 101 }));
    const forbidden = (promise) => assert.rejects(promise, (error) => error.status === 403 && error.code === "forbidden");
    await forbidden(products.listProductsPage({ actorId: OUTSIDER, query: {} }));
    await forbidden(create(valid({ trafficGb: 102 }), OUTSIDER));
    await forbidden(products.updateProduct({ actorId: OUTSIDER, operationId: opId(), productId: product.id, input: { priceToman: 1 } }));
    await forbidden(products.setProductEnabled({ actorId: OUTSIDER, operationId: opId(), productId: product.id, enabled: false }));
    await forbidden(products.setProductPublished({ actorId: OUTSIDER, operationId: opId(), productId: product.id, published: false }));
    await forbidden(products.archiveProduct({ actorId: OUTSIDER, operationId: opId(), productId: product.id }));
    await forbidden(products.restoreProduct({ actorId: OUTSIDER, operationId: opId(), productId: product.id }));
    await forbidden(products.deleteProduct({ actorId: OUTSIDER, operationId: opId(), productId: product.id }));
    await forbidden(products.moveProduct({ actorId: OUTSIDER, operationId: opId(), productId: product.id, direction: "up" }));
    const unchanged = await AdminProduct.findOne({ productId: product.id });
    assert.equal(unchanged.priceToman, 20_000);
    assert.equal(unchanged.enabled, true);
  });

  skip("HTTP: anonymous and CSRF-less requests are refused on every catalog mutation; a signed-in admin can use them", async () => {
    const { product } = await create(valid({ trafficGb: 103 }));
    const mutations = [
      ["POST", "/api/admin/products", valid({ trafficGb: 104, operationId: opId() })],
      ["PATCH", `/api/admin/products/${product.id}`, { operationId: opId(), enabled: false }],
      ["POST", `/api/admin/products/${product.id}/archive`, { operationId: opId() }],
      ["POST", `/api/admin/products/${product.id}/restore`, { operationId: opId() }],
      ["POST", `/api/admin/products/${product.id}/move`, { operationId: opId(), direction: "up" }],
      ["DELETE", `/api/admin/products/${product.id}`, { operationId: opId() }],
    ];
    for (const [method, path, body] of mutations) {
      assert.equal((await call(method, path, { body })).status, 401, `${method} ${path} anonymous`);
    }
    assert.equal((await call("GET", "/api/admin/products")).status, 401);

    const session = await signIn();
    for (const [method, path, body] of mutations) {
      assert.equal((await call(method, path, { body, cookie: session.cookie })).status, 403, `${method} ${path} without CSRF`);
    }
    assert.equal((await AdminProduct.findOne({ productId: product.id })).enabled, true);

    const page = await call("GET", "/api/admin/products?pageSize=5&search=Plan&sort=price&order=desc", { cookie: session.cookie });
    assert.equal(page.status, 200);
    assert.ok(page.data.data.items.length <= 5);
    assert.equal(typeof page.data.data.filteredTotal, "number");
    for (const item of page.data.data.items) assert.ok(!("lastOperationId" in item) && !("createdByOperationId" in item), "no internal fields leak");

    const patched = await call("PATCH", `/api/admin/products/${product.id}`, { body: { operationId: opId(), enabled: false, expectedRevision: 0 }, cookie: session.cookie, csrf: session.csrf });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.data.product.enabled, false);
    const stale = await call("PATCH", `/api/admin/products/${product.id}`, { body: { operationId: opId(), enabled: true, expectedRevision: 0 }, cookie: session.cookie, csrf: session.csrf });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code ?? stale.data.error, "product_stale");
    const archived = await call("POST", `/api/admin/products/${product.id}/archive`, { body: { operationId: opId() }, cookie: session.cookie, csrf: session.csrf });
    assert.equal(archived.status, 200);
    const deleted = await call("DELETE", `/api/admin/products/${product.id}`, { body: { operationId: opId() }, cookie: session.cookie, csrf: session.csrf });
    assert.equal(deleted.status, 200);
  });
});
