/**
 * Scenario A — VPN subscription purchase through the real purchasePlan()
 * (catalog lookup, atomic wallet reservation, provisioning, commit, refund,
 * ambiguous-result handling) against an in-memory ledger and a fake panel.
 */
import { getCustomerDurations, getCustomerPlanById, getCustomerPlans } from "../../plans.js";
import { purchasePlan, PurchaseServiceError } from "../../buyService/purchaseService.js";
import { createMockDataset } from "../memoryStore.js";
import { createFakeWizard, mockId, mockUserId } from "../fakes.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const purchaseScenario = Object.freeze({
  id: "purchase",
  title: "VPN subscription purchase",
  titleFa: "خرید اشتراک VPN",
  async run(t) {
    // ── Catalog (the same source of truth the Telegram shop and storefront use)
    const plans = getCustomerPlans();
    t.check("catalog lists at least one plan", plans.length > 0, `found ${plans.length}`);
    t.check("customer catalog never exposes purchaseCost/profit",
      plans.every((plan) => !Object.hasOwn(plan, "purchaseCost") && !Object.hasOwn(plan, "profit")));
    t.check("every plan has positive integer price, traffic and duration",
      plans.every((plan) => [plan.price, plan.gig, plan.days].every((value) => Number.isSafeInteger(value) && value > 0)));
    const durations = getCustomerDurations();
    t.check("every supported duration has purchasable plans",
      durations.length > 0 && durations.every((days) => getCustomerPlans({ durationDays: days }).length > 0),
      `durations ${durations.join(",")}`);
    if (!plans.length) t.block("The customer catalog is empty; there is nothing to purchase.");

    const plan = getCustomerPlanById(plans[0].id);
    t.check("plan lookup by ID returns the catalog price", plan?.price === plans[0].price);

    const ds = createMockDataset();
    const wizard = createFakeWizard();
    const deps = { userModel: ds.users, purchaseModel: ds.purchases, createService: wizard.create };
    for (const badId of ["", "s30_999999", "../etc", "S30_10", "x".repeat(40), "s30_10;drop"]) {
      await t.rejects(`invalid plan ID ${JSON.stringify(badId.slice(0, 16))} is refused`,
        () => purchasePlan(mockUserId(1), badId, { purchaseId: mockId("bad"), ...deps }),
        (error) => error instanceof PurchaseServiceError && error.code === "INVALID_PLAN");
    }
    t.equal("invalid plans never reach the panel or the ledger", wizard.createCalls() + ds.purchases.rows.length, 0);

    // ── Happy path: reserve → provision → commit
    const buyer = mockUserId(11);
    const startBalance = plan.price * 3 + 7;
    await ds.users.create({ telegramId: buyer, balance: startBalance });

    const purchaseId = mockId("buy");
    const result = await purchasePlan(buyer, plan.id, { purchaseId, ...deps });
    t.equal("order completes", result.status, "completed");
    t.equal("panel create called exactly once", wizard.createCalls(), 1);
    t.check("panel received the catalog traffic/duration (not client values)",
      wizard.calls[0]?.args[0] === plan.gig && wizard.calls[0]?.args[1] === plan.days && wizard.calls[0]?.args[2] === 0);
    const order = ds.purchases.peek({ purchaseId });
    t.equal("order amount is the server-side price", order?.amount, plan.price);
    t.equal("order is owned by the buyer", order?.telegramId, buyer);
    t.equal("wallet debit is finalized", order?.walletDebitStatus, "finalized");
    t.check("order records quota and duration", order?.gig === plan.gig && order?.days === plan.days);
    const provisionedMs = order?.provisionedAt ? new Date(order.provisionedAt).getTime() : NaN;
    t.equal("expiry = provisioning time + plan days", new Date(order?.expiresAt).getTime() - provisionedMs, plan.days * DAY_MS);
    const owner = ds.users.peek({ telegramId: buyer });
    t.equal("wallet debited exactly the plan price", owner.balance, startBalance - plan.price);
    t.equal("service attached to the buyer once", owner.services.filter((service) => service.purchaseId === purchaseId).length, 1);
    t.check("stored service carries the plan quota", owner.services[0]?.trafficGb === plan.gig && owner.services[0]?.productId === plan.id);
    t.check("customer result exposes service details only after commit", Boolean(result.service?.username) && result.service.username === order?.serviceUsername);

    // ── Duplicate callback (replayed Telegram button) and concurrent duplicates
    const replay = await purchasePlan(buyer, plan.id, { purchaseId, ...deps });
    t.check("replayed callback is reported as a replay", replay.replayed === true && replay.status === "completed");
    t.equal("replay did not call the panel again", wizard.createCalls(), 1);
    t.equal("replay did not debit again", ds.users.peek({ telegramId: buyer }).balance, startBalance - plan.price);

    const racingId = mockId("race");
    const racing = await Promise.all(Array.from({ length: 5 }, () => purchasePlan(buyer, plan.id, { purchaseId: racingId, ...deps }).catch((error) => ({ error }))));
    t.equal("5 concurrent identical requests provision once", wizard.createCalls(), 2);
    t.equal("5 concurrent identical requests debit once", ds.users.peek({ telegramId: buyer }).balance, startBalance - 2 * plan.price);
    t.check("concurrent duplicates never error out", racing.every((entry) => !entry.error));
    t.equal("one ledger row per purchase ID", ds.purchases.snapshot({ purchaseId: racingId }).length, 1);

    await t.rejects("a purchase ID cannot be reused by another user",
      async () => {
        const other = mockUserId(12);
        await ds.users.create({ telegramId: other, balance: plan.price * 2 });
        await purchasePlan(other, plan.id, { purchaseId, ...deps });
      },
      (error) => error instanceof PurchaseServiceError && error.code === "PURCHASE_ID_CONFLICT");

    // ── Insufficient balance
    const poor = mockUserId(13);
    await ds.users.create({ telegramId: poor, balance: plan.price - 1 });
    const callsBefore = wizard.createCalls();
    const poorResult = await purchasePlan(poor, plan.id, { purchaseId: mockId("poor"), ...deps });
    t.equal("insufficient balance is reported", poorResult.failure, "insufficient_balance");
    t.equal("insufficient balance never reaches the panel", wizard.createCalls(), callsBefore);
    t.equal("insufficient balance leaves the wallet untouched", ds.users.peek({ telegramId: poor }).balance, plan.price - 1);

    // ── Definitive provider rejection → exactly-once refund
    const rejectWizard = createFakeWizard(["reject"]);
    const rejected = mockUserId(14);
    await ds.users.create({ telegramId: rejected, balance: plan.price });
    const rejectId = mockId("reject");
    const rejectDeps = { ...deps, createService: rejectWizard.create };
    const rejectResult = await purchasePlan(rejected, plan.id, { purchaseId: rejectId, ...rejectDeps });
    t.equal("provider rejection refunds the order", rejectResult.status, "refunded");
    t.equal("refund restores the full price", ds.users.peek({ telegramId: rejected }).balance, plan.price);
    t.check("refund is recorded in the idempotency ledger", ds.users.peek({ telegramId: rejected }).refundedPurchaseIds.includes(rejectId));
    const rejectReplay = await purchasePlan(rejected, plan.id, { purchaseId: rejectId, ...rejectDeps });
    t.check("retrying a refunded order is a replay", rejectReplay.replayed === true && rejectReplay.status === "refunded");
    t.equal("retry does not refund twice", ds.users.peek({ telegramId: rejected }).balance, plan.price);
    t.equal("retry does not re-call the panel", rejectWizard.createCalls(), 1);
    t.equal("rejected order adds no service", ds.users.peek({ telegramId: rejected }).services.length, 0);

    // ── Ambiguous provider results are never replayed or auto-refunded
    for (const mode of ["timeout", "malformed"]) {
      const ambiguousWizard = createFakeWizard([mode]);
      const user = mockUserId(mode === "timeout" ? 15 : 16);
      await ds.users.create({ telegramId: user, balance: plan.price });
      const id = mockId(mode);
      const outcome = await purchasePlan(user, plan.id, { purchaseId: id, ...deps, createService: ambiguousWizard.create });
      t.equal(`${mode}: order is held for manual review`, outcome.status, "manual_review");
      t.equal(`${mode}: customer is told the outcome is unknown`, outcome.failure, "provider_outcome_unknown");
      t.equal(`${mode}: funds stay reserved (no silent refund)`, ds.users.peek({ telegramId: user }).balance, 0);
      t.equal(`${mode}: recovery is flagged`, ds.purchases.peek({ purchaseId: id })?.recoveryStatus, "required");
      await purchasePlan(user, plan.id, { purchaseId: id, ...deps, createService: ambiguousWizard.create });
      t.equal(`${mode}: retry never replays the panel request`, ambiguousWizard.createCalls(), 1);
    }

    // ── Failed database write after provisioning (crash window)
    let failCommit = true;
    const faulty = createMockDataset({
      faults: {
        users: {
          failNext: (operation, filter) => {
            if (failCommit && operation === "findOneAndUpdate" && filter?.["services.purchaseId"]) {
              failCommit = false;
              const error = new Error("mock write failure");
              error.name = "MongoNetworkError";
              return error;
            }
            return null;
          },
        },
      },
    });
    const commitWizard = createFakeWizard();
    const crashUser = mockUserId(17);
    await faulty.users.create({ telegramId: crashUser, balance: plan.price });
    const crashId = mockId("crash");
    const crash = await purchasePlan(crashUser, plan.id, { purchaseId: crashId, userModel: faulty.users, purchaseModel: faulty.purchases, createService: commitWizard.create });
    t.equal("failed commit write is reported as pending fulfillment", crash.failure, "fulfillment_pending");
    const crashOrder = faulty.purchases.peek({ purchaseId: crashId });
    t.check("provisioned service is durably recorded for recovery", crashOrder?.status === "provisioned" && Boolean(crashOrder?.serviceUsername));
    t.equal("failed commit write flags recovery", crashOrder?.recoveryStatus, "required");
    t.equal("failed commit write never refunds a provisioned service", faulty.users.peek({ telegramId: crashUser }).balance, 0);
    t.equal("failed commit write made exactly one panel call", commitWizard.createCalls(), 1);
    t.note(`Plan exercised: ${plan.id} (${plan.gig} GB / ${plan.days} days / ${plan.price} Toman). Provisioning used a fake WizardXray adapter; no real subscription was created.`);
  },
});

export default purchaseScenario;
