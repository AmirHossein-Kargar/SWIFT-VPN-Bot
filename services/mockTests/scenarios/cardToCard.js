/**
 * Scenario C — card-to-card top-ups.
 *   1. HooshPay online card-to-card: invoice creation, signed webhook
 *      verification, paid-detail validation and two-phase idempotent credit.
 *   2. Manual bank receipt review: admin approve / reject / duplicate approval
 *      with the audited admin services.
 * Every wallet, invoice and audit row lives in the in-memory dataset; a mock
 * approval can never credit a real user.
 */
import { createHooshInvoice } from "../../hooshpay/createHooshInvoice.js";
import { verifyHooshPaySignature } from "../../hooshpay/verifySignature.js";
import { validateHooshPaidDetails } from "../../hooshpay/paymentValidation.js";
import { fulfillHooshOrder } from "../../hooshpay/fulfillHooshOrder.js";
import { confirmBankInvoice, rejectBankInvoice } from "../../admin/payments.js";
import { AdminServiceError } from "../../admin/authorization.js";
import { createMockDataset } from "../memoryStore.js";
import { MOCK_BASE_URL, createFakeBot, createFakeHooshPay, mockId, mockSecret, mockUserId, signHooshPayload } from "../fakes.js";

const opId = () => mockId("op").replace(/^mock_/, "MOCKOP_");

export const cardToCardScenario = Object.freeze({
  id: "card",
  title: "Card-to-card top-up",
  titleFa: "شارژ کارت به کارت",
  async run(t, { actorId }) {
    if (!actorId) t.block("An authorised admin actor is required for the audited review actions.");

    // ── HooshPay: invoice creation
    const ds = createMockDataset();
    const gateway = createFakeHooshPay();
    const bot = createFakeBot();
    const payer = mockUserId(31);
    await ds.users.create({ telegramId: payer, balance: 5_000 });
    const create = (userId, amount, overrides = {}) => createHooshInvoice({
      userId, amount, invoiceModel: ds.hooshpay,
      createInvoice: gateway.createInvoice, cancelInvoice: gateway.cancelInvoice,
      webhookBaseUrl: MOCK_BASE_URL, ...overrides,
    });
    for (const amount of [999, 1.5, -1_000, "150000"]) {
      await t.rejects(`invalid amount ${String(amount)} is refused`, () => create(payer, amount), (error) => error instanceof TypeError);
    }
    t.equal("invalid amounts never reach the gateway", gateway.calls.length, 0);

    const amount = 150_000;
    const invoice = await create(payer, amount);
    const createCall = gateway.calls[0]?.params;
    t.check("gateway receives the Toman amount unchanged", createCall?.amount === amount);
    t.check("gateway receives the signed-webhook callback URL", createCall?.callback_url === `${MOCK_BASE_URL}/api/hooshpay/webhook`);
    t.check("order ID uses the production HP- format", /^HP-[0-9a-f-]{36}$/i.test(invoice?.orderId || ""));
    t.check("invoice is pending and bound to the gateway UID", invoice?.status === "pending" && invoice?.creationStatus === "created" && Boolean(invoice?.uid));
    t.equal("creating an invoice never credits", ds.users.peek({ telegramId: payer }).balance, 5_000);
    await t.rejects("a second open invoice creation for the same user is blocked while unresolved", async () => {
      const blocking = createFakeHooshPay({ outcomes: ["timeout"] });
      const user = mockUserId(32);
      await create(user, amount, { createInvoice: blocking.createInvoice }).catch(() => {});
      await create(user, amount, { createInvoice: blocking.createInvoice });
    }, (error) => error?.code === "in_flight");

    // ── Signed webhook
    const secret = mockSecret();
    const paid = {
      event: "payment.success", invoice: invoice.uid, order_id: invoice.orderId, status: "paid",
      amount, currency: "TOMAN", tracking_code: "MOCK-TRACKING-1", paid_at: new Date().toISOString(),
    };
    const signature = signHooshPayload(paid, secret);
    t.check("valid webhook signature verifies", verifyHooshPaySignature(paid, signature, secret));
    t.check("tampered webhook amount fails verification", !verifyHooshPaySignature({ ...paid, amount: amount * 10 }, signature, secret));
    t.check("missing secret rejects every webhook", !verifyHooshPaySignature(paid, signature, ""));
    t.equal("paid details match the stored invoice", validateHooshPaidDetails(invoice, paid, { requireUid: true, requireOrderId: true, requireCurrency: true }), null);
    t.equal("a ×10 amount is rejected (no Rial/Toman confusion)", validateHooshPaidDetails(invoice, { ...paid, amount: amount * 10 }), "amount_mismatch");
    t.equal("a foreign order ID is rejected", validateHooshPaidDetails(invoice, { ...paid, order_id: "HP-other" }), "order_id_mismatch");

    // ── Two-phase credit, duplicates, notification
    const fulfil = (target = invoice) => fulfillHooshOrder({
      invoice: target, bot, chatId: payer, correlationId: mockId("cid"), paidAt: paid.paid_at,
      invoiceModel: ds.hooshpay, userModel: ds.users,
    });
    const first = await fulfil();
    t.check("paid webhook credits the wallet", first.credited === true);
    t.equal("wallet credited by the invoice amount", ds.users.peek({ telegramId: payer }).balance, 5_000 + amount);
    const again = await fulfil(ds.hooshpay.peek({ _id: invoice._id }));
    t.check("duplicate webhook is acknowledged without credit", again.credited === false && again.alreadyCredited === true);
    const storm = await Promise.all(Array.from({ length: 5 }, () => fulfil()));
    t.check("5 concurrent duplicate webhooks never credit", storm.every((entry) => entry.credited === false));
    t.equal("balance credited exactly once", ds.users.peek({ telegramId: payer }).balance, 5_000 + amount);
    t.equal("customer notified exactly once", bot.to(payer).filter((call) => call.method === "sendMessage").length, 1);

    const expired = await create(mockUserId(33), amount);
    await ds.hooshpay.updateOne({ _id: expired._id }, { $set: { status: "expired" } });
    await ds.users.create({ telegramId: mockUserId(33), balance: 0 });
    const expiredResult = await fulfil(ds.hooshpay.peek({ _id: expired._id }));
    t.check("an expired invoice is never credited", expiredResult.credited === false && expiredResult.notPaid === true);
    t.equal("expired invoice left the wallet untouched", ds.users.peek({ telegramId: mockUserId(33) }).balance, 0);

    // Crash between phase 1 (claim) and phase 2 (credit): recovery credits once.
    let failCredit = true;
    const crashDs = createMockDataset({ faults: { users: { failNext: (operation, filter) => {
      if (failCredit && operation === "findOneAndUpdate" && filter?.appliedPaymentKeys) { failCredit = false; return new Error("mock write failure"); }
      return null;
    } } } });
    const crashUser = mockUserId(34);
    await crashDs.users.create({ telegramId: crashUser, balance: 0 });
    const crashInvoice = await create(crashUser, amount, { invoiceModel: crashDs.hooshpay });
    const crashFulfil = () => fulfillHooshOrder({ invoice: crashDs.hooshpay.peek({ _id: crashInvoice._id }), bot: null, chatId: crashUser, invoiceModel: crashDs.hooshpay, userModel: crashDs.users });
    await t.rejects("a failed wallet write surfaces as an error (gateway will retry)", crashFulfil, () => true);
    const stuck = crashDs.hooshpay.peek({ _id: crashInvoice._id });
    t.check("failed write leaves a recoverable claimed invoice", stuck?.fulfilled === true && stuck?.balanceCredited === false);
    t.equal("failed write credited nothing", crashDs.users.peek({ telegramId: crashUser }).balance, 0);
    const recovered = await crashFulfil();
    t.check("recovery completes the credit", recovered.credited === true);
    await crashFulfil();
    t.equal("recovery credits exactly once", crashDs.users.peek({ telegramId: crashUser }).balance, amount);

    // ── Manual bank receipt review (audited admin actions)
    const reviewer = String(actorId);
    const customer = mockUserId(35);
    await ds.users.create({ telegramId: customer, balance: 0 });
    const receiptA = "MOCKBANK" + mockId("a").slice(-8);
    const receiptB = "MOCKBANK" + mockId("b").slice(-8);
    await ds.bank.create({ paymentId: receiptA, userId: Number(customer), amount: 200_000, paymentType: "bank", status: "waiting_for_approval", receiptSubmittedAt: new Date() });
    await ds.bank.create({ paymentId: receiptB, userId: Number(customer), amount: 90_000, paymentType: "bank", status: "waiting_for_approval", receiptSubmittedAt: new Date() });
    const reviewDeps = { bankModel: ds.bank, userModel: ds.users, auditModel: ds.audit, bot };

    const approveOp = opId();
    const approved = await confirmBankInvoice({ actorId: reviewer, operationId: approveOp, paymentId: receiptA, ...reviewDeps });
    t.equal("approval credits the receipt", approved?.status, "credited");
    t.equal("approval credits the stored amount (never callback data)", ds.users.peek({ telegramId: customer }).balance, 200_000);
    const replayed = await confirmBankInvoice({ actorId: reviewer, operationId: approveOp, paymentId: receiptA, ...reviewDeps });
    t.check("replaying the same approval is idempotent", replayed?.status === "credited");
    const duplicate = await confirmBankInvoice({ actorId: reviewer, operationId: opId(), paymentId: receiptA, ...reviewDeps });
    t.equal("a second approval is reported as already confirmed", duplicate?.status, "already_confirmed");
    t.equal("duplicate approvals credit once", ds.users.peek({ telegramId: customer }).balance, 200_000);
    await t.rejects("an approved receipt cannot be rejected",
      () => rejectBankInvoice({ actorId: reviewer, operationId: opId(), paymentId: receiptA, reason: "mock rejection after approval", ...reviewDeps }),
      (error) => error instanceof AdminServiceError && error.status === 409);

    const rejected = await rejectBankInvoice({ actorId: reviewer, operationId: opId(), paymentId: receiptB, reason: "mock receipt does not match", ...reviewDeps });
    t.equal("rejection closes the receipt", rejected?.status, "rejected");
    await t.rejects("a rejected receipt cannot be approved",
      () => confirmBankInvoice({ actorId: reviewer, operationId: opId(), paymentId: receiptB, ...reviewDeps }),
      (error) => error instanceof AdminServiceError && error.status === 409);
    t.equal("rejection credits nothing", ds.users.peek({ telegramId: customer }).balance, 200_000);
    await t.rejects("a non-admin cannot review receipts",
      () => confirmBankInvoice({ actorId: "1", operationId: opId(), paymentId: receiptB, ...reviewDeps }),
      (error) => error instanceof AdminServiceError && error.status === 403);

    const audits = ds.audit.snapshot();
    t.equal("approval audit trail: 2 succeeded (incl. duplicate)", audits.filter((row) => row.action === "BANK_PAYMENT_CONFIRMED" && row.status === "succeeded").length, 2);
    t.equal("blocked approval is audited as failed", audits.filter((row) => row.action === "BANK_PAYMENT_CONFIRMED" && row.status === "failed").length, 1);
    t.equal("rejections are audited (1 succeeded, 1 refused)", audits.filter((row) => row.action === "BANK_PAYMENT_REJECTED").length, 2);
    t.check("audit rows record the reviewing admin", audits.every((row) => row.actorTelegramId === reviewer));
    t.check("customer was told about the rejection", bot.textsTo(customer).some((text) => text.includes("رسید")));

    t.note("HooshPay calls, webhooks and bank receipts were simulated. Card transfers did not happen and no real wallet was credited.");
  },
});

export default cardToCardScenario;
