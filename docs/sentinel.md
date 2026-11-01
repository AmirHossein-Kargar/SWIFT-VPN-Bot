# Money Flow Sentinel

A financial monitoring and reconciliation center at `/panel/sentinel`. It follows money from payment to service, compares
the records with each other, and explains what does not add up. **It never changes money.** It runs inside the one bot
process: no worker, no extra Railway service, no second polling client.

- [Where the facts come from](#where-the-facts-come-from)
- [The lifecycle](#the-lifecycle)
- [Reconciliation](#reconciliation)
- [What is detected](#what-is-detected)
- [Live activity](#live-activity)
- [Investigation and remediation](#investigation-and-remediation)
- [The no-mutation guarantee](#the-no-mutation-guarantee)
- [Indexes and cost](#indexes-and-cost)
- [Limitations](#limitations)

## Where the facts come from

There is no ledger collection. The ledger is a set of key arrays on `User`, each written in the same atomic update as the
balance it changes (see [payments](payments.md)). Keys hold no amounts; amounts come from the record each key names.

| Ledger array | Effect | Amount from | Written by |
|---|---|---|---|
| `appliedPaymentKeys` (`hooshpay:<uid>`, `nowpayments:<orderId>`, `bank:<paymentId>`, `trx:<invoiceId>`) | + | The invoice | `services/walletCredit.js` |
| `appliedPurchaseReservations` (order id) | − | `WalletPurchase.amount` | `reserveBalance` |
| `refundedPurchaseIds` (order id) | + | `WalletPurchase.amount` | `refundPurchaseReservation` |
| `appliedAdminBalanceKeys` (`operationId`) | ± | `AdminAuditLog.metadata` | `changeUserBalance` |
| `completedPurchaseIds` | none | | Service commit; also holds trial attempt ids |

One read of a `User` is a consistent cut of balance and keys, and the amounts behind a key are immutable once the key
exists, because the invoice or order is written first. So `balance = credits − debits + refunds ± admin` needs no lock or
transaction. Other evidence: `HooshPayInvoice.webhookLog`, `NowPaymentsInvoice.ipnLog`, `WalletPurchase.events` and
`PaymentTombstone`. Only named fields are read: card details, addresses, service links, receipts and provider payloads
never enter the module, so they cannot reach a finding, a log line or a browser.

**Payments and orders meet only at the wallet.** A wallet is fungible, so no record proves that one payment paid for one
order. The only such link Sentinel shows is the NOWPayments `planId` hint, labelled *Inferred*.

**Ledger epoch.** The key arrays shipped on 2026-10-04. A record from before `SENTINEL_LEDGER_EPOCH` (default
2026-10-05) may have moved money without a key, so it is counted as *inferred* from its own claims and the reconstruction
is labelled **partial**. `successfulPayments` exceeding the keys also means partial: credits happened that left no trace.

## The lifecycle

`services/sentinel/projection.js` derives the stages. An event exists only if its timestamp exists, and each names its
source field. A step with no evidence reads *Not yet*; a time is never guessed.

| Record | Stages |
|---|---|
| Top-up | Initiated → provider confirmed → wallet credited, or → reversed. Ends at the wallet |
| Order | Reserved → provisioning → (awaiting provider) → delivered, or → refund requested → refund applied |

Orders are prepaid, so delivery **is** consumption: the debit is finalized then. Usage of a service moves no money.

## Reconciliation

`services/sentinel/reconciler.js` runs every `SENTINEL_INTERVAL_SECONDS` under a MongoDB lease (`JobCheckpoint`
`money-flow-sentinel`). One tick evaluates a bounded set of customers:

- **Priority** (up to 100): owners of recent records, of open exceptions found through the recovery indexes, and of open
  confirmed or probable findings, so a repaired problem clears quickly. A third of the slots are kept for open findings, and
  informational ones wait for the rolling pass, so a legacy backlog cannot crowd out live problems.
- **Rolling** (`SENTINEL_USERS_PER_TICK`): the next users by `_id` from a persisted cursor, wrapping around, so every wallet
  is checked once per pass however quiet it is.

A tick stops at its 45-second budget with the cursor where it got to. `rules.js` holds the detection as pure functions.

**Races.** Every writer stores the ledger key first and the record flag second, so `bundle.js` reads the records first and
the `User` **last**: if a record says "applied", the key must be visible. The reverse direction ("the key exists, so the
record must show it") can catch a writer between its two steps, so those rules wait `SENTINEL_GRACE_MINUTES`, and anything
new is read a second time before it is stored.

**Idempotence.** A finding's `fingerprint` is `code:subject`, unique in `SentinelFinding`. A rerun or a concurrent run lands
on the same row, and unchanged evidence is not rewritten. A problem that disappears is `cleared`, kept 180 days, and
reopened if it returns.

**Classification** is the strength of the evidence, never a suspicion of fraud:

| Class | Meaning |
|---|---|
| Confirmed | The records contradict each other; nothing has to be assumed |
| Probable | The records point at a problem, but a legitimate explanation exists |
| Informational | Worth knowing; no inconsistency is claimed |

**Exposure** (`computeExposure`) counts money once: findings about one payment share an `impactKey`, and a balance drift
and the records explaining it are the same money, so per customer and direction the larger wins. Informational and
dismissed findings carry none. Each lifecycle stage shows its own total; stages are never added together.

## What is detected

| Code | Class | Severity | Means |
|---|---|---|---|
| `CONFIRMED_NOT_CREDITED` | Confirmed | High | Provider confirmed, no credit |
| `CREDITED_WITHOUT_LEDGER` | Confirmed | Critical | Invoice claims a credit the wallet lacks |
| `CREDIT_ON_UNCONFIRMED_PAYMENT` | Confirmed | Critical | Wallet credited for an unconfirmed or removed invoice |
| `CREDIT_FLAG_PENDING` | Probable | Low | Wallet credited, invoice flag behind |
| `REVERSED_AFTER_CREDIT` | Confirmed | High | Provider reversed; the wallet still holds it |
| `LATE_PAYMENT_UNCREDITED` | Probable | Medium | Payment reported after the invoice closed or was removed |
| `PROVIDER_EVIDENCE_MISMATCH` | Probable | Medium | Signed callback disagrees with the stored invoice |
| `UNDERPAID_PAYMENT` | Probable / Info | Medium / Low | Less crypto than the invoice asked |
| `DUPLICATE_PROVIDER_REFERENCE` | Probable | High | One HooshPay tracking code on several confirmed invoices |
| `REPEATED_CALLBACKS` | Info | Info | Three or more confirmations absorbed by the keyed credit |
| `LEGACY_CREDIT_UNVERIFIABLE` | Info | Info | Confirmed legacy payment with no ledger evidence |
| `PAYMENT_STUCK` | Probable / Info | Medium / Low | Unknown creation, or stuck at the provider or awaiting approval |
| `PAYMENT_STATE_CONTRADICTION` | Confirmed | Medium | An invoice's own fields cannot all be true |
| `BALANCE_DRIFT` | Confirmed / Probable / Info | High / Medium / Info | Balance differs from the ledger; see below |
| `NEGATIVE_BALANCE`, `INVALID_BALANCE` | Confirmed | Critical | Impossible balance |
| `LEDGER_KEY_WITHOUT_PAYMENT` | Probable | High | Credit no invoice or tombstone explains |
| `KEY_OWNER_MISMATCH` | Confirmed | Critical | Ledger entry names another customer's record |
| `DUPLICATE_LEDGER_KEY` | Confirmed | Critical | One key twice in an array |
| `ADMIN_KEY_WITHOUT_AUDIT` | Confirmed | High | Balance change without an audit record |
| `ADMIN_AUDIT_OUTCOME_MISMATCH` | Probable | Medium | Audit and ledger disagree |
| `PAYMENT_COUNTER_MISMATCH` | Probable | Low | `successfulPayments` behind the keys |
| `RESERVATION_MISSING` | Confirmed | Critical | Order claims a debit the wallet lacks |
| `RESERVATION_WITHOUT_ORDER` | Confirmed | High | Debit with no order |
| `DEBIT_NOT_RECORDED_ON_ORDER` | Probable | Medium | Debited, order says `not_debited` |
| `FAILED_ORDER_DEBIT_KEPT` | Confirmed | Critical | Failed order kept the money |
| `COMPLETED_NOT_COMMITTED` | Confirmed | High | Completed with no commit entry, so nothing was delivered. A service delivered and later deleted is not this: both delete paths set `revokedAt`, and with no such mark it reads Informational, with no money owed |
| `DEBIT_STATUS_MISMATCH` | Confirmed | Low | Debit label disagrees with the state |
| `DUPLICATE_SERVICE_FOR_ORDER` | Confirmed | High | One order, several services |
| `SERVICE_WITHOUT_ORDER` | Probable | Medium | Paid service names a missing order |
| `ORDER_STUCK` | Probable | Medium / High | Intermediate state past `SENTINEL_STUCK_MINUTES` |
| `ORDER_NEEDS_REVIEW` | Probable | High | Debit held on an ambiguous provider result |
| `ORDER_AWAITING_PROVIDER` | Info | Medium | Waiting past `SENTINEL_AWAITING_PROVIDER_HOURS` |
| `IMPOSSIBLE_TRANSITION` | Confirmed | High | A state change the schema forbids |
| `REFUND_WITHOUT_LEDGER` | Confirmed | Critical | Order says refunded, wallet lacks it |
| `REFUND_RECORD_PENDING` | Probable | Medium | Refund applied, order behind |
| `REFUNDED_AND_FULFILLED` | Confirmed | Critical | Customer holds both |
| `REFUND_CONTRADICTS_ORDER` | Confirmed | High | Refund on an order in another state |
| `REFUND_AMOUNT_MISMATCH` | Confirmed | High | Refund differs from the debit |
| `REFUND_WITHOUT_DEBIT` | Confirmed | Critical | Refund with no debit |
| `REFUND_WITHOUT_ORDER` | Confirmed | High | Refund with no order |

`BALANCE_DRIFT` is **confirmed** only for a customer created after the epoch with a complete reconstruction. A partial
reconstruction is **probable**. A customer from before the epoch is **informational**: their history cannot prove a fault.

## Live activity

There are no change streams here: they need a replica set, and nothing in this project uses them. `GET /sentinel/live` is a
stateless indexed poll, every 10 seconds, labelled as polling in the UI. Each cursor overlaps the last by two minutes so an
event written just behind a poll is not lost; events have stable ids (`<key>#<stage>`), so repeats and late arrivals merge
without duplicates and in time order. A hidden tab stops polling, failures back off to 60 seconds, and a source that fails
is listed as degraded instead of failing the page. *Live* means a recent successful poll and nothing else; older data reads
*Delayed* or *Stale*. Findings refresh on the reconciliation interval, not every 10 seconds.

## Investigation and remediation

Opening a finding reads the records again and states whether it **still reproduces**. Opening it changes nothing.

| Review | Rule |
|---|---|
| Investigating | A note for other admins |
| Fix proposed | Must name an option the server still offers, and the problem must still reproduce |
| Resolved | **Refused while the records still reproduce the problem**, so a note cannot make a discrepancy disappear |
| Dismissed | Leaves the totals. It covers the evidence it was made on: if that changes, the finding returns to *New* |

Every decision goes through `runAuditedAction` (`SENTINEL_FINDING_REVIEWED`), with a reason of at least 10 characters and a
compare-and-set on the current review, so two admins cannot overwrite each other unseen. `SENTINEL_RECONCILE_RUN` audits a
manual check.

**Remediation is advice.** Each option links to an existing audited tool (Payments retry, Recovery, or the Users balance
action), which has its own confirmation, idempotency key and audit record. Sentinel has no execution path. Corrections are
compensating entries; history is never edited. A compensation therefore does not erase a contradiction that really
happened: dismiss the finding and name the operation in the reason.

## The no-mutation guarantee

- `services/sentinel/readOnly.js` is the only door to money collections. It exposes reads; any other member throws, and
  aggregations are checked for `$out` and `$merge`. The [Service Reliability Center](reliability.md) reads through the same door.
- `findingsStore.js` is the only writer, and knows only `SentinelFinding`. The job also writes its own `JobCheckpoint` row.
- No Sentinel module imports code that credits, refunds, provisions or calls a provider.
- `tests/unit/sentinelReadOnly.test.js` scans the folder for these rules. `tests/integration/sentinel.mongo.test.js` proves
  every money collection is byte-identical after detection, every read view and every review.

Nothing in the payment, wallet or order code reads `SentinelFinding`. Deleting the collection changes no balance.

Access is the normal `/api/admin` stack: session, CSRF, same-origin, rate limits (`/live` 60/min, `/reconcile` 6/min). Every
parameter is validated to a scalar of a known shape. Lists mask Telegram IDs; a finding or transaction page shows the full
ID, and the copied report keeps it masked.

## Indexes and cost

All additive and non-unique, created at startup by `createIndexes()`. None changes a money guarantee, so no migration is
needed; on a very large collection the first build can delay one boot.

| Collection | Index | Serves |
|---|---|---|
| `HooshPayInvoice`, `NowPaymentsInvoice`, `CryptoInvoice`, `invoice` | `idx_sentinel_credited` (partial) | Credited-money feed and totals |
| `HooshPayInvoice` | `idx_sentinel_tracking` (sparse) | One tracking code on several invoices |
| `WalletPurchase` | `idx_sentinel_refunded` (partial) | Refund feed and totals |
| `PaymentTombstone` | `idx_sentinel_tombstone_user`, `idx_sentinel_tombstone_late` | A customer's removed invoices; late payments |

Creation-time ranges use `_id`, which every collection indexes, and `_id` keyset pagination avoids `skip()` over money
collections. Customers are loaded in batches of 25 through existing `userId` and `telegramId` indexes, with a row limit:
a batch that hits it is split, and a single customer beyond it is marked partial. Every query has a timeout. Overview and
flow aggregates are cached for 30 and 15 seconds in this process.

## Limitations

- **Sentinel sees our records, not the provider's.** It never calls a provider, so a payment whose confirmation never
  reached us is invisible until it does.
- **Pre-ledger history cannot be proven.** Customers from before the epoch get informational drift at most.
- **No per-transaction balance history.** Only the current balance is stored, so a running balance is shown only when the
  reconstruction is complete and exact.
- **A ledger key whose record was removed by hand has no amount.** It is reported as `LEDGER_KEY_WITHOUT_PAYMENT` and the
  reconstruction is partial; Sentinel will not guess the figure.
- **Tracking codes** are compared for HooshPay only. The other providers' references are unique indexes already.
- **Admin API purchases** (`API_SERVICE_PURCHASE`) spend the provider wallet, not a customer wallet, so they are outside
  this reconciliation; they keep their own ledger in `services/admin/apiPurchaseLedger.js`.
- **Web admins have no roles or step-up authentication** beyond owner-only routes, so every admin can review findings.
- **No alerts leave the panel.** Sentinel does not message the admin group.
- A customer with more than 4,000 rows in one collection is reconciled on a truncated view and labelled partial.
- Transactions search the last 30 days unless a range is given.
