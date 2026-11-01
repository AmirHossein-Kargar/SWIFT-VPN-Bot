/**
 * What a finding means to the person reading it: why it matters, the likely cause (always labelled as a hypothesis, the
 * proven part is in the finding's own expected/observed and evidence) and the safe ways forward.
 *
 * Remediation here is advice, on purpose. An option names an EXISTING audited tool, which has its own permission check,
 * idempotency key and audit record; Sentinel has no code that performs any of them, and this module imports nothing
 * that could. Options are computed on the server from the finding, so a browser cannot invent one.
 */
import { catalogEntry } from "./constants.js";

const reference = (finding) => encodeURIComponent(String(finding.subjectKey).split(":").slice(1).join(":"));

const retryPayment = (finding) => ({
  id: "retry_payment",
  label: "Retry from Payments",
  tool: "Payments",
  href: `/payments?search=${reference(finding)}`,
  risk: "low",
  consequence: "Runs the existing idempotent credit path. The ledger key stops a second credit, and the retry is audited.",
});
const openRecovery = () => ({
  id: "open_recovery",
  label: "Open the Recovery queue",
  tool: "Recovery",
  href: "/recovery",
  risk: "low",
  consequence: "Shows this record with the recovery steps that are safe for its state. Nothing runs until an admin chooses it.",
});
const compensate = (finding, direction) => ({
  id: direction === "add" ? "compensating_credit" : "compensating_debit",
  label: direction === "add" ? "Credit the wallet with a compensating entry" : "Debit the wallet with a compensating entry",
  tool: "Users",
  href: `/users?search=${encodeURIComponent(finding.userId)}`,
  risk: "high",
  amountToman: finding.amountToman || null,
  consequence: `${direction === "add"
    ? "Adds a new audited ledger entry. Confirm the amount first; a wrong credit is real money."
    : "Adds a new audited ledger entry. It fails rather than overdraw, and the customer may notice the change."} History is never edited, so this finding stays open afterwards: dismiss it and name the operation in the reason.`,
});
const providerCheck = (label = "Check the provider's dashboard") => ({
  id: "verify_with_provider",
  label,
  tool: "Provider dashboard",
  href: null,
  risk: "none",
  consequence: "Establishes what really happened at the provider. Changes nothing here.",
});
const manualReconcile = () => ({
  id: "reconcile_on_panel",
  label: "Reconcile against the WizardXray panel",
  tool: "Recovery",
  href: "/recovery",
  risk: "medium",
  consequence: "Establishes whether the service exists. Never repeat the create call: it has no idempotency key and would charge the provider wallet again.",
});
const noAction = () => ({
  id: "no_action",
  label: "No correction needed",
  tool: null,
  href: null,
  risk: "none",
  consequence: "Keeps the record for reference.",
});

const EXPLANATIONS = {
  CONFIRMED_NOT_CREDITED: {
    why: "The provider confirmed this money but the customer's wallet never received it.",
    cause: "A crash or database failure between confirmation and the atomic credit. If the owner is missing, the credit cannot apply until that is settled.",
    options: (finding) => [retryPayment(finding), providerCheck()],
  },
  CREDIT_FLAG_PENDING: {
    why: "The customer has the money. Only the invoice's own completion flag is behind, so reports may show it as unpaid.",
    cause: "The process stopped between the wallet credit and the invoice update. The recovery cron normally finishes this.",
    options: (finding) => [retryPayment(finding), noAction()],
  },
  CREDITED_WITHOUT_LEDGER: {
    why: "The invoice claims a credit, but the wallet holds no key for it. Either the customer was never paid or the key was lost.",
    cause: "A write outside the normal credit path, or a manual database edit: the normal path cannot set the flag without the key.",
    options: (finding) => [providerCheck("Compare the wallet's history with this invoice"), compensate(finding, "add")],
  },
  CREDIT_ON_UNCONFIRMED_PAYMENT: {
    why: "The wallet was credited for a payment nobody confirmed, so the balance may include money that never arrived.",
    cause: "The provider status changed after the credit, or a manual edit. This is a contradiction, not evidence of intent.",
    options: (finding) => [providerCheck(), compensate(finding, "remove")],
  },
  LEGACY_CREDIT_UNVERIFIABLE: {
    why: "This payment predates the ledger, so whether it was credited cannot be proven from the records alone.",
    cause: "Older code wrote no ledger key and recovery deliberately refuses to replay it, because a second credit is worse than a question.",
    options: () => [noAction(), providerCheck("Check the customer's history if they report a problem")],
  },
  REVERSED_AFTER_CREDIT: {
    why: "The provider took the money back, and the wallet still holds it. Webhooks never debit a wallet by themselves.",
    cause: "A chargeback or refund at the provider after settlement.",
    options: (finding) => [providerCheck("Confirm the reversal at the provider"), compensate(finding, "remove")],
  },
  LATE_PAYMENT_UNCREDITED: {
    why: "Money may have arrived for an invoice that was already closed or removed. Nothing was credited, by design.",
    cause: "The customer paid after expiry or after the invoice was cleaned up.",
    options: (finding) => [providerCheck(), compensate(finding, "add")],
  },
  PROVIDER_EVIDENCE_MISMATCH: {
    why: "A signed callback disagrees with what was stored, so it was held instead of credited.",
    cause: "A changed amount or currency at the provider, or a callback for another invoice.",
    options: (finding) => [providerCheck(), openRecovery()],
  },
  UNDERPAID_PAYMENT: {
    why: "The provider reports less crypto than the invoice asked for.",
    cause: "The customer sent too little, or fees reduced the amount. Whether the shortfall is acceptable is a business decision.",
    options: () => [providerCheck(), noAction()],
  },
  DUPLICATE_PROVIDER_REFERENCE: {
    why: "Several confirmed invoices carry one provider tracking code, so one payment may have been credited more than once.",
    cause: "The provider reusing a code, or one transfer reported against two invoices. Check before assuming a duplicate.",
    options: (finding) => [providerCheck(), compensate(finding, "remove")],
  },
  REPEATED_CALLBACKS: {
    why: "The provider delivered its confirmation several times. The keyed credit absorbed the repeats, so this is the system working.",
    cause: "Provider retries, usually because an earlier response was slow.",
    options: () => [noAction()],
  },
  PAYMENT_STUCK: {
    why: "This payment has not reached a final state in the expected time. Money may be waiting on it, and an unknown creation also blocks the customer's next crypto invoice.",
    cause: "A provider delay, a missed callback, or a timed-out invoice creation.",
    options: () => [openRecovery(), providerCheck()],
  },
  PAYMENT_STATE_CONTRADICTION: {
    why: "The invoice's own fields cannot all be true, so its status cannot be trusted until checked.",
    cause: "A write outside the normal path, or a manual edit.",
    options: () => [openRecovery(), noAction()],
  },
  LEDGER_KEY_WITHOUT_PAYMENT: {
    why: "The wallet was credited under a key no invoice explains, so the amount cannot be established from the records.",
    cause: "The invoice was removed by hand, or the key uses a format this version does not recognise.",
    options: () => [providerCheck("Trace this key in the backups or provider history")],
  },
  KEY_OWNER_MISMATCH: {
    why: "This wallet's ledger names a record owned by someone else, so money may be on the wrong account.",
    cause: "A manual edit, or an account merge outside the normal path.",
    options: (finding) => [providerCheck("Compare both customers' history"), compensate(finding, "remove")],
  },
  DUPLICATE_LEDGER_KEY: {
    why: "One ledger key appears twice. The normal path adds keys as a set, so this cannot come from it.",
    cause: "A manual database edit or a restored backup merged by hand.",
    options: () => [providerCheck("Compare the balance with the reconstruction before acting")],
  },
  BALANCE_DRIFT: {
    why: "The stored balance differs from the balance the ledger implies.",
    cause: "When coverage is partial the difference is usually history from before the ledger (October 2026). When coverage is complete, something changed the balance outside the keyed paths.",
    options: (finding) => (finding.classification === "informational"
      ? [noAction(), providerCheck("Review this customer's history if they report a problem")]
      : [providerCheck("Explain the difference from the wallet entries first"), compensate(finding, finding.direction === "owed_to_customer" ? "add" : "remove")]),
  },
  NEGATIVE_BALANCE: {
    why: "A debit requires sufficient balance in the same atomic update, so a negative balance should be impossible.",
    cause: "A write outside the normal path.",
    options: (finding) => [compensate(finding, "add")],
  },
  INVALID_BALANCE: {
    why: "Balances are whole Toman. This one is not, so no calculation about this wallet can be trusted.",
    cause: "A manual edit, or an amount from before the integer rules.",
    options: () => [providerCheck("Review the wallet's raw record")],
  },
  ADMIN_KEY_WITHOUT_AUDIT: {
    why: "A balance change has no audit record, so neither its amount nor its author is known.",
    cause: "The audit record was removed. Every admin balance change writes its audit first.",
    options: () => [providerCheck("Trace this operation in the backups")],
  },
  ADMIN_AUDIT_OUTCOME_MISMATCH: {
    why: "The audit log and the ledger disagree about an admin adjustment, so the reported outcome may be wrong.",
    cause: "The process stopped between the balance update and the audit update.",
    options: () => [noAction()],
  },
  PAYMENT_COUNTER_MISMATCH: {
    why: "The payment counter moves together with each ledger key, so being behind it is unexpected. No balance depends on it.",
    cause: "A manual edit of the counter.",
    options: () => [noAction()],
  },
  RESERVATION_MISSING: {
    why: "The order claims a debit the wallet never recorded. The customer may have received a service without paying.",
    cause: "A write outside the normal path. The normal flow cannot pass `reserving` without the key.",
    options: (finding) => [providerCheck("Compare the wallet entries with this order"), compensate(finding, "remove")],
  },
  RESERVATION_WITHOUT_ORDER: {
    why: "The wallet was debited for an order that has no record, so the customer lost money for nothing visible.",
    cause: "The order row was removed.",
    options: () => [providerCheck("Trace this order in the backups")],
  },
  DEBIT_NOT_RECORDED_ON_ORDER: {
    why: "The money left the wallet but the order does not show it. Recovery normally settles this one way or the other.",
    cause: "A crash between the debit and the order update.",
    options: () => [openRecovery()],
  },
  FAILED_ORDER_DEBIT_KEPT: {
    why: "The order failed and the customer's money was not returned.",
    cause: "The refund step was skipped after a failure.",
    options: (finding) => [compensate(finding, "add")],
  },
  COMPLETED_NOT_COMMITTED: {
    why: "The order is complete but the service is missing from the customer's account.",
    cause: "The commit to the user failed. If this reads informational the commit happened and the service was deleted later, before deletions were recorded on the order.",
    options: () => [openRecovery(), manualReconcile()],
  },
  DEBIT_STATUS_MISMATCH: {
    why: "The order's debit label disagrees with its state. The money itself is not affected.",
    cause: "An older write path that did not set the label.",
    options: () => [noAction()],
  },
  DUPLICATE_SERVICE_FOR_ORDER: {
    why: "One order delivered several services, so the provider wallet may have been charged more than once.",
    cause: "A manual fulfilment on top of an automatic one.",
    options: () => [manualReconcile()],
  },
  SERVICE_WITHOUT_ORDER: {
    why: "A paid service names an order that does not exist.",
    cause: "The order row was removed.",
    options: () => [providerCheck("Trace this order in the backups")],
  },
  ORDER_STUCK: {
    why: "This order should have moved on by now, and the customer's money is held until it does.",
    cause: "The recovery cycle has not finished it. A cycle may be failing.",
    options: () => [openRecovery(), manualReconcile()],
  },
  ORDER_NEEDS_REVIEW: {
    why: "The provider's answer was ambiguous, so the debit is held until a person decides. The system will not guess.",
    cause: "A timeout or malformed response from WizardXray, after which the service may or may not exist.",
    options: () => [manualReconcile()],
  },
  ORDER_AWAITING_PROVIDER: {
    why: "The customer paid and is waiting while the provider wallet is short of funds.",
    cause: "The WizardXray wallet needs funding.",
    options: () => [openRecovery()],
  },
  IMPOSSIBLE_TRANSITION: {
    why: "The order's history contains a state change the schema forbids, so that history cannot be relied on.",
    cause: "A write that bypassed the transition guard.",
    options: () => [providerCheck("Review this order's full history")],
  },
  REFUND_WITHOUT_LEDGER: {
    why: "The order says refunded, but the wallet never received the money. The customer may have been told otherwise.",
    cause: "A write outside the normal path. The normal refund applies the ledger entry first.",
    options: (finding) => [compensate(finding, "add")],
  },
  REFUND_RECORD_PENDING: {
    why: "The customer has the refund. Only the order's own record is behind.",
    cause: "The process stopped between the wallet credit and the order update.",
    options: () => [openRecovery(), noAction()],
  },
  REFUNDED_AND_FULFILLED: {
    why: "The customer holds both the refund and the service.",
    cause: "A refund raced a provider success.",
    options: (finding) => [manualReconcile(), compensate(finding, "remove")],
  },
  REFUND_CONTRADICTS_ORDER: {
    why: "A refund was applied to an order that is not refunding.",
    cause: "A write outside the normal path.",
    options: (finding) => [providerCheck("Compare the wallet entries with this order"), compensate(finding, "remove")],
  },
  REFUND_AMOUNT_MISMATCH: {
    why: "A refund must equal its debit. This one does not.",
    cause: "A manual edit of the order. The normal path refuses this mismatch.",
    options: () => [providerCheck("Compare the wallet entries with this order")],
  },
  REFUND_WITHOUT_DEBIT: {
    why: "The wallet received a refund for money it never paid.",
    cause: "A manual edit. The normal refund requires the debit key.",
    options: (finding) => [compensate(finding, "remove")],
  },
  REFUND_WITHOUT_ORDER: {
    why: "A refund has no order, so the amount cannot be established.",
    cause: "The order row was removed.",
    options: () => [providerCheck("Trace this order in the backups")],
  },
};

export function explainFinding(finding) {
  const entry = EXPLANATIONS[finding.code];
  return {
    title: catalogEntry(finding.code).title,
    why: entry?.why ?? null,
    likelyCause: entry?.cause ?? null,
    options: entry ? entry.options(finding) : [],
  };
}

export const explainedCodes = () => Object.keys(EXPLANATIONS);
