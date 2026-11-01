import { test, describe, after } from "node:test";
import { useShippedCatalog, resetCatalog } from "../helpers/shippedCatalog.js";
import assert from "node:assert/strict";
import { makeFakeWalletModels } from "../helpers/fakeWalletModels.js";
import { makeBotStub } from "../helpers/db.js";
import handleBuyService from "../../services/buyService/buyService.js";
import handleCallbackQuery from "../../handlers/handleCallbackQuery.js";
import { getCustomerPlans, getCustomerPlanById, getInternalPlanCatalog } from "../../services/plans.js";
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
      subscriptionUrl: "https://panel.example.test/sub/unit-hash_123",
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

  test("provider insufficient-balance refusal keeps the debit as a reservation (awaiting_provider), not a refund", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7006", balance: 50_000 }]);
    let providerCalls = 0;
    const shortage = Object.assign(new Error("supplier cost must not be exposed"), {
      code: "provider_insufficient_balance",
      ambiguous: false,
    });
    const options = serviceOptions(models, {
      purchaseId: "unit-provider-short",
      createService: async () => { providerCalls += 1; throw shortage; },
    });
    const first = await purchasePlan("7006", "mini", options);
    const replay = await purchasePlan("7006", "mini", options);
    const purchase = models.purchases.get("unit-provider-short");

    assert.equal(first.status, "awaiting_provider");
    assert.equal(first.failure, "awaiting_provider_funds");
    assert.equal(replay.status, "awaiting_provider");
    assert.equal(replay.replayed, true);
    assert.equal(models.users.get("7006").balance, 25_000, "debited once, not refunded");
    assert.deepEqual(models.users.get("7006").appliedPurchaseReservations, ["unit-provider-short"]);
    assert.deepEqual(models.users.get("7006").refundedPurchaseIds, []);
    assert.equal(purchase.refundStatus, "none");
    assert.equal(purchase.walletDebitStatus, "reserved");
    assert.equal(purchase.adminAlertPending, true, "admin alert is persisted in the outbox");
    assert.equal(purchase.events.at(-1).to, "awaiting_provider");
    assert.equal(providerCalls, 1);
    assert.equal(JSON.stringify(first).includes("supplier cost"), false);
  });

  test("other explicit provider refusals still refund exactly once", async () => {
    const models = makeFakeWalletModels([{ telegramId: "7016", balance: 50_000 }]);
    const reject = Object.assign(new Error("refused"), { code: "panel_rejected_request", ambiguous: false });
    const options = serviceOptions(models, {
      purchaseId: "unit-provider-refund",
      createService: async () => { throw reject; },
    });
    const first = await purchasePlan("7016", "mini", options);
    const replay = await purchasePlan("7016", "mini", options);
    assert.equal(first.status, "refunded");
    assert.equal(replay.status, "refunded");
    assert.equal(models.users.get("7016").balance, 50_000);
    assert.deepEqual(models.users.get("7016").refundedPurchaseIds, ["unit-provider-refund"]);
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

  test("preserves selected subscription duration (30, 90, 180, 365 days) through order, ledger, and VPN provisioning", async () => {
    const fixedNow = new Date("2026-10-18T12:00:00.000Z");
    for (const durationDays of [30, 90, 180, 365]) {
      const plansForDuration = getCustomerPlans({ durationDays });
      const selectedPlan = plansForDuration.find((p) => p.gig === 50);
      assert.ok(selectedPlan, `expected 50 GB plan for ${durationDays} days`);
      assert.equal(selectedPlan.days, durationDays);

      const userId = `800${durationDays}`;
      const purchaseId = `unit-dur-${durationDays}`;
      const models = makeFakeWalletModels([{ telegramId: userId, balance: 1_000_000 }]);
      let provisionedArgs = null;

      const result = await purchasePlan(userId, selectedPlan.id, serviceOptions(models, {
        purchaseId,
        now: () => fixedNow,
        createService: async (...args) => {
          provisionedArgs = args;
          return validProviderResponse({ username: `vpn_${durationDays}d` });
        },
      }));

      assert.equal(result.status, "completed");
      assert.equal(result.plan.days, durationDays, `${durationDays}-day plan must retain duration`);
      assert.equal(result.plan.gig, 50);
      assert.equal(result.plan.price, selectedPlan.price);
      assert.deepEqual(provisionedArgs, [50, durationDays, 0], `WizardXray must receive exact duration=${durationDays}`);

      const purchase = models.purchases.get(purchaseId);
      assert.equal(purchase.days, durationDays);
      assert.equal(purchase.gig, 50);
      assert.equal(purchase.amount, selectedPlan.price);
      assert.equal(purchase.planId, selectedPlan.id);

      const elapsedDays = Math.round((purchase.expiresAt.getTime() - purchase.provisionedAt.getTime()) / 86_400_000);
      assert.equal(elapsedDays, durationDays);

      const user = models.users.get(userId);
      assert.equal(user.balance, 1_000_000 - selectedPlan.price);
      assert.equal(user.services.length, 1);
      assert.equal(user.services[0].expiresAt.getTime(), purchase.expiresAt.getTime());
      assert.equal(user.services[0].trafficGb, 50);
      assert.equal(user.services[0].productId, selectedPlan.id);
    }
  });
});

describe("Telegram subscription duration selection UI and navigation", () => {
  function makeQuery(data, chatId = 99001, messageId = 42) {
    return {
      id: `cb_${Math.random().toString(36).slice(2)}`,
      from: { id: chatId },
      message: { chat: { id: chatId, type: "private" }, message_id: messageId },
      data,
    };
  }

  test("Buy Service displays the four Persian duration buttons (30, 90, 180, 365 days) and Back button", async () => {
    const bot = makeBotStub();
    await handleBuyService(bot, 99001);

    assert.equal(bot.sent.length, 1);
    const msg = bot.sent[0];
    assert.equal(msg.kind, "message");
    assert.match(msg.text, /مدت زمان اشتراک/);

    const rows = msg.opts.reply_markup.inline_keyboard;
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.slice(0, 4).map((row) => [row[0].text, row[0].callback_data]),
      [
        ["🗓️ یک‌ماهه", "duration_30"],
        ["🗓️ سه‌ماهه", "duration_90"],
        ["🗓️ شش‌ماهه", "duration_180"],
        ["🗓️ یک‌ساله", "duration_365"],
      ],
    );
    assert.deepEqual(rows[4], [{ text: "🔙 بازگشت", callback_data: "buy_service_back_to_main" }]);
    for (const row of rows) {
      for (const btn of row) {
        assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64);
      }
    }
  });

  test("selecting each of the four durations displays compatible plans, selling prices, confirmation, and never leaks cost or profit", async (t) => {
    useShippedCatalog(); // no MongoDB here: authorization uses an empty injected catalog = shipped plans
    t.after(resetCatalog);
    for (const durationDays of [30, 90, 180, 365]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, makeQuery(`duration_${durationDays}`));

      const editMsg = bot.sent.find((e) => e.kind === "edit");
      assert.ok(editMsg, `duration_${durationDays} must edit message with plans`);
      assert.match(editMsg.text, /پلن‌های اختصاصی SWIFT VPN/);
      assert.match(editMsg.text, new RegExp(`${durationDays} روز`));

      const rows = editMsg.opts.reply_markup.inline_keyboard;
      const expectedPlans = getCustomerPlans({ durationDays });
      const internalPlans = getInternalPlanCatalog({ durationDays });
      assert.equal(rows.length, expectedPlans.length + 1);

      expectedPlans.forEach((plan, idx) => {
        const internalPlan = internalPlans[idx];
        const btn = rows[idx][0];
        assert.equal(btn.callback_data, `plan_${plan.id}`);
        assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64);
        assert.equal(btn.text, `⁦🔹 ${plan.gig} GB | ${plan.price.toLocaleString("en-US")} تومان⁩`);
        assert.doesNotMatch(editMsg.text, /گیگابایت —/, "the plan list must appear only as keyboard buttons");
        assert.equal(editMsg.text.includes(plan.price.toLocaleString("en-US")), false);

        // Strict customer-facing rule: internal purchaseCost and profit must NEVER appear for this plan
        const costFormatted = internalPlan.purchaseCost.toLocaleString("en-US");
        const profitFormatted = internalPlan.profit.toLocaleString("en-US");
        assert.equal(btn.text.includes(costFormatted), false);
        assert.equal(btn.text.includes(profitFormatted), false);
        assert.doesNotMatch(editMsg.text, /سود|قیمت خرید|purchaseCost|profit|margin/i);
      });

      const backBtn = rows[rows.length - 1][0];
      assert.deepEqual(backBtn, { text: "🔙 بازگشت", callback_data: "buy_service_back" });

      // Select one of the plans and verify confirmation screen preserves duration and price without leaking cost/profit
      const chosenPlan = expectedPlans.find((p) => p.gig === 100);
      const chosenInternal = internalPlans.find((p) => p.gig === 100);
      const confirmBot = makeBotStub();
      await handleCallbackQuery(confirmBot, makeQuery(`plan_${chosenPlan.id}`));
      const confirmEdit = confirmBot.sent.find((e) => e.kind === "edit");
      assert.ok(confirmEdit);
      assert.match(confirmEdit.text, new RegExp(`${durationDays} روز`));
      assert.match(confirmEdit.text, new RegExp(`${chosenPlan.gig} گیگ`));
      assert.match(confirmEdit.text, new RegExp(`${chosenPlan.price.toLocaleString("en-US")} تومان`));
      assert.equal(confirmEdit.text.includes(chosenInternal.purchaseCost.toLocaleString("en-US")), false);
      assert.equal(confirmEdit.text.includes(chosenInternal.profit.toLocaleString("en-US")), false);

      const confirmRows = confirmEdit.opts.reply_markup.inline_keyboard;
      assert.equal(confirmRows[0][0].callback_data, `confirm_order_${chosenPlan.id}`);
      assert.ok(Buffer.byteLength(confirmRows[0][0].callback_data, "utf8") <= 64);
      assert.deepEqual(confirmRows[1][0], { text: "🔙 بازگشت", callback_data: "buy_service_back" });
    }

    // Verify back navigation returns to the 4-duration menu
    const backBot = makeBotStub();
    await handleCallbackQuery(backBot, makeQuery("buy_service_back"));
    const durationMenuMsg = backBot.sent.find((e) => e.kind === "edit" || e.kind === "message");
    assert.ok(durationMenuMsg);
    const durationCallbacks = durationMenuMsg.opts.reply_markup.inline_keyboard.map((r) => r[0].callback_data);
    assert.deepEqual(durationCallbacks, [
      "duration_30",
      "duration_90",
      "duration_180",
      "duration_365",
      "buy_service_back_to_main",
    ]);

    // Verify invalid callbacks are rejected safely
    for (const invalidDuration of ["duration_abc", "duration_0", "duration_-5", "duration_0x1e", "duration_30;drop"]) {
      const invalidBot = makeBotStub();
      await handleCallbackQuery(invalidBot, makeQuery(invalidDuration));
      assert.ok(invalidBot.sent.some((e) => /مدت زمان نامعتبر/.test(String(e.opts?.text || e.text || ""))));
    }
    for (const unsupportedDuration of ["duration_45", "duration_60"]) {
      const unsupportedBot = makeBotStub();
      await handleCallbackQuery(unsupportedBot, makeQuery(unsupportedDuration));
      assert.ok(unsupportedBot.sent.some((e) => /پلن فعالی برای این مدت زمان موجود نیست/.test(String(e.text || ""))));
    }
    for (const invalidPlan of ["plan_unknown", "plan_s90_10", "plan_mini_90"]) {
      const invalidPlanBot = makeBotStub();
      await handleCallbackQuery(invalidPlanBot, makeQuery(invalidPlan));
      assert.ok(invalidPlanBot.sent.some((e) => /این پلن در حال حاضر فعال نیست/.test(String(e.text || ""))));
    }
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
