import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";
import { telegramPurchaseId } from "../../services/buyService/orderService.js";
import { purchasePlan, PurchaseServiceError } from "../../services/buyService/purchaseService.js";
import WalletPurchase, { isAllowedWalletPurchaseTransition } from "../../models/WalletPurchase.js";

function validProviderResponse(overrides = {}) {
  return {
    ok: true,
    result: {
      username: "unit_service_1",
      hash: "unit-hash_123",
      sub_link: "https://panel.example.test/sub/unit-hash_123",
      tak_links: ["vless://unit@example.test:443"],
      supplier_cost: 987_654_321,
      ...overrides,
    },
  };
}

function serviceOptions(models, extra = {}) {
  return { userModel: models.userModel, purchaseModel: models.purchaseModel, ...extra };
}

test("Telegram confirmation retries derive the same purchase ID", () => {
  const context = { chatId: 123, userId: 123, messageId: 77, planId: "mini" };
  const first = telegramPurchaseId(context);
  assert.equal(first, telegramPurchaseId({ ...context }));
  assert.match(first, /^tg_[a-f0-9]{64}$/);
  assert.notEqual(first, telegramPurchaseId({ ...context, messageId: 78 }));
  assert.notEqual(first, telegramPurchaseId({ ...context, planId: "basic" }));
  assert.equal(telegramPurchaseId({ chatId: 1, userId: 1, planId: "mini" }), null);
});

describe("purchaseService.purchasePlan", () => {
  test("resolves the customer plan on the server, charges once, and returns only whitelisted service data", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7001", balance: 30_000 }]);
    let providerArguments;
    const result = await purchasePlan("7001", "mini", serviceOptions(models, {
      purchaseId: "unit-valid-plan",
      createService: async (...args) => {
        providerArguments = args;
        return validProviderResponse();
      },
      price: 1,
      gig: 100,
      days: 365,
    }));

    assert.equal(result.status, "completed");
    assert.deepEqual(result.plan, { id: "mini", name: "Mini", days: 7, gig: 5, price: 25_000 });
    assert.deepEqual(providerArguments, [5, 7, 0]);
    assert.equal(models.users.get("7001").balance, 5_000);
    assert.equal(models.users.get("7001").services.length, 1);
    assert.equal(models.purchases.get("unit-valid-plan").amount, 25_000);
    assert.equal(models.purchases.get("unit-valid-plan").gig, 5);
    assert.equal(models.purchases.get("unit-valid-plan").days, 7);
    assert.equal(models.purchases.get("unit-valid-plan").walletDebitStatus, "finalized");
    assert.deepEqual(result.service, {
      username: "unit_service_1",
      subscriptionUrl: "https://iranisystem.com/bot/sub/?hash=unit-hash_123",
      singleLink: "vless://unit@example.test:443",
      expiresAt: models.purchases.get("unit-valid-plan").expiresAt,
    });
    assert.equal(JSON.stringify(result).includes("987654321"), false);
    assert.equal(Object.hasOwn(models.purchases.get("unit-valid-plan"), "supplier_cost"), false);
  });

  test("rejects invalid plan IDs and plan objects before creating an intent", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7002", balance: 100_000 }]);
    let providerCalls = 0;
    const options = serviceOptions(models, { purchaseId: "unit-invalid-plan", createService: async () => { providerCalls += 1; return validProviderResponse(); } });
    await assert.rejects(
      () => purchasePlan("7002", { id: "mini", price: 1, gig: 100, days: 365 }, options),
      (error) => error instanceof PurchaseServiceError && error.code === "INVALID_PLAN",
    );
    await assert.rejects(
      () => purchasePlan("7002", "plan30_10", options),
      (error) => error.code === "INVALID_PLAN",
    );
    assert.equal(models.purchases.size, 0);
    assert.equal(models.users.get("7002").balance, 100_000);
    assert.equal(providerCalls, 0);
  });

  test("insufficient, zero, and exact balances respect the atomic reservation contract", async () => {
    for (const [telegramId, balance, expected] of [
      ["7003", 24_999, "insufficient_balance"],
      ["7004", 0, "insufficient_balance"],
      ["7005", 25_000, null],
    ]) {
      const models = makeFakeWalletModels([{ telegramId, balance }]);
      let providerCalls = 0;
      const result = await purchasePlan(telegramId, "mini", serviceOptions(models, {
        purchaseId: `unit-balance-${telegramId}`,
        createService: async () => { providerCalls += 1; return validProviderResponse(); },
      }));
      assert.equal(result.failure, expected);
      assert.ok(models.users.get(telegramId).balance >= 0);
      assert.equal(providerCalls, expected ? 0 : 1);
      assert.equal(models.users.get(telegramId).balance, expected ? balance : 0);
    }
  });

  test("explicit provider insufficient-balance rejection refunds exactly once", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7006", balance: 50_000 }]);
    let providerCalls = 0;
    const reject = Object.assign(new Error("supplier cost must not be exposed"), {
      code: "provider_insufficient_balance",
      ambiguous: false,
    });
    const options = serviceOptions(models, {
      purchaseId: "unit-provider-refund",
      createService: async () => { providerCalls += 1; throw reject; },
    });
    const first = await purchasePlan("7006", "mini", options);
    const replay = await purchasePlan("7006", "mini", options);
    const purchase = models.purchases.get("unit-provider-refund");

    assert.equal(first.status, "refunded");
    assert.equal(first.failure, "provider_rejected_refunded");
    assert.equal(replay.status, "refunded");
    assert.equal(replay.replayed, true);
    assert.equal(models.users.get("7006").balance, 50_000);
    assert.deepEqual(models.users.get("7006").refundedPurchaseIds, ["unit-provider-refund"]);
    assert.equal(purchase.refundStatus, "completed");
    assert.equal(purchase.refundAmount, 25_000);
    assert.equal(purchase.refundReason, "PROVIDER_INSUFFICIENT_BALANCE");
    assert.equal(providerCalls, 1);
    assert.equal(JSON.stringify(first).includes("supplier cost"), false);
  });

  test("ambiguous timeout and malformed response are held and never replayed", async () => {
    for (const [telegramId, id, createService, expectedCode] of [
      ["7007", "unit-timeout", async () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED", ambiguous: true }); }, "ECONNABORTED"],
      ["7008", "unit-malformed", async () => validProviderResponse({ username: "bad username", hash: "" }), "INVALID_PROVIDER_RESPONSE"],
    ]) {
      const models = makeFakeWalletModels([{ telegramId, balance: 50_000 }]);
      let providerCalls = 0;
      const originalCreate = createService;
      const countedCreate = async (...args) => { providerCalls += 1; return originalCreate(...args); };
      const options = serviceOptions(models, { purchaseId: id, createService: countedCreate });
      const first = await purchasePlan(telegramId, "mini", options);
      const replay = await purchasePlan(telegramId, "mini", options);
      assert.equal(first.status, "manual_review");
      assert.equal(replay.status, "manual_review");
      assert.equal(replay.replayed, true);
      assert.equal(models.purchases.get(id).errorCode, expectedCode);
      assert.equal(models.users.get(telegramId).balance, 25_000);
      assert.equal(models.users.get(telegramId).services.length, 0);
      assert.equal(providerCalls, 1);
    }
  });

  test("concurrent intents cannot overspend and repeated purchase IDs fulfill once", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7009", balance: 25_000 }]);
    let providerCalls = 0;
    const createService = async () => {
      providerCalls += 1;
      await Promise.resolve();
      return validProviderResponse();
    };
    const [first, second] = await Promise.all([
      purchasePlan("7009", "mini", serviceOptions(models, { purchaseId: "unit-concurrent-a", createService })),
      purchasePlan("7009", "mini", serviceOptions(models, { purchaseId: "unit-concurrent-b", createService })),
    ]);
    assert.equal(models.users.get("7009").balance, 0);
    assert.equal(models.users.get("7009").services.length, 1);
    assert.equal([first, second].filter((result) => result.status === "completed").length, 1);
    assert.equal(providerCalls, 1);

    const duplicateModels = makeFakeWalletModels([{ telegramId: "7010", balance: 25_000 }]);
    let duplicateProviderCalls = 0;
    const duplicateOptions = serviceOptions(duplicateModels, {
      purchaseId: "unit-same-id",
      createService: async () => { duplicateProviderCalls += 1; return validProviderResponse(); },
    });
    const [dupeOne, dupeTwo] = await Promise.all([
      purchasePlan("7010", "mini", duplicateOptions),
      purchasePlan("7010", "mini", duplicateOptions),
    ]);
    const replay = await purchasePlan("7010", "mini", duplicateOptions);
    assert.equal(duplicateModels.purchases.size, 1);
    assert.equal(duplicateModels.users.get("7010").balance, 0);
    assert.equal(duplicateModels.users.get("7010").services.length, 1);
    assert.equal(duplicateProviderCalls, 1);
    assert.ok([dupeOne, dupeTwo, replay].some((result) => result.replayed));
  });

  test("purchase IDs cannot be reused across a different user or plan", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7011", balance: 25_000 }, { telegramId: "7012", balance: 25_000 }]);
    const options = serviceOptions(models, { purchaseId: "unit-id-conflict", createService: async () => validProviderResponse() });
    await purchasePlan("7011", "mini", options);
    await assert.rejects(
      () => purchasePlan("7012", "mini", options),
      (error) => error.code === "PURCHASE_ID_CONFLICT",
    );
    await assert.rejects(
      () => purchasePlan("7011", "test", options),
      (error) => error.code === "PURCHASE_ID_CONFLICT",
    );
  });
});

test("wallet purchase state machine is forward-only", async () => {
  assert.equal(isAllowedWalletPurchaseTransition("completed", "reserving"), false);
  assert.equal(isAllowedWalletPurchaseTransition("refunded", "reserved"), false);
  assert.equal(isAllowedWalletPurchaseTransition("provisioned", "completed"), true);
  assert.equal(isAllowedWalletPurchaseTransition("refund_pending", "refunded"), true);
  await assert.rejects(
    () => WalletPurchase.findOneAndUpdate(
      { purchaseId: "unit-terminal-state", status: "completed" },
      { $set: { status: "reserving" } },
    ),
    /forward-only/,
  );
});
