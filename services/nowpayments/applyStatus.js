import NowPaymentsInvoice from "../../models/NowPaymentsInvoice.js";
import User from "../../models/User.js";
import { creditWalletOnce } from "../walletCredit.js";
import { KNOWN_PAYMENT_STATUSES, SUCCESS_PAYMENT_STATUS, TRON_PAY_CURRENCY } from "./constants.js";
import { coversCryptoAmount, fiatToCents } from "./money.js";

async function findOne(model, filter) {
  const query = model.findOne(filter);
  return typeof query?.lean === "function" ? query.lean() : query;
}

function idText(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(text) ? text : null;
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

function finishedMismatch(invoice, payload) {
  const paymentId = idText(payload.payment_id);
  const invoiceId = idText(payload.invoice_id);
  if (!paymentId || !invoiceId) return "missing_provider_id";
  if (invoice.invoiceId && invoice.invoiceId !== invoiceId) return "invoice_mismatch";
  if (String(payload.order_id) !== invoice.orderId) return "order_mismatch";
  if (String(payload.price_currency || "").toLowerCase() !== invoice.priceCurrency) return "currency_mismatch";
  if (String(payload.pay_currency || "").toLowerCase() !== TRON_PAY_CURRENCY) return "pay_currency_mismatch";
  if (fiatToCents(payload.price_amount) !== invoice.priceAmountCents) return "amount_mismatch";
  if (!coversCryptoAmount(payload.actually_paid, payload.pay_amount)) return "crypto_amount_mismatch";
  return null;
}

export async function applyNowPaymentsUpdate({
  payload,
  invoiceModel = NowPaymentsInvoice,
  userModel = User,
  now = () => new Date(),
} = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { outcome: "invalid_payload", credited: false };
  }
  const orderId = typeof payload.order_id === "string" ? payload.order_id : "";
  if (!/^NP-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return { outcome: "unknown_order", credited: false };
  }
  const invoice = await findOne(invoiceModel, { orderId });
  if (!invoice) return { outcome: "unknown_order", credited: false };

  const status = typeof payload.payment_status === "string" ? payload.payment_status.trim().toLowerCase() : "";
  if (!KNOWN_PAYMENT_STATUSES.includes(status)) {
    return { outcome: "invalid_status", credited: false };
  }
  const incomingInvoiceId = idText(payload.invoice_id);
  if (invoice.invoiceId && incomingInvoiceId && invoice.invoiceId !== incomingInvoiceId) {
    return { outcome: "invoice_mismatch", credited: false };
  }
  if (payload.order_id !== invoice.orderId) return { outcome: "order_mismatch", credited: false };

  const log = [...(invoice.ipnLog || []), sanitizedLog(payload, status)].slice(-20);
  const observedPaymentId = idText(payload.payment_id);
  await invoiceModel.updateOne({ orderId }, {
    $set: {
      providerStatus: status,
      lastIpnAt: now(),
      updatedAt: now(),
      ipnLog: log,
      ...(observedPaymentId && !invoice.paymentId ? { paymentId: observedPaymentId } : {}),
      ...(incomingInvoiceId && !invoice.invoiceId ? { invoiceId: incomingInvoiceId } : {}),
      ...(payload.pay_amount != null && Number.isFinite(Number(payload.pay_amount)) ? { payAmount: Number(payload.pay_amount) } : {}),
      ...(payload.actually_paid != null && Number.isFinite(Number(payload.actually_paid)) ? { actuallyPaid: Number(payload.actually_paid) } : {}),
    },
  });

  if (invoice.status === "creation_failed") {
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: "ipn_after_rejected_create", updatedAt: now() },
    });
    return { outcome: "not_eligible", credited: false };
  }
  if (status === "refunded") {
    await invoiceModel.updateOne({ orderId }, {
      $set: {
        status: "refunded",
        recoveryStatus: invoice.balanceCredited ? "required" : "none",
        recoveryReason: invoice.balanceCredited ? "refunded_after_credit" : null,
        updatedAt: now(),
      },
      $unset: { openCreateKey: 1 },
    });
    return { outcome: "refunded", credited: false, alreadyCredited: Boolean(invoice.balanceCredited) };
  }
  if (invoice.status === "refunded") {
    return { outcome: "refunded", credited: false, alreadyCredited: Boolean(invoice.balanceCredited) };
  }
  if (invoice.balanceCredited) {
    return { outcome: "already_credited", credited: false, alreadyCredited: true };
  }
  if (status !== SUCCESS_PAYMENT_STATUS) {
    await invoiceModel.updateOne({
      orderId,
      balanceCredited: false,
      status: { $nin: ["finished", "refunded"] },
    }, {
      $set: { status: status === "pending" ? "waiting" : status, updatedAt: now() },
    });
    return { outcome: status === "pending" ? "waiting" : status, credited: false };
  }

  const mismatch = finishedMismatch(invoice, payload);
  if (mismatch) {
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: mismatch, updatedAt: now() },
    });
    return { outcome: "amount_mismatch", credited: false, reason: mismatch };
  }

  const fresh = await findOne(invoiceModel, { orderId });
  if (!fresh || fresh.balanceCredited || fresh.status === "refunded") {
    return { outcome: fresh?.balanceCredited ? "already_credited" : "not_eligible", credited: false, alreadyCredited: Boolean(fresh?.balanceCredited) };
  }
  const wallet = await creditWalletOnce({
    telegramId: fresh.userId,
    amount: fresh.amountToman,
    creditKey: `nowpayments:${fresh.orderId}`,
    userModel,
  });
  if (!wallet.user) {
    await invoiceModel.updateOne({ orderId }, {
      $set: { recoveryStatus: "required", recoveryReason: "user_missing", updatedAt: now() },
    });
    return { outcome: "user_missing", credited: false };
  }
  await invoiceModel.updateOne({ orderId, balanceCredited: false }, {
    $set: {
      status: "finished",
      providerStatus: SUCCESS_PAYMENT_STATUS,
      balanceCredited: true,
      balanceCreditedAt: now(),
      paidAt: now(),
      paymentId: idText(payload.payment_id),
      invoiceId: idText(payload.invoice_id) || fresh.invoiceId,
      creditLedgerVersion: 2,
      recoveryStatus: "none",
      recoveryReason: null,
      updatedAt: now(),
    },
    $unset: { openCreateKey: 1 },
  });
  return {
    outcome: "finished",
    credited: wallet.credited,
    alreadyCredited: wallet.alreadyCredited,
    amountToman: fresh.amountToman,
    userId: fresh.userId,
    orderId: fresh.orderId,
    balance: wallet.user.balance,
  };
}
