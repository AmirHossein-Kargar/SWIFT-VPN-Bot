/**
 * Scenario D — free test subscription through the real createTestService()
 * (eligibility claim, provisioning, duplicate/concurrent requests, ambiguous
 * and failed panel results) and the audited admin eligibility reset.
 */
import createTestService from "../../createTestService.js";
import { resetTestServiceEligibility, testServiceSummary } from "../../admin/users.js";
import { AdminServiceError } from "../../admin/authorization.js";
import { createMockDataset } from "../memoryStore.js";
import { createFakeBot, createFakeWizard, mockId, mockUserId } from "../fakes.js";

const privateMessage = (userId) => ({ chat: { id: Number(userId), type: "private" }, from: { id: Number(userId) }, text: "🎁 سرویس تست" });
const opId = () => mockId("op").replace(/^mock_/, "MOCKOP_");

export const testServiceScenario = Object.freeze({
  id: "trial",
  title: "Test subscription",
  titleFa: "سرویس تست",
  async run(t, { actorId }) {
    if (!actorId) t.block("An authorised admin actor is required for the eligibility-reset checks.");
    const ds = createMockDataset();
    const bot = createFakeBot();
    const panel = createFakeWizard();
    const request = (userId, api = panel) => createTestService(bot, privateMessage(userId), { userModel: ds.users, createApi: api.createTest });

    // ── Eligible user receives exactly one test service
    const eligible = mockUserId(41);
    await ds.users.create({ telegramId: eligible, balance: 12_000 });
    t.check("new user is eligible", testServiceSummary(ds.users.peek({ telegramId: eligible })).eligible === true);
    await request(eligible);
    const issued = ds.users.peek({ telegramId: eligible });
    t.equal("test service is issued", issued.testServiceStatus, "completed");
    t.equal("panel test endpoint called once", panel.testCalls(), 1);
    t.equal("paid-create endpoint is never used for a test", panel.createCalls(), 0);
    t.check("eligibility is consumed", issued.hasReceivedTest === true && testServiceSummary(issued).eligible === false);
    t.equal("one service attached to the owner", issued.services.length, 1);
    t.check("test service carries no paid plan or quota", !issued.services[0].productId && !issued.services[0].trafficGb);
    t.equal("wallet balance unchanged by a test service", issued.balance, 12_000);
    t.equal("no wallet reservation or purchase ledger row", issued.appliedPurchaseReservations.length + ds.purchases.rows.length, 0);
    t.equal("link delivered to the owner once", bot.to(eligible).filter((call) => call.method === "sendPhoto").length, 1);

    // ── Duplicate and concurrent requests
    await request(eligible);
    t.equal("a repeated request does not provision again", panel.testCalls(), 1);
    t.check("repeat request is told it already received one", bot.textsTo(eligible).some((text) => text.includes("قبلاً")));

    const racer = mockUserId(42);
    await ds.users.create({ telegramId: racer });
    await Promise.all(Array.from({ length: 4 }, () => request(racer)));
    t.equal("4 concurrent requests provision once", panel.testCalls(), 2);
    t.equal("concurrent requests attach one service", ds.users.peek({ telegramId: racer }).services.length, 1);

    // ── Ineligible user
    const ineligible = mockUserId(43);
    await ds.users.create({ telegramId: ineligible, hasReceivedTest: true, testServiceStatus: "completed" });
    await request(ineligible);
    t.equal("ineligible user never reaches the panel", panel.testCalls(), 2);
    t.equal("ineligible user receives nothing", ds.users.peek({ telegramId: ineligible }).services.length, 0);

    // ── Ambiguous panel result is held, never retried
    const ambiguousPanel = createFakeWizard(["timeout"]);
    const held = mockUserId(44);
    await ds.users.create({ telegramId: held });
    await request(held, ambiguousPanel);
    t.equal("ambiguous result is held for manual review", ds.users.peek({ telegramId: held }).testServiceStatus, "manual_review");
    await request(held, ambiguousPanel);
    t.equal("held request is not retried", ambiguousPanel.testCalls(), 1);
    await t.rejects("eligibility reset is refused while a request is under review",
      () => resetTestServiceEligibility({ actorId, operationId: opId(), telegramId: held, reason: "mock reset during review", userModel: ds.users, auditModel: ds.audit }),
      (error) => error instanceof AdminServiceError && error.code === "test_service_in_progress");

    // ── Definitive panel failure restores eligibility
    const rejectingPanel = createFakeWizard(["reject"]);
    const unlucky = mockUserId(45);
    await ds.users.create({ telegramId: unlucky });
    await request(unlucky, rejectingPanel);
    const afterFailure = ds.users.peek({ telegramId: unlucky });
    t.check("definitive failure keeps the user eligible", afterFailure.testServiceStatus === "failed" && afterFailure.hasReceivedTest === false);
    await request(unlucky, rejectingPanel);
    t.equal("user can retry after a definitive failure", ds.users.peek({ telegramId: unlucky }).testServiceStatus, "completed");

    // ── Admin eligibility reset (audited, never provisions)
    const callsBeforeReset = panel.testCalls();
    const reset = await resetTestServiceEligibility({ actorId, operationId: opId(), telegramId: eligible, reason: "mock eligibility reset", userModel: ds.users, auditModel: ds.audit });
    t.check("reset restores eligibility", reset?.eligible === true && testServiceSummary(ds.users.peek({ telegramId: eligible })).eligible === true);
    t.equal("reset itself never provisions a service", panel.testCalls(), callsBeforeReset);
    t.equal("reset keeps the previously issued service", ds.users.peek({ telegramId: eligible }).services.length, 1);
    await request(eligible);
    t.equal("user can receive one more test after reset", ds.users.peek({ telegramId: eligible }).services.length, 2);
    await t.rejects("a non-admin cannot reset eligibility",
      () => resetTestServiceEligibility({ actorId: "1", operationId: opId(), telegramId: eligible, reason: "not allowed", userModel: ds.users, auditModel: ds.audit }),
      (error) => error instanceof AdminServiceError && error.status === 403);
    const pending = mockUserId(46);
    await ds.users.create({ telegramId: pending, hasReceivedTest: true, testServiceStatus: "completed", testServiceNotificationPending: true });
    await t.rejects("reset is refused while the previous link is undelivered",
      () => resetTestServiceEligibility({ actorId, operationId: opId(), telegramId: pending, reason: "mock reset with pending link", userModel: ds.users, auditModel: ds.audit }),
      (error) => error instanceof AdminServiceError && error.code === "test_service_delivery_pending");
    t.equal("resets are audited", ds.audit.snapshot({ action: "USER_TEST_ELIGIBILITY_RESET", status: "succeeded" }).length, 1);

    t.skip("test-service expiry", "The 1-day expiry is enforced by the WizardXray panel; the bot stores no local expiry for test services, so it cannot be verified in mock mode.");
    t.note("Test services were issued by a fake WizardXray adapter; no real subscription was created.");
  },
});

export default testServiceScenario;
