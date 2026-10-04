/**
 * Shared admin services against a REAL MongoDB — user management, balance
 * idempotency, products, payments, recovery, dashboard/analytics, VPN registry
 * and broadcast safety. Skips when no test database is reachable.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { waitFor } from "../helpers/util.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
delete process.env.WIZARD_API_URL; // VPN panel calls must fail safely in tests

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = "424242";

let User, WalletPurchase, HooshPayInvoice, CryptoInvoice, bankInvoice, AdminProduct;
let users, vpns, payments, products, recovery, dashboard, analytics, broadcast, plans, audit;

if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ default: HooshPayInvoice } = await import("../../models/HooshPayInvoice.js"));
  ({ default: CryptoInvoice } = await import("../../models/CryptoInvoice.js"));
  ({ default: bankInvoice } = await import("../../models/invoice.js"));
  ({ default: AdminProduct } = await import("../../models/AdminProduct.js"));
  users = await import("../../services/admin/users.js");
  vpns = await import("../../services/admin/vpns.js");
  payments = await import("../../services/admin/payments.js");
  products = await import("../../services/admin/products.js");
  recovery = await import("../../services/admin/recovery.js");
  dashboard = await import("../../services/admin/dashboard.js");
  analytics = await import("../../services/admin/analytics.js");
  broadcast = await import("../../services/admin/broadcast.js");
  ({ seedDefaultProducts } = await import("../../services/plans.js"));
}

const tid = () => String(100000 + Math.floor(Math.random() * 899999));
const opId = () => `op-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;

async function seedUser(overrides = {}) {
  const id = overrides.telegramId || tid();
  await User.create({
    telegramId: id,
    username: overrides.username ?? null,
    firstName: overrides.firstName ?? "Test",
    lastName: overrides.lastName ?? "User",
    balance: overrides.balance ?? 0,
    successfulPayments: overrides.successfulPayments ?? 0,
    ...overrides.extra,
  });
  return id;
}

before(async () => {
  if (!dbAvailable) return;
  await seedDefaultProducts();
});

after(async () => {
  await disconnectTestDB();
});

describe("authorization is enforced inside the service layer", () => {
  skip("non-admin actors cannot even list users", async () => {
    await assert.rejects(() => users.listUsers({ actorId: "999999" }), (error) => error.status === 403);
  });
});

describe("user management", () => {
  skip("search by Telegram ID, username and name prefix", async () => {
    const id = await seedUser({ username: "alice_test", firstName: "Alice" });
    await seedUser({ username: "bob_test", firstName: "Bob" });

    const byId = await users.listUsers({ actorId: ADMIN, query: { search: id } });
    assert.equal(byId.total, 1);
    assert.equal(byId.items[0].telegramId, id);

    const byUsername = await users.listUsers({ actorId: ADMIN, query: { search: "alice_test" } });
    assert.equal(byUsername.total, 1);

    const byName = await users.listUsers({ actorId: ADMIN, query: { search: "Bob" } });
    assert.ok(byName.items.every((user) => /bob/i.test(user.username || "") || /bob/i.test(user.name || "")));
  });

  skip("filters: paying, blocked, activity", async () => {
    await seedUser({ username: "payer_x", successfulPayments: 3, extra: { lastActivityAt: new Date() } });
    await seedUser({ username: "freeloader_x", extra: { lastActivityAt: new Date(Date.now() - 90 * 24 * 3600 * 1000) } });

    const paying = await users.listUsers({ actorId: ADMIN, query: { paying: "yes" } });
    assert.ok(paying.items.length >= 1);
    assert.ok(paying.items.every((user) => user.successfulPayments > 0));

    const inactive = await users.listUsers({ actorId: ADMIN, query: { activity: "inactive" } });
    assert.ok(inactive.items.some((user) => user.username === "freeloader_x"));
  });

  skip("balance add/remove is atomic and idempotent per operationId", async () => {
    const id = await seedUser({ balance: 10_000 });
    const operation = opId();

    const first = await users.changeUserBalance({ actorId: ADMIN, operationId: operation, telegramId: id, amount: 5000, direction: "add", reason: "test credit" });
    assert.equal(first.balance, 15_000);
    const replay = await users.changeUserBalance({ actorId: ADMIN, operationId: operation, telegramId: id, amount: 5000, direction: "add", reason: "test credit" });
    assert.equal(replay.balance, 15_000);
    const user = await User.findOne({ telegramId: id }).lean();
    assert.equal(user.balance, 15_000);

    await users.changeUserBalance({ actorId: ADMIN, operationId: opId(), telegramId: id, amount: 2000, direction: "remove", reason: "test debit" });
    assert.equal((await User.findOne({ telegramId: id }).lean()).balance, 13_000);

    await assert.rejects(
      () => users.changeUserBalance({ actorId: ADMIN, operationId: opId(), telegramId: id, amount: 999_999, direction: "remove", reason: "too much" }),
      (error) => error.code === "insufficient_balance"
    );
  });

  skip("block/unblock records state and reason", async () => {
    const id = await seedUser();
    await users.setUserBlocked({ actorId: ADMIN, operationId: opId(), telegramId: id, blocked: true, reason: "abuse investigation" });
    let user = await User.findOne({ telegramId: id }).lean();
    assert.equal(user.isBanned, true);
    assert.equal(user.blockReason, "abuse investigation");

    const blockedList = await users.listUsers({ actorId: ADMIN, query: { blocked: "yes" } });
    assert.ok(blockedList.items.some((entry) => entry.telegramId === id));

    await users.setUserBlocked({ actorId: ADMIN, operationId: opId(), telegramId: id, blocked: false });
    user = await User.findOne({ telegramId: id }).lean();
    assert.equal(user.isBanned, false);
  });

  skip("user detail aggregates payments, orders, services and referrals", async () => {
    const id = await seedUser({ balance: 5000, successfulPayments: 2 });
    const referrer = await seedUser({ username: "referror_test" });
    await User.updateOne({ telegramId: id }, { $set: { referredByTelegramId: referrer, referralCode: "SWIFT-AB" } });
    await User.create({ telegramId: tid(), referredByTelegramId: id, referralCode: "SWIFT-CD" });
    await HooshPayInvoice.create({
      uid: `hp_${id}`, orderId: `HP-${id}`, userId: Number(id), amount: 20_000,
      paymentUrl: "https://hooshpay.xyz/pay/x", status: "paid", fulfilled: true, balanceCredited: true, balanceCreditedAt: new Date(),
    });
    await WalletPurchase.create({
      purchaseId: `wp_${id}`, telegramId: id, planId: "plan30_10", planName: "10GB", gig: 10, days: 30,
      amount: 18_000, status: "completed", completedAt: new Date(), expiresAt: new Date(Date.now() + 20 * 24 * 3600 * 1000),
    });
    await User.updateOne({ telegramId: id }, { $push: { services: { username: `svc_${id}`, purchaseId: `wp_${id}`, expiresAt: new Date(Date.now() + 20 * 24 * 3600 * 1000) } } });

    const detail = await users.getUserDetail({ actorId: ADMIN, telegramId: id });
    assert.equal(detail.orderCount, 1);
    assert.equal(detail.totalSpent, 18_000);
    assert.equal(detail.activeVpns, 1);
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].status, "fulfilled");
    assert.equal(detail.referral.referralCount, 1);
    assert.ok(detail.referral.referredBy.telegramId === referrer);
  });
});

describe("product catalog", () => {
  skip("seedDefaultProducts imports the shipped catalog exactly once", async () => {
    const added = await seedDefaultProducts();
    assert.equal(added, 0);
    const items = await products.listProducts({ actorId: ADMIN });
    assert.ok(items.length >= 16);
    assert.ok(items.every((item) => item.profitToman === item.priceToman - item.costToman));
  });

  skip("create/update/duplicate/reorder with strict validation", async () => {
    const created = await products.createProduct({
      actorId: ADMIN, operationId: opId(),
      input: { name: "Test 5GB weekly", durationDays: 7, trafficGb: 5, priceToman: 9_000, costToman: 2_000, enabled: true, displayOrder: 99 },
    });
    const id = created.product.id;
    assert.equal(created.product.profitToman, 7_000);

    await assert.rejects(
      () => products.createProduct({ actorId: ADMIN, operationId: opId(), input: { name: "bad", durationDays: 0, trafficGb: 5, priceToman: 1000, costToman: 0 } }),
      /duration days/
    );
    await assert.rejects(
      () => products.createProduct({ actorId: ADMIN, operationId: opId(), input: { name: "bad", durationDays: 5, trafficGb: 5, priceToman: -5, costToman: 0 } }),
      /price/
    );

    const updated = await products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: id, input: { priceToman: 12_000 } });
    assert.equal(updated.product.priceToman, 12_000);

    const duplicated = await products.duplicateProduct({ actorId: ADMIN, operationId: opId(), productId: id });
    assert.equal(duplicated.product.enabled, false, "duplicates start disabled");

    const list = await products.listProducts({ actorId: ADMIN });
    const ids = list.map((item) => item.id);
    await products.reorderProducts({ actorId: ADMIN, operationId: opId(), productIds: [ids[1], ids[0], ...ids.slice(2)] });
    const reordered = await products.listProducts({ actorId: ADMIN });
    assert.equal(reordered[0].id, ids[1]);
    await assert.rejects(
      () => products.reorderProducts({ actorId: ADMIN, operationId: opId(), productIds: [ids[0], ids[0]] }),
      /duplicates/
    );
  });

  skip("the Telegram shop reads the shared catalog", async () => {
    const { getActiveProducts, getActiveProductById } = await import("../../services/plans.js");
    const active = await getActiveProducts(30);
    assert.ok(active.length >= 3);
    assert.ok(active.every((plan) => Number.isInteger(plan.price) && Number.isInteger(plan.days) && Number.isInteger(plan.gig)));
    const first = await getActiveProductById(active[0].id);
    assert.equal(first.id, active[0].id);
  });
});

describe("payments & idempotency", () => {
  skip("normalized listing across all four providers", async () => {
    const id = Number(tid());
    await User.create({ telegramId: String(id) });
    await HooshPayInvoice.create({ uid: `hp_${id}`, orderId: `HP-${id}`, userId: id, amount: 10_000, paymentUrl: "https://hooshpay.xyz/pay/a", status: "pending" });
    await bankInvoice.create({ paymentId: `bank_${id}`, userId: id, amount: 20_000, paymentType: "bank", status: "waiting_for_approval" });
    await CryptoInvoice.create({ invoiceId: `trx_${id}`, userId: id, amount: 30_000, usdAmount: 1, cryptoAmount: 100, currency: "TRX", status: "unpaid" });
    await WalletPurchase.create({ purchaseId: `wp_${id}`, telegramId: String(id), planId: "p", gig: 10, days: 30, amount: 40_000, status: "reserving" });

    const all = await payments.listPayments({ actorId: ADMIN, query: { status: "all", search: String(id) } });
    assert.equal(all.total, 4);
    assert.equal(new Set(all.items.map((item) => item.provider)).size, 4);
    assert.ok(all.items.every((item) => item.status === "pending"));

    const recoveryList = await payments.listPayments({ actorId: ADMIN, query: { status: "recovery-required" } });
    assert.ok(Array.isArray(recoveryList.items));
  });

  skip("bank retry credits exactly once and replays are no-ops", async () => {
    const id = Number(tid());
    await User.create({ telegramId: String(id), balance: 0 });
    await bankInvoice.create({
      paymentId: `bank_cr_${id}`, userId: id, amount: 25_000, paymentType: "bank",
      status: "confirmed", creditLedgerVersion: 2, balanceCredited: false, confirmedAt: new Date(),
    });

    const first = await payments.retryPayment({ actorId: ADMIN, operationId: opId(), key: `bank:bank_cr_${id}` });
    assert.equal(first.status, "credited");
    let user = await User.findOne({ telegramId: String(id) }).lean();
    assert.equal(user.balance, 25_000);

    const second = await payments.retryPayment({ actorId: ADMIN, operationId: opId(), key: `bank:bank_cr_${id}` });
    assert.equal(second.status, "already_confirmed");
    user = await User.findOne({ telegramId: String(id) }).lean();
    assert.equal(user.balance, 25_000, "never credited twice");
  });

  skip("wallet order retry commits a provisioned service exactly once", async () => {
    const id = tid();
    const purchaseId = `wp_prov_${id}`;
    await User.create({
      telegramId: id, balance: 0, appliedPurchaseReservations: [purchaseId],
    });
    await WalletPurchase.create({
      purchaseId, telegramId: id, planId: "plan30_10", planName: "10GB 30d", gig: 10, days: 30,
      amount: 18_000, status: "provisioned", serviceUsername: `svc_${id}`, provisionedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });

    const first = await payments.retryPayment({ actorId: ADMIN, operationId: opId(), key: `wallet:${purchaseId}` });
    assert.equal(first.status, "fulfilled");
    let user = await User.findOne({ telegramId: id }).lean();
    assert.equal(user.services.length, 1);
    assert.equal(user.completedPurchaseIds.length, 1);

    const second = await payments.retryPayment({ actorId: ADMIN, operationId: opId(), key: `wallet:${purchaseId}` });
    assert.ok(["already-finished", "notification-pending", "fulfilled", "notification-sent"].includes(second.status) || second.ok === true);
    user = await User.findOne({ telegramId: id }).lean();
    assert.equal(user.services.length, 1, "service committed exactly once");
    assert.equal((await WalletPurchase.findOne({ purchaseId }).lean()).status, "completed");
  });

  skip("payment detail includes the full timeline", async () => {
    const id = Number(tid());
    await User.create({ telegramId: String(id) });
    await HooshPayInvoice.create({
      uid: `hp_tl_${id}`, orderId: `HP-tl-${id}`, userId: id, amount: 15_000, paymentUrl: "https://hooshpay.xyz/pay/b",
      status: "paid", fulfilled: true, balanceCredited: true, paidAt: new Date(), balanceCreditedAt: new Date(),
      webhookLog: [{ receivedAt: new Date(), payload: { event: "payment.success", status: "paid", amount: 15_000 } }],
    });
    const detail = await payments.getPaymentDetail({ actorId: ADMIN, key: `hooshpay:hp_tl_${id}` });
    assert.equal(detail.status, "fulfilled");
    assert.ok(detail.timeline.some((event) => event.name === "Webhook received"));
    assert.ok(detail.timeline.some((event) => event.name === "Wallet credited"));
    assert.equal(detail.webhookEvents.length, 1);
  });
});

describe("recovery queue", () => {
  skip("surfaces paid-not-fulfilled and ambiguous provisioning separately", async () => {
    const id = Number(tid());
    await User.create({ telegramId: String(id) });
    await HooshPayInvoice.create({
      uid: `hp_rec_${id}`, orderId: `HP-rec-${id}`, userId: id, amount: 30_000,
      paymentUrl: "https://hooshpay.xyz/pay/c", status: "paid", fulfilled: true, balanceCredited: false,
      webhookLog: [{ receivedAt: new Date(), payload: { status: "paid" } }],
    });
    await WalletPurchase.create({
      purchaseId: `wp_amb_${id}`, telegramId: String(id), planId: "p", gig: 10, days: 30,
      amount: 20_000, status: "manual_review", errorCode: "PANEL_RESULT_UNKNOWN", provisioningStartedAt: new Date(),
    });

    const queue = await recovery.getRecoveryQueue({ actorId: ADMIN });
    assert.ok(queue.items.some((item) => item.key === `hooshpay:hp_rec_${id}` && item.kind === "webhook-processing-failed" && item.retrySafe));
    const ambiguous = queue.items.find((item) => item.key === `wallet:wp_amb_${id}`);
    assert.ok(ambiguous);
    assert.equal(ambiguous.retrySafe, false, "ambiguous provisioning is never auto-retried");
  });

  skip("retry-safe only retries the explicitly selected safe items", async () => {
    const id = Number(tid());
    await User.create({ telegramId: String(id), balance: 0 });
    await bankInvoice.create({
      paymentId: `bank_safe_${id}`, userId: Number(id), amount: 5_000, paymentType: "bank",
      status: "confirmed", creditLedgerVersion: 2, balanceCredited: false,
    });
    const result = await recovery.retrySafeRecoveryItems({ actorId: ADMIN, operationId: opId(), keys: [`bank:bank_safe_${id}`] });
    assert.equal(result.attempted, 1);
    assert.equal(result.succeeded, 1);
    assert.equal((await User.findOne({ telegramId: String(id) }).lean()).balance, 5_000);
  });
});

describe("dashboard & analytics", () => {
  skip("dashboard computes real metrics", async () => {
    const data = await dashboard.getDashboardMetrics({ actorId: ADMIN });
    assert.ok(Number.isInteger(data.metrics.totalUsers));
    assert.ok(Number.isInteger(data.metrics.pendingOrders));
    assert.equal(typeof data.metrics.revenue.today, "number");
    assert.ok(data.charts.revenue.length === 30);
    assert.ok(data.charts.newUsers.length === 30);
    assert.ok(data.definitions.activeUsers.length > 0, "metric definitions are documented");
  });

  skip("analytics aggregates at all granularities", async () => {
    for (const granularity of ["daily", "weekly", "monthly"]) {
      const data = await analytics.getAnalytics({ actorId: ADMIN, granularity });
      assert.equal(data.granularity, granularity);
      assert.ok(data.series.length >= 12);
      assert.ok(data.series.every((row) => row.revenue >= 0));
    }
  });
});

describe("VPN registry", () => {
  skip("lists services with product, expiry and status", async () => {
    const id = tid();
    const purchaseId = `wp_vpn_${id}`;
    await User.create({ telegramId: id, username: `vpnuser_${id}` });
    await WalletPurchase.create({
      purchaseId, telegramId: id, planId: "plan30_50", planName: "50GB 30d", gig: 50, days: 30,
      amount: 42_000, status: "completed", completedAt: new Date(), expiresAt: new Date(Date.now() + 15 * 24 * 3600 * 1000),
    });
    await User.updateOne({ telegramId: id }, { $push: { services: { username: `svc_vpn_${id}`, purchaseId, trafficGb: 50, expiresAt: new Date(Date.now() + 15 * 24 * 3600 * 1000) } } });

    const list = await vpns.listVpns({ actorId: ADMIN, query: { search: id, status: "active" } });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].productId, "plan30_50");
    assert.equal(list.items[0].status, "active");

    const expiring = await vpns.listVpns({ actorId: ADMIN, query: { search: id, status: "expiring" } });
    assert.equal(expiring.total, 1);
  });

  skip("detail degrades safely when WizardXray is unreachable", async () => {
    const id = tid();
    await User.create({ telegramId: id });
    await User.updateOne({ telegramId: id }, { $push: { services: { username: `svc_det_${id}`, expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000) } } });

    const detail = await vpns.getVpnDetail({ actorId: ADMIN, username: `svc_det_${id}` });
    assert.equal(detail.wizardXray.status, "unavailable");
    assert.ok(detail.wizardXray.error.length > 0);
    assert.equal(detail.availableActions.changeLink, false);
    assert.ok(detail.unavailableActions.extendTime.includes("no safe"));

    await assert.rejects(
      () => vpns.performVpnAction({ actorId: ADMIN, operationId: opId(), username: `svc_det_${id}`, action: "change-link", reason: "test action" }),
      (error) => error.status >= 500 && !/WIZARD_API_KEY|VPN_API_KEY/.test(error.message)
    );
  });

  skip("unsupported WizardXray actions are refused, not faked", async () => {
    await assert.rejects(
      () => vpns.performVpnAction({ actorId: ADMIN, operationId: opId(), username: "svc_x", action: "extend-time", reason: "test" }),
      (error) => error.status === 501
    );
  });
});

describe("broadcast", () => {
  skip("preview validates message and buttons", async () => {
    const ok = await broadcast.previewBroadcast({ actorId: ADMIN, message: "Hello everyone", buttons: [] });
    assert.equal(ok.preview.characterCount, 14);
    await assert.rejects(
      () => broadcast.previewBroadcast({ actorId: ADMIN, message: "x", buttons: [{ text: "evil", url: "https://evil.example" }] }),
      /t\.me/
    );
    await assert.rejects(
      () => broadcast.previewBroadcast({ actorId: ADMIN, message: "" }),
      /message/
    );
  });

  skip("custom broadcast records per-recipient results without a bot (fails safely)", async () => {
    const id = tid();
    await User.create({ telegramId: id });
    const operation = opId();
    const result = await broadcast.createBroadcast({
      actorId: ADMIN, operationId: operation, message: "Test announcement", audience: "custom", customTelegramIds: [id],
    });
    assert.equal(result.started, true);
    assert.equal(result.broadcast.total, 1);

    const status = await waitFor(
      () => broadcast.getBroadcastStatus({ actorId: ADMIN, operationId: operation }).then((value) => ["completed", "failed", "cancelled"].includes(value.status) ? value : null),
      { timeoutMs: 10_000 }
    );
    assert.ok(status, "broadcast must finish");
    assert.equal(status.processed, 1);
    assert.equal(status.succeeded, 0, "no bot instance means nothing was actually delivered");
    assert.equal(status.failed, 1);
    assert.equal(status.lastErrorCode, "bot_unavailable");

    const cancel = await broadcast.requestBroadcastCancel({ actorId: ADMIN, operationId: operation });
    assert.equal(cancel.alreadyFinished, true);
  });
});
