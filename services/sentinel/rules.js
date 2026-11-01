/**
 * Detection rules: pure functions from one customer's bundle to findings. No I/O, no clock of their own (ctx.now).
 *
 * Two kinds of rule, and why the difference matters for concurrency (see bundle.js):
 *   - "the record claims X, so the ledger must hold X" cannot misfire, because the ledger key is written first and the
 *     user is read last;
 *   - "the ledger holds X, so the record must show X" can catch a writer between its two steps, so these rules wait for
 *     `graceMs` and the reconciler re-reads before raising anything new.
 *
 * Findings carry identifiers, statuses and amounts only.
 */
import { isAllowedWalletPurchaseTransition } from "../../models/WalletPurchase.js";
import { coversCryptoAmount } from "../nowpayments/money.js";
import { FINDING_CATALOG, ORDER_DEBIT_CLAIMING_STATUSES, REPEATED_CALLBACK_MIN, RULE_VERSION, SEVERITY_RANK } from "./constants.js";
import { duplicateKeys, ledgerSets, reconstructBalance, wholeToman } from "./ledger.js";

const REVIEW_REASONS_LATE = new Set(["payment_after_terminal_status", "ipn_after_rejected_create"]);
const PROVIDER_MISMATCH_REASONS = new Set([
  "amount_mismatch", "invoice_mismatch", "payment_id_mismatch", "order_mismatch", "missing_provider_id",
  "currency_mismatch", "pay_currency_mismatch", "pay_amount_mismatch", "crypto_amount_mismatch",
]);
const IN_PROGRESS_NOWPAYMENTS = new Set(["confirming", "confirmed", "sending", "partially_paid"]);

const time = (value) => (value ? new Date(value).getTime() : NaN);
const olderThan = (value, spanMs, ctx) => {
  const at = time(value);
  return Number.isFinite(at) && ctx.now.getTime() - at >= spanMs;
};
const positive = (value) => {
  const amount = wholeToman(value);
  return amount != null && amount > 0 ? amount : 0;
};
const money = (value) => `${Number(value || 0).toLocaleString("en-US")} Toman`;

function collector(bundle, out) {
  return (code, { subjectType, subjectKey, amount = 0, direction = "none", impactKey = null, expected = null, observed = null, expectedToman = null, observedToman = null, facts = {}, refs = [], classification, severity }) => {
    const spec = FINDING_CATALOG[code];
    const resolvedSeverity = severity || spec.severity;
    out.push({
      fingerprint: `${code}:${subjectKey}`.slice(0, 220),
      code,
      category: spec.category,
      classification: classification || spec.classification,
      severity: resolvedSeverity,
      rank: SEVERITY_RANK[resolvedSeverity],
      userId: bundle.userId,
      subjectType,
      subjectKey,
      impactKey: impactKey || subjectKey,
      amountToman: positive(amount),
      direction,
      expected,
      observed,
      expectedToman,
      observedToman,
      facts,
      refs: [{ type: "user", key: `user:${bundle.userId}` }, ...refs],
      ruleVersion: RULE_VERSION,
    });
  };
}

function paymentRules(bundle, ledger, ctx, raise) {
  const base = (payment) => ({
    subjectType: "payment",
    subjectKey: payment.key,
    refs: [{ type: "payment", key: payment.key }],
    amount: payment.amount,
    facts: { provider: payment.provider, status: payment.status, ledgerVersion: payment.ledgerVersion, credited: payment.credited },
  });

  for (const payment of bundle.payments) {
    const keyed = payment.creditKey != null && ledger.payment.has(payment.creditKey);
    const v2 = payment.ledgerVersion === 2;
    const settledAt = payment.confirmedAt || payment.fulfilledAt || payment.createdAt;

    if (payment.confirmed) {
      if (!payment.credited && !keyed) {
        if (v2 && olderThan(settledAt, ctx.config.stuckMs, ctx)) {
          raise("CONFIRMED_NOT_CREDITED", {
            ...base(payment), direction: "owed_to_customer",
            expected: `Wallet credited ${money(payment.amount)} under ${payment.provider}`, observed: "No ledger entry, invoice not marked credited",
            expectedToman: wholeToman(payment.amount), observedToman: 0,
          });
        } else if (!v2) {
          raise("LEGACY_CREDIT_UNVERIFIABLE", { ...base(payment), expected: "A ledger entry or a credited flag", observed: "Neither: this payment predates the ledger" });
        }
      } else if (!payment.credited && keyed && olderThan(settledAt, ctx.config.stuckMs, ctx)) {
        raise("CREDIT_FLAG_PENDING", { ...base(payment), expected: "Invoice marked credited after the wallet was", observed: "Ledger entry present, invoice flag still false" });
      } else if (payment.credited && !keyed && v2) {
        raise("CREDITED_WITHOUT_LEDGER", {
          ...base(payment), direction: "owed_to_customer",
          expected: "Ledger entry for this payment", observed: "Invoice says credited, no ledger entry on the wallet",
          expectedToman: wholeToman(payment.amount), observedToman: 0,
        });
      }
    } else if (payment.reversed) {
      if ((keyed || payment.credited) && payment.recoveryStatus !== "resolved") {
        raise("REVERSED_AFTER_CREDIT", {
          ...base(payment), direction: "excess_in_wallet",
          expected: "Reversed money no longer in the wallet", observed: `Provider reversed it; the wallet still holds ${money(payment.amount)}`,
          expectedToman: 0, observedToman: wholeToman(payment.amount),
        });
      }
    } else if (keyed && olderThan(payment.createdAt, ctx.config.graceMs, ctx)) {
      raise("CREDIT_ON_UNCONFIRMED_PAYMENT", {
        ...base(payment), direction: "excess_in_wallet",
        expected: "A credit only after provider confirmation", observed: `Ledger entry present while the invoice is "${payment.status}"`,
        expectedToman: 0, observedToman: wholeToman(payment.amount),
      });
    } else if (payment.credited) {
      raise("PAYMENT_STATE_CONTRADICTION", { ...base(payment), expected: "balanceCredited only on a confirmed invoice", observed: `balanceCredited on a "${payment.status}" invoice` });
    }

    if (payment.provider === "hooshpay" && v2) {
      if (payment.fulfilled && !["paid", "reversed"].includes(payment.status)) {
        raise("PAYMENT_STATE_CONTRADICTION", { ...base(payment), expected: "fulfilled only on paid or reversed", observed: `fulfilled on a "${payment.status}" invoice` });
      } else if (payment.status === "paid" && !payment.fulfilled && olderThan(settledAt, ctx.config.graceMs, ctx)) {
        raise("PAYMENT_STATE_CONTRADICTION", { ...base(payment), expected: "paid and fulfilled set together", observed: "paid without the fulfilment claim" });
      }
    }

    if (REVIEW_REASONS_LATE.has(payment.recoveryReason) && payment.recoveryStatus === "required") {
      raise("LATE_PAYMENT_UNCREDITED", {
        ...base(payment), direction: "owed_to_customer", facts: { ...base(payment).facts, reason: payment.recoveryReason },
        expected: "Payment before the invoice closed", observed: "Provider confirmed after it closed; nothing was credited",
      });
    }
    if (PROVIDER_MISMATCH_REASONS.has(payment.recoveryReason) && payment.recoveryStatus === "required") {
      raise("PROVIDER_EVIDENCE_MISMATCH", {
        ...base(payment), facts: { ...base(payment).facts, reason: payment.recoveryReason },
        expected: "Callback matches the stored invoice", observed: `Mismatch: ${payment.recoveryReason}`,
      });
    }
    if (payment.provider === "nowpayments") {
      if (payment.status === "partially_paid") {
        raise("UNDERPAID_PAYMENT", {
          ...base(payment), classification: "informational", severity: "low",
          expected: `${payment.payAmount ?? "?"} ${payment.payCurrency ?? ""}`.trim(), observed: `${payment.actuallyPaid ?? "?"} ${payment.payCurrency ?? ""}`.trim(),
        });
      } else if (payment.confirmed && payment.credited && payment.payAmount != null && payment.actuallyPaid != null && !coversCryptoAmount(payment.actuallyPaid, payment.payAmount)) {
        raise("UNDERPAID_PAYMENT", {
          ...base(payment), direction: "excess_in_wallet",
          expected: `${payment.payAmount} ${payment.payCurrency ?? ""}`.trim(), observed: `${payment.actuallyPaid} ${payment.payCurrency ?? ""}`.trim(),
        });
      }
      if (payment.status === "creation_unknown" && olderThan(payment.createdAt, ctx.config.stuckMs, ctx)) {
        raise("PAYMENT_STUCK", { ...base(payment), amount: 0, expected: "A definite invoice outcome", observed: "Invoice creation outcome unknown" });
      } else if (IN_PROGRESS_NOWPAYMENTS.has(payment.status) && olderThan(payment.updatedAt || payment.createdAt, ctx.config.awaitingProviderMs, ctx)) {
        raise("PAYMENT_STUCK", { ...base(payment), amount: 0, classification: "informational", severity: "low", expected: "Provider reaches a final status", observed: `Still "${payment.status}"` });
      }
    }
    if (payment.provider === "hooshpay" && payment.creationStatus === "creation_unknown" && olderThan(payment.createdAt, ctx.config.stuckMs, ctx)) {
      raise("PAYMENT_STUCK", { ...base(payment), amount: 0, expected: "A definite invoice outcome", observed: "Invoice creation outcome unknown" });
    }
    if (payment.provider === "bank" && payment.status === "waiting_for_approval" && olderThan(payment.createdAt, ctx.config.awaitingProviderMs, ctx)) {
      raise("PAYMENT_STUCK", { ...base(payment), amount: 0, classification: "informational", severity: "low", expected: "An admin decides the receipt", observed: "Still waiting for approval" });
    }

    const confirmations = payment.callbacks.filter((item) => ["paid", "finished"].includes(item.status));
    if (confirmations.length >= REPEATED_CALLBACK_MIN) {
      raise("REPEATED_CALLBACKS", {
        ...base(payment), amount: 0, facts: { ...base(payment).facts, deliveries: confirmations.length },
        expected: "One confirmation applied", observed: `${confirmations.length} confirmations received; the credit is keyed, so it applied once`,
      });
    }
  }

  const tracked = new Map();
  for (const payment of [...bundle.payments, ...(bundle.foreignTracking || [])]) {
    if (payment.provider !== "hooshpay" || !payment.trackingCode || !(payment.credited || payment.confirmed)) continue;
    tracked.set(payment.trackingCode, [...(tracked.get(payment.trackingCode) || []), payment]);
  }
  for (const group of tracked.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.key.localeCompare(b.key));
    const own = sorted.find((payment) => payment.userId === bundle.userId);
    if (!own) continue;
    raise("DUPLICATE_PROVIDER_REFERENCE", {
      subjectType: "payment", subjectKey: sorted.map((payment) => payment.key).join("+").slice(0, 170),
      impactKey: `tracking:${sorted[0].key}`,
      amount: sorted.slice(1).reduce((sum, payment) => sum + positive(payment.amount), 0), direction: "excess_in_wallet",
      expected: "One invoice per provider tracking code", observed: `${sorted.length} confirmed invoices share one tracking code`,
      refs: sorted.map((payment) => ({ type: "payment", key: payment.key })),
      facts: { invoices: sorted.length },
    });
  }

  for (const tombstone of bundle.tombstones) {
    const late = tombstone.lateEvents.filter((event) => ["paid", "finished"].includes(event.status));
    if (!late.length) continue;
    raise("LATE_PAYMENT_UNCREDITED", {
      subjectType: "payment", subjectKey: tombstone.key, amount: tombstone.amount ?? 0, direction: "owed_to_customer",
      expected: "No payment for a removed invoice", observed: `Provider reported "${late[late.length - 1].status}" after the invoice was removed`,
      refs: [{ type: "tombstone", key: tombstone.key }], facts: { provider: tombstone.provider, finalStatus: tombstone.finalStatus, lateEvents: late.length },
    });
  }
}

function ledgerRules(bundle, ledger, ctx, raise) {
  const user = bundle.user;
  const walletKey = `user:${bundle.userId}`;
  const ownKeys = new Set(bundle.payments.map((payment) => payment.creditKey));
  const foreign = new Map((bundle.foreignPayments || []).map((payment) => [payment.creditKey, payment]));
  const foreignOrders = new Map((bundle.foreignOrders || []).map((order) => [order.purchaseId, order]));
  const ownOrders = new Set(bundle.orders.map((order) => order.purchaseId));

  for (const key of ledger.payment) {
    if (ownKeys.has(key)) continue;
    const other = foreign.get(key);
    if (other) {
      if (other.userId !== bundle.userId) {
        raise("KEY_OWNER_MISMATCH", {
          subjectType: "wallet", subjectKey: `${walletKey}:${key}`.slice(0, 180), impactKey: other.key, amount: other.amount, direction: "excess_in_wallet",
          expected: "Ledger entries name this customer's own invoices", observed: "Ledger entry names another customer's invoice",
          refs: [{ type: "payment", key: other.key }], facts: { ledgerKey: key },
        });
      }
      continue;
    }
    const tombstone = bundle.tombstones.find((item) => item.creditKeys.includes(key));
    if (tombstone) {
      raise("CREDIT_ON_UNCONFIRMED_PAYMENT", {
        subjectType: "wallet", subjectKey: key, amount: tombstone.amount ?? 0, direction: "excess_in_wallet",
        expected: "A credit only after provider confirmation", observed: `Ledger entry for a removed "${tombstone.finalStatus}" invoice`,
        refs: [{ type: "tombstone", key: tombstone.key }], facts: { ledgerKey: key, finalStatus: tombstone.finalStatus },
      });
      continue;
    }
    raise("LEDGER_KEY_WITHOUT_PAYMENT", {
      subjectType: "wallet", subjectKey: `${walletKey}:${key}`.slice(0, 180), impactKey: key,
      expected: "An invoice for every wallet credit", observed: "Ledger entry with no invoice or tombstone, so its amount is unknown",
      facts: { ledgerKey: key },
    });
  }

  for (const purchaseId of ledger.reservation) {
    if (ownOrders.has(purchaseId)) continue;
    const other = foreignOrders.get(purchaseId);
    if (other) {
      raise("KEY_OWNER_MISMATCH", {
        subjectType: "wallet", subjectKey: `${walletKey}:reservation:${purchaseId}`.slice(0, 180), impactKey: other.key, amount: other.amount, direction: "owed_to_customer",
        expected: "Ledger entries name this customer's own orders", observed: "Debit names another customer's order",
        refs: [{ type: "order", key: other.key }], facts: { ledgerKey: purchaseId },
      });
    } else {
      raise("RESERVATION_WITHOUT_ORDER", {
        subjectType: "wallet", subjectKey: `${walletKey}:reservation:${purchaseId}`.slice(0, 180), impactKey: `wallet:${purchaseId}`,
        expected: "An order for every wallet debit", observed: "Debit entry with no order record, so its amount is unknown", facts: { ledgerKey: purchaseId },
      });
    }
  }
  for (const purchaseId of ledger.refund) {
    if (!ownOrders.has(purchaseId) && !foreignOrders.has(purchaseId)) {
      raise("REFUND_WITHOUT_ORDER", {
        subjectType: "wallet", subjectKey: `${walletKey}:refund:${purchaseId}`.slice(0, 180), impactKey: `wallet:${purchaseId}`,
        expected: "An order for every refund", observed: "Refund entry with no order record, so its amount is unknown", facts: { ledgerKey: purchaseId },
      });
    }
    if (!ledger.reservation.has(purchaseId)) {
      const order = bundle.orders.find((item) => item.purchaseId === purchaseId);
      if (order && !order.legacy) {
        raise("REFUND_WITHOUT_DEBIT", {
          subjectType: "order", subjectKey: order.key, amount: order.amount, direction: "excess_in_wallet",
          expected: "A refund only after a debit", observed: "Refund entry present, debit entry absent", refs: [{ type: "order", key: order.key }],
        });
      }
    }
  }

  const repeated = {
    payment: duplicateKeys(ledger.raw.payment), admin: duplicateKeys(ledger.raw.admin), reservation: duplicateKeys(ledger.raw.reservation), refund: duplicateKeys(ledger.raw.refund),
  };
  for (const [kind, keys] of Object.entries(repeated)) {
    for (const key of keys) {
      raise("DUPLICATE_LEDGER_KEY", {
        subjectType: "wallet", subjectKey: `${walletKey}:dup:${kind}:${key}`.slice(0, 180), impactKey: key,
        expected: "Each ledger entry once", observed: `${kind} entry appears more than once`, facts: { ledgerKey: key, kind },
      });
    }
  }

  for (const operationId of ledger.admin) {
    const audit = bundle.audits.find((item) => item.operationId === operationId);
    if (!audit) {
      raise("ADMIN_KEY_WITHOUT_AUDIT", {
        subjectType: "wallet", subjectKey: `${walletKey}:admin:${operationId}`.slice(0, 180), impactKey: operationId,
        expected: "An audit record for every admin adjustment", observed: "Ledger entry with no audit record, so its amount is unknown", facts: { operationId },
      });
    } else if (audit.status !== "succeeded" && olderThan(audit.createdAt, ctx.config.graceMs, ctx)) {
      raise("ADMIN_AUDIT_OUTCOME_MISMATCH", {
        subjectType: "wallet", subjectKey: `${walletKey}:admin:${operationId}`.slice(0, 180), impactKey: operationId, amount: 0,
        expected: "Audit says succeeded when the ledger entry exists", observed: `Ledger entry present, audit says "${audit.status}"`,
        refs: [{ type: "audit", key: `audit:${audit.id}` }], facts: { operationId, auditStatus: audit.status },
      });
    }
  }
  for (const audit of bundle.audits) {
    if (audit.status !== "succeeded" || audit.legacy || ledger.admin.has(audit.operationId)) continue;
    raise("ADMIN_AUDIT_OUTCOME_MISMATCH", {
      subjectType: "wallet", subjectKey: `${walletKey}:admin:${audit.operationId}`.slice(0, 180), impactKey: audit.operationId, amount: 0,
      expected: "A ledger entry when the audit says succeeded", observed: "Audit says succeeded, ledger entry absent",
      refs: [{ type: "audit", key: `audit:${audit.id}` }], facts: { operationId: audit.operationId, auditStatus: audit.status },
    });
  }

  const successfulPayments = wholeToman(user.successfulPayments);
  if (successfulPayments != null && successfulPayments < ledger.raw.payment.length) {
    raise("PAYMENT_COUNTER_MISMATCH", {
      subjectType: "wallet", subjectKey: `${walletKey}:counter`,
      expected: `At least ${ledger.raw.payment.length} successful payments`, observed: `${successfulPayments} counted`,
      facts: { counter: successfulPayments, ledgerKeys: ledger.raw.payment.length },
    });
  }
}

function orderRules(bundle, ledger, ctx, raise) {
  const serviceCounts = new Map();
  for (const service of bundle.user.services || []) {
    if (service?.purchaseId) serviceCounts.set(String(service.purchaseId), (serviceCounts.get(String(service.purchaseId)) || 0) + 1);
  }
  const ownOrders = new Set(bundle.orders.map((order) => order.purchaseId));

  for (const order of bundle.orders) {
    const reserved = ledger.reservation.has(order.purchaseId);
    const refunded = ledger.refund.has(order.purchaseId);
    const base = {
      subjectType: "order", subjectKey: order.key, amount: order.amount, refs: [{ type: "order", key: order.key }],
      facts: { status: order.status, walletDebitStatus: order.walletDebitStatus, refundStatus: order.refundStatus, legacy: order.legacy },
    };
    const claimsDebit = ORDER_DEBIT_CLAIMING_STATUSES.includes(order.status) || ["reserved", "finalized", "refunded"].includes(order.walletDebitStatus);

    if (claimsDebit && !reserved && !order.legacy) {
      raise("RESERVATION_MISSING", {
        ...base, direction: "excess_in_wallet",
        expected: `Ledger debit of ${money(order.amount)}`, observed: `Order is "${order.status}" with no debit entry`,
        expectedToman: wholeToman(order.amount), observedToman: 0,
      });
    }
    if (reserved && order.walletDebitStatus === "not_debited" && !["reserving", "failed"].includes(order.status) && olderThan(order.createdAt, ctx.config.graceMs, ctx)) {
      raise("DEBIT_NOT_RECORDED_ON_ORDER", { ...base, expected: "Order shows the debit", observed: "Debit entry present, order says not_debited" });
    }
    if (order.status === "failed" && reserved && !refunded && olderThan(order.createdAt, ctx.config.graceMs, ctx)) {
      raise("FAILED_ORDER_DEBIT_KEPT", {
        ...base, direction: "owed_to_customer",
        expected: "A failed order's debit refunded", observed: `Debit of ${money(order.amount)} kept, no refund entry`,
        expectedToman: 0, observedToman: wholeToman(order.amount),
      });
    }

    const recordSaysRefunded = order.status === "refunded" || order.refundStatus === "completed";
    if (recordSaysRefunded && !refunded && !order.legacy) {
      raise("REFUND_WITHOUT_LEDGER", {
        ...base, direction: "owed_to_customer",
        expected: `Refund entry returning ${money(order.amount)}`, observed: "Order says refunded, no refund entry on the wallet",
        expectedToman: wholeToman(order.amount), observedToman: 0,
      });
    }
    if (refunded) {
      if (["completed", "provisioned"].includes(order.status)) {
        raise("REFUNDED_AND_FULFILLED", {
          ...base, direction: "excess_in_wallet",
          expected: "Either a service or a refund", observed: `Refund entry present on a "${order.status}" order`,
        });
      } else if (order.status === "refund_pending") {
        if (olderThan(order.refundRequestedAt || order.createdAt, ctx.config.stuckMs, ctx)) {
          raise("REFUND_RECORD_PENDING", { ...base, expected: "Order marked refunded after the wallet was", observed: "Refund entry present, order still refund_pending" });
        }
      } else if (order.status !== "refunded" && olderThan(order.createdAt, ctx.config.graceMs, ctx)) {
        raise("REFUND_CONTRADICTS_ORDER", { ...base, direction: "excess_in_wallet", expected: "Refund only on a refunding order", observed: `Refund entry present on a "${order.status}" order` });
      }
    }
    if (["refunded", "refund_pending"].includes(order.status) && order.refundAmount != null && Number(order.refundAmount) !== Number(order.amount)) {
      raise("REFUND_AMOUNT_MISMATCH", {
        ...base, direction: Number(order.refundAmount) > Number(order.amount) ? "excess_in_wallet" : "owed_to_customer",
        amount: Math.abs(Number(order.refundAmount) - Number(order.amount)),
        expected: money(order.amount), observed: money(order.refundAmount),
        expectedToman: wholeToman(order.amount), observedToman: wholeToman(order.refundAmount),
      });
    }

    if (order.status === "completed" && !order.legacy) {
      const committed = ledger.completed.has(order.purchaseId) && Boolean(order.serviceUsername);
      const listed = (serviceCounts.get(order.purchaseId) || 0) > 0;
      const facts = { ...base.facts, commitEntry: ledger.completed.has(order.purchaseId), services: serviceCounts.get(order.purchaseId) || 0 };
      if (!committed) {
        raise("COMPLETED_NOT_COMMITTED", {
          ...base, direction: "owed_to_customer",
          expected: "A service on the customer's account", observed: "Order completed without a commit entry or a service",
          facts,
        });
      } else if (!listed && !order.revokedAt) {
        // The commit entry is written in the same update as the service, so this customer did receive it, and no money is
        // owed. It is gone since, and nothing recorded why: older deletions left no mark. Worth seeing, not worth an alarm.
        raise("COMPLETED_NOT_COMMITTED", {
          ...base, amount: 0, classification: "informational", severity: "info",
          expected: "A service on the customer's account, or a recorded removal", observed: "Delivered, then removed with no removal recorded",
          facts,
        });
      }
      if (order.walletDebitStatus !== "finalized") {
        raise("DEBIT_STATUS_MISMATCH", { ...base, amount: 0, expected: "walletDebitStatus finalized", observed: `walletDebitStatus ${order.walletDebitStatus}` });
      }
    }
    if (order.status === "refunded" && !order.legacy && order.walletDebitStatus !== "refunded") {
      raise("DEBIT_STATUS_MISMATCH", { ...base, amount: 0, expected: "walletDebitStatus refunded", observed: `walletDebitStatus ${order.walletDebitStatus}` });
    }
    if ((serviceCounts.get(order.purchaseId) || 0) > 1) {
      raise("DUPLICATE_SERVICE_FOR_ORDER", {
        ...base, amount: 0, expected: "One service per order", observed: `${serviceCounts.get(order.purchaseId)} services`,
        facts: { ...base.facts, services: serviceCounts.get(order.purchaseId) },
      });
    }

    for (const event of order.events) {
      if (event.from && event.to && !isAllowedWalletPurchaseTransition(event.from, event.to)) {
        raise("IMPOSSIBLE_TRANSITION", {
          ...base, amount: 0, subjectKey: order.key,
          expected: "Only forward state changes", observed: `${event.from} → ${event.to}`,
          facts: { ...base.facts, from: event.from, to: event.to, event: event.type },
        });
        break;
      }
    }
    if (order.completedAt && order.refundedAt) {
      raise("REFUNDED_AND_FULFILLED", {
        ...base, direction: "excess_in_wallet", expected: "Either a service or a refund", observed: "Both completedAt and refundedAt are set",
      });
    }

    const stuck = (observed, severity) => raise("ORDER_STUCK", { ...base, direction: "held", severity, expected: "Recovery finishes this within minutes", observed });
    if (["reserving", "reserved"].includes(order.status) && olderThan(order.createdAt, ctx.config.stuckMs, ctx)) stuck(`Still "${order.status}"`, "medium");
    else if (order.status === "provisioning" && olderThan(order.provisioningStartedAt || order.createdAt, ctx.config.stuckMs, ctx)) stuck('Still "provisioning"', "medium");
    else if (order.status === "provisioned" && olderThan(order.provisionedAt || order.createdAt, ctx.config.stuckMs, ctx)) stuck("Service created, commit pending", "medium");
    else if (order.status === "refund_pending" && !refunded && olderThan(order.refundRequestedAt || order.createdAt, ctx.config.stuckMs, ctx)) stuck("Refund requested, wallet entry not applied", "high");
    else if (["uncertain", "manual_review"].includes(order.status)) {
      raise("ORDER_NEEDS_REVIEW", {
        ...base, direction: "held", expected: "A definite provider result", observed: `Debit held as "${order.status}" (${order.errorCode || "no code"})`,
        facts: { ...base.facts, errorCode: order.errorCode },
      });
    } else if (order.status === "awaiting_provider" && olderThan(order.awaitingProviderSince || order.createdAt, ctx.config.awaitingProviderMs, ctx)) {
      raise("ORDER_AWAITING_PROVIDER", { ...base, direction: "held", expected: "Admin funds the provider and approves or cancels", observed: "Still waiting for provider funds" });
    }
  }

  for (const service of bundle.user.services || []) {
    const purchaseId = service?.purchaseId ? String(service.purchaseId) : null;
    if (!purchaseId || !service.productId || ownOrders.has(purchaseId)) continue; // trial services carry no productId
    raise("SERVICE_WITHOUT_ORDER", {
      subjectType: "wallet", subjectKey: `user:${bundle.userId}:service:${purchaseId}`.slice(0, 180), impactKey: `wallet:${purchaseId}`,
      expected: "An order for every purchased service", observed: "Service names an order that does not exist", facts: { ledgerKey: purchaseId },
    });
  }
}

function balanceRules(bundle, ctx, raise) {
  const { user } = bundle;
  const walletKey = `user:${bundle.userId}`;
  if (user.balance != null && wholeToman(user.balance) == null) {
    raise("INVALID_BALANCE", { subjectType: "wallet", subjectKey: `${walletKey}:invalid`, expected: "A whole Toman amount", observed: "The balance is not a safe integer" });
    return null;
  }
  const balance = wholeToman(user.balance) ?? 0;
  if (balance < 0) {
    raise("NEGATIVE_BALANCE", {
      subjectType: "wallet", subjectKey: `${walletKey}:negative`, amount: Math.abs(balance), direction: "owed_to_customer",
      expected: "Zero or more", observed: money(balance), expectedToman: 0, observedToman: balance,
    });
  }
  let reconstruction;
  try {
    reconstruction = reconstructBalance(bundle);
  } catch {
    raise("INVALID_BALANCE", { subjectType: "wallet", subjectKey: `${walletKey}:range`, expected: "Totals inside the safe integer range", observed: "A ledger total left the safe range" });
    return null;
  }
  if (reconstruction.drift) {
    const fullyLedgered = time(user.createdAt) >= ctx.config.ledgerEpoch.getTime();
    const provable = reconstruction.coverage === "complete" && fullyLedgered;
    const classification = provable ? "confirmed" : fullyLedgered ? "probable" : "informational";
    const severity = provable ? "high" : fullyLedgered ? "medium" : "info";
    raise("BALANCE_DRIFT", {
      subjectType: "wallet", subjectKey: walletKey, impactKey: walletKey, classification, severity,
      amount: Math.abs(reconstruction.drift), direction: reconstruction.drift > 0 ? "excess_in_wallet" : "owed_to_customer",
      expected: money(reconstruction.expected), observed: money(balance), expectedToman: reconstruction.expected, observedToman: balance,
      facts: { drift: reconstruction.drift, coverage: reconstruction.coverage, fullyLedgered, unresolved: reconstruction.unresolved.length, uncountedCredits: reconstruction.uncountedCredits, ...reconstruction.counts },
    });
  }
  return reconstruction;
}

/** All findings for one customer. A missing User with money records is itself a finding, never a crash. */
export function evaluateBundle(bundle, ctx) {
  const out = [];
  const raise = collector(bundle, out);
  if (!bundle.user) {
    for (const payment of bundle.payments) {
      if (!payment.confirmed) continue;
      raise("CONFIRMED_NOT_CREDITED", {
        subjectType: "payment", subjectKey: payment.key, amount: payment.amount, direction: "owed_to_customer",
        expected: "A wallet to credit", observed: "The invoice's owner does not exist", refs: [{ type: "payment", key: payment.key }],
        facts: { provider: payment.provider, status: payment.status, ownerMissing: true },
      });
    }
    return out;
  }
  const ledger = ledgerSets(bundle.user);
  paymentRules(bundle, ledger, ctx, raise);
  ledgerRules(bundle, ledger, ctx, raise);
  orderRules(bundle, ledger, ctx, raise);
  balanceRules(bundle, ctx, raise);
  const unique = new Map();
  for (const finding of out) if (!unique.has(finding.fingerprint)) unique.set(finding.fingerprint, finding);
  return [...unique.values()];
}
