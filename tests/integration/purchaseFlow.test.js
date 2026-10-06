/**
 * Customer purchase and wallet ledger integration tests.
 *
 * MongoDB is real so atomic balance/idempotency filters are exercised. The
 * WizardXray dependency is replaced with a local HTTP stub and all credentials
 * below are deliberately fake; timeout behaviour is also injected directly.
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

let wizard;
let wizardMode = "ok";
const wizardCalls = [];

before(async () => {
  process.env.NODE_ENV = "test";
  wizard = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/create")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      wizardCalls.push({ url: req.url, body });
      if (wizardMode === "destroy") {
        req.socket.destroy();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (wizardMode === "insufficient") {
        res.end(JSON.stringify({ ok: false, error: "panel: insufficient balance" }));
        return;
      }
      if (wizardMode === "api_error") {
        res.end(JSON.stringify({ ok: false, error: "provider rejected request" }));
        return;
      }
      if (wizardMode === "malformed") {
        res.end(JSON.stringify({ ok: true, result: { username: "not a valid username", hash: "" } }));
        return;
      }
      res.end(JSON.stringify({
        ok: true,
        result: {
          username: `stub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          hash: "abc123hash",
          sub_link: "https://panel.example.test/sub/abc123hash",
          tak_links: ["vless://stub@example.com:443"],
          // A supplier field in an API response must not reach the purchase or customer result.
          supplier_cost: 987_654_321,
        },
      }));
    });
  });
  await new Promise((resolve) => wizard.listen(0, "127.0.0.1", resolve));
  process.env.WIZARD_API_URL = `http://127.0.0.1:${wizard.address().port}`;
  process.env.VPN_API_KEY = "fake-test-key-never-a-real-credential";
  process.env.GROUP_ID = "";
});

const dbAvailable = await connectTestDB();

let User;
let WalletPurchase;
let orderService;
let purchasePlan;
let refundPurchaseReservation;
let commitProvisionedPurchase;
let isAllowedWalletPurchaseTransition;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase, isAllowedWalletPurchaseTransition } = await import("../../models/WalletPurchase.js"));
  orderService = (await import("../../services/buyService/orderService.js")).default;
  ({ purchasePlan } = await import("../../services/buyService/purchaseService.js"));
  ({ refundPurchaseReservation, commitProvisionedPurchase } = await import("../../services/buyService/purchaseLedger.js"));
}

after(async () => {
  if (wizard) await new Promise((resolve) => wizard.close(resolve));
  await disconnectTestDB();
});

const MINI = "mini";
const MINI_PRICE = 25_000;
const skipIfNoDb = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB not reachable" }, fn);

async function seedUser(telegramId, balance) {
  await User.updateOne(
    { telegramId: String(telegramId) },
    { $set: { balance }, $setOnInsert: { telegramId: String(telegramId) } },
    { upsert: true },
  );
}

function purchaseId(userId, suffix = "order") {
  return `test_${userId}_${suffix}`;
}

function lastPurchase(userId) {
  return WalletPurchase.findOne({ telegramId: String(userId) }).sort({ createdAt: -1 });
}

describe("customer wallet purchase flow", () => {
  skipIfNoDb("valid plan uses the server price and sends its fixed traffic/duration to WizardXray", async () => {
    wizardMode = "ok";
    wizardCalls.length = 0;
    await seedUser("4001", 100_000);
    const bot = makeBotStub();

    const result = await orderService(bot, 4001, 4001, MINI, { purchaseId: purchaseId(4001) });

    const user = await User.findOne({ telegramId: "4001" });
    const purchase = await WalletPurchase.findOne({ purchaseId: result.purchaseId });
    const params = new URLSearchParams(wizardCalls[0].body);
    assert.equal(user.balance, 75_000, "exactly the server-side 25,000 toman price is debited");
    assert.equal(user.services.length, 1, "service recorded exactly once");
    assert.equal(user.totalServices, 1);
    assert.ok(user.services[0].username.startsWith("stub_"));
    assert.equal(purchase.status, "completed");
    assert.equal(purchase.amount, MINI_PRICE);
    assert.equal(purchase.days, 7);
    assert.equal(purchase.gig, 5);
    assert.equal(purchase.walletDebitStatus, "finalized");
    assert.equal(params.get("gig"), "5");
    assert.equal(params.get("day"), "7");
    assert.equal(params.get("test"), "0");
    assert.ok(bot.sent.some((entry) => entry.kind === "photo"), "configuration is delivered only after a valid provider response");
    assert.equal(result.service.username, user.services[0].username);
    assert.equal(Object.hasOwn(result, "supplier_cost"), false);
    assert.equal(Object.hasOwn(result.service, "supplier_cost"), false);
    assert.equal(JSON.stringify(result).includes("987654321"), false, "supplier fields never enter the customer result");
  });

  skipIfNoDb("insufficient, zero, and exact wallet balances are handled safely", async () => {
    wizardMode = "ok";
    wizardCalls.length = 0;
    await seedUser("4002", 100);
    await seedUser("4003", 0);
    await seedUser("4004", MINI_PRICE);

    const insufficient = await purchasePlan("4002", MINI, { purchaseId: purchaseId(4002), createService: async () => { throw new Error("must not call provider"); } });
    const zero = await purchasePlan("4003", MINI, { purchaseId: purchaseId(4003), createService: async () => { throw new Error("must not call provider"); } });
    const exact = await purchasePlan("4004", MINI, { purchaseId: purchaseId(4004) });

    assert.equal(insufficient.failure, "insufficient_balance");
    assert.equal(zero.failure, "insufficient_balance");
    assert.equal((await User.findOne({ telegramId: "4002" })).balance, 100);
    assert.equal((await User.findOne({ telegramId: "4003" })).balance, 0);
    assert.equal((await User.findOne({ telegramId: "4004" })).balance, 0, "exact balance is accepted");
    assert.equal((await User.findOne({ telegramId: "4004" })).services.length, 1);
    assert.equal(wizardCalls.length, 1, "only the exactly funded purchase reached the provider");
  });

  skipIfNoDb("invalid plans and client-supplied price/traffic/duration cannot alter checkout", async () => {
    wizardMode = "ok";
    wizardCalls.length = 0;
    await seedUser("4005", 2_000);
    await assert.rejects(
      () => purchasePlan("4005", { id: "test", price: 1, gig: 100, days: 365 }),
      (error) => error.code === "INVALID_PLAN",
    );
    await assert.rejects(
      () => purchasePlan("4005", "not-a-plan", { purchaseId: purchaseId(4005, "bad") }),
      (error) => error.code === "INVALID_PLAN",
    );

    // Extra client fields are not part of the service contract and are ignored.
    const result = await purchasePlan("4005", "test", {
      purchaseId: purchaseId(4005, "trusted-plan"),
      price: 1,
      gig: 100,
      days: 365,
    });
    const params = new URLSearchParams(wizardCalls[0].body);
    const user = await User.findOne({ telegramId: "4005" });
    const purchase = await WalletPurchase.findOne({ purchaseId: result.purchaseId });
    assert.equal(user.balance, 1_000);
    assert.equal(purchase.amount, 1_000);
    assert.equal(purchase.gig, 1);
    assert.equal(purchase.days, 1);
    assert.equal(params.get("gig"), "1");
    assert.equal(params.get("day"), "1");
    assert.equal(wizardCalls.length, 1);
    assert.equal(await WalletPurchase.countDocuments({ telegramId: "4005" }), 1);
  });

  skipIfNoDb("provider insufficient balance/API rejection refunds the wallet exactly once", async () => {
    wizardMode = "insufficient";
    wizardCalls.length = 0;
    await seedUser("4006", 80_000);
    const bot = makeBotStub();
    const result = await orderService(bot, 4006, 4006, MINI, { purchaseId: purchaseId(4006) });
    const purchase = await WalletPurchase.findOne({ purchaseId: result.purchaseId });
    assert.equal((await User.findOne({ telegramId: "4006" })).balance, 80_000);
    assert.equal(purchase.status, "refunded");
    assert.equal(purchase.refundStatus, "completed");
    assert.equal(purchase.refundAmount, MINI_PRICE);
    assert.equal(purchase.refundReason, "PROVIDER_INSUFFICIENT_BALANCE");
    assert.equal(purchase.walletDebitStatus, "refunded");
    assert.ok((await User.findOne({ telegramId: "4006" })).refundedPurchaseIds.includes(purchase.purchaseId));
    assert.match(bot.texts().join("\n"), /به کیف پول شما بازگشت/);

    const replayedRefund = await refundPurchaseReservation(purchase, { reason: "DUPLICATE_REFUND_TEST" });
    assert.equal(replayedRefund.alreadyRefunded, true);
    assert.equal((await User.findOne({ telegramId: "4006" })).balance, 80_000, "a duplicate refund cannot credit twice");
    assert.equal(wizardCalls.length, 1);
  });

  skipIfNoDb("definitive provider API rejection is refunded without leaking raw provider details", async () => {
    wizardMode = "api_error";
    wizardCalls.length = 0;
    await seedUser("4007", MINI_PRICE);
    const result = await purchasePlan("4007", MINI, { purchaseId: purchaseId(4007) });
    const purchase = await WalletPurchase.findOne({ purchaseId: result.purchaseId });
    assert.equal(result.status, "refunded");
    assert.equal((await User.findOne({ telegramId: "4007" })).balance, MINI_PRICE);
    assert.equal(purchase.status, "refunded");
    assert.equal(purchase.errorCode, "PANEL_REJECTED_REQUEST");
    assert.equal(JSON.stringify(result).includes("provider rejected request"), false);
    assert.equal(wizardCalls.length, 1);
  });

  skipIfNoDb("network timeout/ambiguous create results are not replayed and keep funds recoverable", async () => {
    await seedUser("4008", 60_000);
    let providerCalls = 0;
    const timeout = Object.assign(new Error("simulated timeout"), { code: "ECONNABORTED", ambiguous: true });
    const createService = async () => { providerCalls += 1; throw timeout; };
    const id = purchaseId(4008, "timeout");

    const first = await purchasePlan("4008", MINI, { purchaseId: id, createService });
    const replay = await purchasePlan("4008", MINI, { purchaseId: id, createService });
    const purchase = await WalletPurchase.findOne({ purchaseId: id });
    assert.equal(first.status, "manual_review");
    assert.equal(replay.status, "manual_review");
    assert.equal(replay.replayed, true);
    assert.equal(purchase.status, "manual_review");
    assert.equal(purchase.errorCode, "ECONNABORTED");
    assert.equal((await User.findOne({ telegramId: "4008" })).balance, 35_000, "reservation remains traceable and recoverable");
    assert.equal((await User.findOne({ telegramId: "4008" })).services.length, 0);
    assert.equal(providerCalls, 1, "ambiguous service creation is never retried");
  });

  skipIfNoDb("an unavailable WizardXray endpoint does not retry the create mutation", async () => {
    wizardMode = "destroy";
    wizardCalls.length = 0;
    await seedUser("4013", 50_000);
    const id = purchaseId(4013, "unavailable");
    const first = await purchasePlan("4013", MINI, { purchaseId: id });
    const replay = await purchasePlan("4013", MINI, { purchaseId: id });
    const purchase = await WalletPurchase.findOne({ purchaseId: id });
    assert.equal(first.status, "manual_review");
    assert.equal(replay.status, "manual_review");
    assert.equal(purchase.status, "manual_review");
    assert.ok(["ECONNRESET", "ECONNABORTED"].includes(purchase.errorCode));
    assert.equal((await User.findOne({ telegramId: "4013" })).balance, 25_000);
    assert.equal(wizardCalls.length, 1, "a transport failure is not a reason to repeat POST /create");
  });

  skipIfNoDb("malformed provider responses are never fulfilled and are never blindly retried", async () => {
    wizardMode = "malformed";
    wizardCalls.length = 0;
    await seedUser("4009", 50_000);
    const id = purchaseId(4009, "malformed");
    const first = await purchasePlan("4009", MINI, { purchaseId: id });
    const replay = await purchasePlan("4009", MINI, { purchaseId: id });
    const purchase = await WalletPurchase.findOne({ purchaseId: id });
    assert.equal(first.status, "manual_review");
    assert.equal(replay.status, "manual_review");
    assert.equal(purchase.status, "manual_review");
    assert.equal(purchase.errorCode, "INVALID_PROVISIONING_RESPONSE");
    assert.equal(purchase.completedAt, null);
    assert.equal((await User.findOne({ telegramId: "4009" })).services.length, 0);
    assert.equal((await User.findOne({ telegramId: "4009" })).balance, 25_000);
    assert.equal(wizardCalls.length, 1);
  });

  skipIfNoDb("concurrent distinct purchases cannot overdraw; duplicate purchase IDs charge/provision once", async () => {
    wizardMode = "ok";
    wizardCalls.length = 0;
    await seedUser("4010", MINI_PRICE);
    const botA = makeBotStub();
    const botB = makeBotStub();

    await Promise.all([
      orderService(botA, 4010, 4010, MINI, { purchaseId: purchaseId(4010, "concurrent-a") }),
      orderService(botB, 4010, 4010, MINI, { purchaseId: purchaseId(4010, "concurrent-b") }),
    ]);

    let user = await User.findOne({ telegramId: "4010" });
    assert.equal(user.balance, 0, "two concurrent orders cannot make the balance negative");
    assert.ok(user.balance >= 0);
    assert.equal(user.services.length, 1);
    assert.equal(await WalletPurchase.countDocuments({ telegramId: "4010", status: "completed" }), 1);
    assert.equal(wizardCalls.length, 1);

    await seedUser("4011", MINI_PRICE);
    const duplicateId = purchaseId(4011, "duplicate");
    await Promise.all([
      purchasePlan("4011", MINI, { purchaseId: duplicateId }),
      purchasePlan("4011", MINI, { purchaseId: duplicateId }),
    ]);
    user = await User.findOne({ telegramId: "4011" });
    assert.equal(user.balance, 0);
    assert.equal(user.services.length, 1);
    assert.equal(await WalletPurchase.countDocuments({ telegramId: "4011", purchaseId: duplicateId }), 1);
    assert.equal(wizardCalls.length, 2, "only one create call per distinct purchase ID");

    const replay = await purchasePlan("4011", MINI, { purchaseId: duplicateId });
    assert.equal(replay.status, "completed");
    assert.equal(replay.replayed, true);
    assert.equal(wizardCalls.length, 2);
    assert.equal((await User.findOne({ telegramId: "4011" })).services.length, 1);
  });

  skipIfNoDb("purchase status transitions cannot reopen a fulfilled order", async () => {
    wizardMode = "ok";
    await seedUser("4012", MINI_PRICE);
    const result = await purchasePlan("4012", MINI, { purchaseId: purchaseId(4012, "terminal") });
    assert.equal(result.status, "completed");
    assert.equal(isAllowedWalletPurchaseTransition("completed", "reserving"), false);
    assert.equal(isAllowedWalletPurchaseTransition("refunded", "reserved"), false);
    assert.equal(isAllowedWalletPurchaseTransition("provisioned", "completed"), true);
    await assert.rejects(
      () => WalletPurchase.findOneAndUpdate(
        { purchaseId: result.purchaseId, status: "completed" },
        { $set: { status: "reserving" } },
      ),
      /forward-only/,
    );
    await commitProvisionedPurchase(await WalletPurchase.findOne({ purchaseId: result.purchaseId }));
    assert.equal((await User.findOne({ telegramId: "4012" })).services.length, 1);
    assert.equal(await WalletPurchase.countDocuments({ purchaseId: result.purchaseId, status: "completed" }), 1);
  });
});
