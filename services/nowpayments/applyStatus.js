import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import User from "../../models/User.js";
import { creditWalletOnce } from "../walletCredit.js";
import {
  IN_PROGRESS_PAYMENT_STATUSES,
  KNOWN_PAYMENT_STATUSES,
  SUCCESS_PAYMENT_STATUS,
  TERMINAL_NON_CREDIT_STATUSES,
  TRON_PAY_CURRENCY,
} from "./constants.js";
import { coversCryptoAmount, fiatToCents } from "./money.js";

const PROGRESS_RANK = Object.freeze({
  waiting: 0,
  pending: 1,
  confirming: 2,
  partially_paid: 3,
  confirmed: 4,
  sending: 5,
});
const LOCALLY_SETTLEABLE = Object.freeze([
  "creating",
  "creation_unknown",
  "pending",
  ...IN_PROGRESS_PAYMENT_STATUSES,
]);

async function findOne(model, filter) {
  const query = model.findOne(filter);
  return typeof query?.lean === "function" ? query.lean() : query;
}

function plain(document) {
  return typeof document?.toObject === "function" ? document.toObject() : document;
}

function idText(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sameCryptoAmount(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-8;
}

function sanitizedLog(payload, status) {
  return {
    receivedAt: new Date(),
    paymentId: idText(payload.payment_id),
    invoiceId: idText(payload.invoice_id),
    paymentStatus: status,
    priceAmount: payload.price_amount == null ? null : Number(payload.price_amount),
    priceCurrency: payload.price_currency == null ? null : String(payload.price_currency).toLowerCase(),
    payCurrency: payload.pay_currency == null ? null : String(payload.pay_currency).toLowerCase(),
    payAmount: payload.pay_amount == null ? null : Number(payload.pay_amount),
    actuallyPaid: payload.actually_paid == null ? null : Number(payload.actually_paid),
  };
}

function paymentMismatch(invoice, payload, { requirePaidAmounts = false } = {}) {
  const paymentId = idText(payload.payment_id);
  const invoiceId = idText(payload.invoice_id);
  if (!paymentId || !invoiceId) return "missing_provider_id";
  if (invoice.paymentId && invoice.paymentId !== paymentId) return "payment_id_mismatch";
  if (invoice.invoiceId && invoice.invoiceId !== invoiceId) return "invoice_mismatch";
  if (String(payload.order_id) !== invoice.orderId) return "order_mismatch";
  if (String(payload.price_currency || "").trim().toLowerCase() !== invoice.priceCurrency) return "currency_mismatch";
  if (String(payload.pay_currency || "").trim().toLowerCase() !== String(invoice.payCurrency || TRON_PAY_CURRENCY).toLowerCase()) {
    return "pay_currency_mismatch";
  }
  if (fiatToCents(payload.price_amount) !== invoice.priceAmountCents) return "amount_mismatch";

  const payAmount = finitePositive(payload.pay_amount);
  if (invoice.payAmount != null && (payAmount == null || !sameCryptoAmount(payAmount, invoice.payAmount))) {
    return "pay_amount_mismatch";
  }
  if (requirePaidAmounts && (payAmount == null || !coversCryptoAmount(payload.actually_paid, payAmount))) {
    return "crypto_amount_mismatch";
  }
  return null;
}

async function appendIpnLog(invoiceModel, orderId, payload, status, now) {
  await invoiceModel.updateOne(
    { orderId },
    {
      $set: { providerStatus: status, lastIpnAt: now(), updatedAt: now() },
      $push: { ipnLog: { $each: [sanitizedLog(payload, status)], $slice: -20 } },
    },
  );
}

function terminalOutcome(invoice) {
  if (invoice.balanceCredited) return { outcome: "already_credited", credited: false, alreadyCredited: true };
  return { outcome: invoice.status, credited: false, terminal: true };
}

function nextProgressStatus(current, incoming) {
  if (!Object.hasOwn(PROGRESS_RANK, incoming)) return current;
  if (!Object.hasOwn(PROGRESS_RANK, current)) return incoming;
  return PROGRESS_RANK[incoming] >= PROGRESS_RANK[current] ? incoming : current;
}

export async function applyNowPaymentsUpdate({
  payload,
  invoiceModel = NowPaymentsInvoice,
  userModel = User,
  creditWallet = creditWalletOnce,
  now = () => new Date(),
} = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { outcome: "invalid_payload", credited: false };
  }
  const orderId = typeof payload.order_id === "string" ? payload.order_id : "";
  if (!/^NP-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return { outcome: "unknown_order", credited: false };
  }
  let invoice = await findOne(invoiceModel, { orderId });
  if (!invoice) return { outcome: "unknown_order", credited: false };

  const status = typeof payload.payment_status === "string" ? payload.payment_status.trim().toLowerCase() : "";
  if (!KNOWN_PAYMENT_STATUSES.includes(status)) {
    return { outcome: "invalid_status", credited: false };
  }

  const mismatch = paymentMismatch(invoice, payload, { requirePaidAmounts: status === SUCCESS_PAYMENT_STATUS });
  if (mismatch) {
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: mismatch, updatedAt: now() },
    });
    return {
      outcome: ["invoice_mismatch", "payment_id_mismatch", "order_mismatch", "missing_provider_id"].includes(mismatch)
        ? mismatch
        : "amount_mismatch",
      credited: false,
      reason: mismatch,
    };
  }

  const paymentId = idText(payload.payment_id);
  const invoiceId = idText(payload.invoice_id);
  const providerPayAmount = finitePositive(payload.pay_amount);
  const numericActuallyPaid = Number.isFinite(Number(payload.actually_paid)) && Number(payload.actually_paid) >= 0
    ? Number(payload.actually_paid)
    : null;
  const overpaidAmount = providerPayAmount != null && numericActuallyPaid != null && numericActuallyPaid > providerPayAmount + 1e-8
    ? Number((numericActuallyPaid - providerPayAmount).toFixed(8))
    : null;
  const underpaidAmount = providerPayAmount != null && numericActuallyPaid != null && numericActuallyPaid + 1e-8 < providerPayAmount
    ? Number((providerPayAmount - numericActuallyPaid).toFixed(8))
    : null;
  const outcomeAmount = finitePositive(payload.outcome_amount);
  const outcomeCurrency = typeof payload.outcome_currency === "string" && payload.outcome_currency.trim()
    ? payload.outcome_currency.trim().toLowerCase()
    : null;
  const payAddress = typeof payload.pay_address === "string" && payload.pay_address.trim()
    ? payload.pay_address.trim()
    : null;

  const immutableBindings = [
    { $or: [{ paymentId: null }, { paymentId: "" }, { paymentId }] },
    { $or: [{ invoiceId: null }, { invoiceId: "" }, { invoiceId }] },
  ];
  if (providerPayAmount != null) {
    immutableBindings.push({ $or: [{ payAmount: null }, { payAmount: providerPayAmount }] });
  }
  try {
    await invoiceModel.updateOne(
      { orderId, $and: immutableBindings },
      {
        $set: {
          paymentId,
          invoiceId,
          ...(providerPayAmount != null ? { payAmount: providerPayAmount } : {}),
          ...(numericActuallyPaid != null ? { actuallyPaid: numericActuallyPaid } : {}),
          ...(overpaidAmount != null ? { overpaidAmount } : {}),
          ...(underpaidAmount != null ? { underpaidAmount } : {}),
          ...(outcomeAmount != null ? { outcomeAmount } : {}),
          ...(outcomeCurrency ? { outcomeCurrency } : {}),
          ...(payAddress ? { payAddress } : {}),
          updatedAt: now(),
        },
      },
    );
  } catch (error) {
    if (error?.code === 11000) return { outcome: "provider_id_conflict", credited: false };
    throw error;
  }

  invoice = await findOne(invoiceModel, { orderId });
  if (!invoice || invoice.paymentId !== paymentId || invoice.invoiceId !== invoiceId) {
    return { outcome: "provider_id_conflict", credited: false };
  }
  const bindingMismatch = paymentMismatch(invoice, payload, { requirePaidAmounts: status === SUCCESS_PAYMENT_STATUS });
  if (bindingMismatch) {
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: bindingMismatch, updatedAt: now() },
    });
    return { outcome: "amount_mismatch", credited: false, reason: bindingMismatch };
  }
  await appendIpnLog(invoiceModel, orderId, payload, status, now);

  if (invoice.status === "creation_failed") {
    const flaggedBefore = invoice.recoveryStatus;
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: "ipn_after_rejected_create", updatedAt: now() },
    });
    // flaggedForReview is true only the first time, so a provider's IPN retries do not re-alert.
    return { outcome: "not_eligible", credited: false, flaggedForReview: flaggedBefore !== "required" };
  }

  // A refund is a terminal reversal. It either wins before final settlement and
  // blocks credit, or records manual reconciliation if a final claim/credit has
  // already won. The webhook never silently debits a wallet.
  if (status === "refunded") {
    const closed = await invoiceModel.updateOne(
      { orderId, balanceCredited: false, status: { $in: LOCALLY_SETTLEABLE } },
      {
        $set: { status: "refunded", recoveryStatus: "none", recoveryReason: null, updatedAt: now() },
        $unset: { openCreateKey: 1 },
      },
    );
    if (Number(closed?.modifiedCount || closed?.nModified || 0) > 0) {
      return { outcome: "refunded", credited: false, alreadyCredited: false };
    }
    const reversal = await invoiceModel.findOneAndUpdate(
      { orderId, status: SUCCESS_PAYMENT_STATUS },
      {
        $set: {
          status: "refunded",
          recoveryStatus: "required",
          recoveryReason: "refunded_after_payment_claim",
          updatedAt: now(),
        },
        $unset: { openCreateKey: 1 },
      },
      { new: true },
    );
    return {
      outcome: "refunded",
      credited: false,
      alreadyCredited: Boolean(reversal?.balanceCredited || invoice.balanceCredited),
      settlementInProgress: Boolean(reversal && !reversal.balanceCredited),
    };
  }

  if (TERMINAL_NON_CREDIT_STATUSES.includes(invoice.status)) {
    // A verified `finished` for an order we already closed (expired/failed/
    // refunded) means money may really have arrived. It is never credited
    // automatically, but it must not be acknowledged silently either.
    let flaggedForReview = false;
    const flaggedBefore = invoice.recoveryStatus; // read before the update (a live document may alias it)
    if (status === SUCCESS_PAYMENT_STATUS && !invoice.balanceCredited) {
      await invoiceModel.updateOne(
        { orderId, balanceCredited: false, recoveryStatus: { $ne: "resolved" } },
        { $set: { recoveryStatus: "required", recoveryReason: "payment_after_terminal_status", updatedAt: now() } },
      );
      flaggedForReview = flaggedBefore !== "required" && flaggedBefore !== "resolved";
    }
    return { ...terminalOutcome(invoice), ...(flaggedForReview ? { flaggedForReview } : {}) };
  }
  if (invoice.balanceCredited) {
    return {
      outcome: "already_credited",
      credited: false,
      alreadyCredited: true,
      notificationPending: Boolean(invoice.notificationPending),
      orderId,
    };
  }

  if (status !== SUCCESS_PAYMENT_STATUS) {
    // A stale pending/failed callback cannot overwrite a finished settlement.
    if (invoice.status === SUCCESS_PAYMENT_STATUS) {
      return { outcome: "finished", credited: false, settlementInProgress: true };
    }
    if (TERMINAL_NON_CREDIT_STATUSES.includes(status)) {
      await invoiceModel.updateOne(
        { orderId, balanceCredited: false, status: { $in: LOCALLY_SETTLEABLE } },
        {
          $set: { status, providerStatus: status, updatedAt: now() },
          $unset: { openCreateKey: 1 },
        },
      );
      return { outcome: status, credited: false };
    }

    const nextStatus = nextProgressStatus(invoice.status, status);
    await invoiceModel.updateOne(
      { orderId, balanceCredited: false, status: { $in: LOCALLY_SETTLEABLE } },
      {
        $set: {
          status: nextStatus,
          providerStatus: status,
          ...(status === "partially_paid"
            ? { recoveryStatus: "required", recoveryReason: "partially_paid_underpayment" }
            : {}),
          updatedAt: now(),
        },
        // A provider-bound payment settles the "did the invoice exist?" question, so the
        // one-open-create-per-user key must not outlive creation_unknown.
        $unset: { openCreateKey: 1 },
      },
    );
    return { outcome: status, credited: false };
  }

  // Atomically claim the final transition before touching the wallet. A failed
  // or expired IPN racing this one can win instead, but both can never win.
  let claimed = await invoiceModel.findOneAndUpdate(
    {
      orderId,
      paymentId,
      invoiceId,
      balanceCredited: false,
      status: { $in: [...LOCALLY_SETTLEABLE, SUCCESS_PAYMENT_STATUS] },
    },
    {
      $set: {
        status: SUCCESS_PAYMENT_STATUS,
        providerStatus: SUCCESS_PAYMENT_STATUS,
        paidAt: invoice.paidAt || now(),
        updatedAt: now(),
      },
      $unset: { openCreateKey: 1 },
    },
    { new: true },
  );
  claimed = plain(claimed);
  if (!claimed) {
    const current = await findOne(invoiceModel, { orderId });
    if (!current) return { outcome: "not_eligible", credited: false };
    if (current.balanceCredited) return { outcome: "already_credited", credited: false, alreadyCredited: true, orderId };
    if (TERMINAL_NON_CREDIT_STATUSES.includes(current.status)) return terminalOutcome(current);
    return { outcome: "not_eligible", credited: false };
  }

  const wallet = await creditWallet({
    telegramId: claimed.userId,
    amount: claimed.amountToman,
    creditKey: `nowpayments:${claimed.orderId}`,
    userModel,
  });
  if (!wallet.user) {
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: "user_missing", updatedAt: now() },
    });
    return { outcome: "user_missing", credited: false };
  }

  const finalized = await invoiceModel.updateOne({ orderId, status: SUCCESS_PAYMENT_STATUS, balanceCredited: false }, {
    $set: {
      balanceCredited: true,
      balanceCreditedAt: now(),
      creditLedgerVersion: 2,
      notificationPending: true,
      recoveryStatus: "none",
      recoveryReason: null,
      updatedAt: now(),
    },
    $unset: { openCreateKey: 1 },
  });
  let notificationPending = true;
  if (Number(finalized?.modifiedCount || finalized?.nModified || 0) === 0) {
    const current = await findOne(invoiceModel, { orderId });
    if (current?.status === "refunded" && !current.balanceCredited) {
      // The provider reversal raced an already-durable wallet credit. Reflect
      // both facts and suppress a misleading success notification.
      await invoiceModel.updateOne(
        { orderId, status: "refunded", balanceCredited: false },
        {
          $set: {
            balanceCredited: true,
            balanceCreditedAt: now(),
            creditLedgerVersion: 2,
            notificationPending: false,
            recoveryStatus: "required",
            recoveryReason: "refunded_after_wallet_credit",
            updatedAt: now(),
          },
          $unset: { openCreateKey: 1 },
        },
      );
      notificationPending = false;
    } else if (!current?.balanceCredited) {
      throw new Error("NOWPayments wallet credit is durable but invoice completion could not be recorded");
    } else {
      notificationPending = Boolean(current.notificationPending);
    }
  }
  return {
    outcome: "finished",
    credited: wallet.credited,
    alreadyCredited: wallet.alreadyCredited,
    notificationPending,
    amountToman: claimed.amountToman,
    userId: claimed.userId,
    orderId: claimed.orderId,
    balance: wallet.user.balance,
  };
}
