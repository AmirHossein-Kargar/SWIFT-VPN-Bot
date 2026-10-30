# Reserved wallet orders (WizardXray wallet short of funds)

A customer with enough SWIFT VPN wallet balance can still hit an empty WizardXray provider wallet. The order is then
**reserved**, never refunded automatically and never lost, until an admin funds the provider and approves it (or cancels it).

## Flow

1. `purchasePlan` persists the order (`reserving`), atomically debits the customer wallet (`reserved`) and claims
   `provisioning` before calling `create`.
2. If WizardXray answers with an explicit, non-ambiguous refusal whose category is `provider_insufficient_balance`
   (`api/wizardApi.js`: HTTP 402, or a structured refusal body), the order moves `provisioning -> awaiting_provider` and
   `adminAlertPending` and `customerNoticePending` are set **in the same atomic update**. The customer is told the order is
   reserved and must not be repeated: the confirmation message, which already shows the `⏳` processing text, is edited to
   the notice (`deliverReservedNotice`, `services/buyService/reservedAlerts.js`). Only the outbox claim holder may send a new
   message when that edit fails; a retry of a delivered notice adds nothing. A notice lost to a Telegram failure or a crash
   is resent as a new message by the wallet recovery cycle (same backoff and cap as the admin alert), and an approval that
   finds the provider still short does not notify the customer again.
3. The admin group receives the order card (`services/buyService/reservedAlerts.js`) with
   `✅ تأیید و ایجاد سرویس`, `🔄 بررسی مجدد وضعیت`, `❌ لغو سفارش` (cancel asks for confirmation).
   Delivery is an outbox: claimed, retried by the existing wallet recovery cycle with exponential backoff (max 12 attempts).
   A failed Telegram send never affects the order; the recovery queue (`awaiting-provider-funds` /
   `awaiting-provider-alert-failed`) lists it regardless.
4. **Approve** (`rsv:ok:<order _id>`, `services/buyService/reservedFulfillment.js`): admin check, live-reservation check, then an
   atomic `awaiting_provider -> provisioning` claim. Exactly one concurrent approval wins. The same provider step as a normal
   purchase then runs (`runProviderCreation`): success -> `provisioned -> completed` and delivery through the existing
   notification outbox; still short -> back to `awaiting_provider`; ambiguous -> `manual_review` (never replayed).
5. **Cancel** (`rsv:no` then `rsv:nc`): only from `awaiting_provider`; uses the existing idempotent refund
   (`refundPurchaseReservation`, ledger key = order id). An order that is `provisioning` cannot be cancelled.

```
provisioning --(provider proven short)--> awaiting_provider
awaiting_provider --(admin approve, atomic claim)--> provisioning --> provisioned --> completed
awaiting_provider --(admin cancel)--> refund_pending --> refunded
```

## Invariants

- The customer is debited once (`appliedPurchaseReservations` key = order id); approvals never debit again.
- The provider is charged only by WizardXray's own `create`; the bot never debits it separately.
- An order becomes `completed` only after a validated provider response is persisted; an approve click alone proves nothing.
- Callback data carries only an opaque order `_id`; price, plan and user always come from the persisted order.
- `events` keeps a bounded, sanitized transition history (shown in the admin payment timeline).

## Limits (provider API)

- WizardXray `create` has no idempotency key and no lookup by external reference. After an ambiguous outcome the order is
  held in `manual_review` for manual reconciliation against the panel; it is never auto-replayed.
- The documented `status` method exposes per-GB/per-day prices, not the wallet balance, so "recheck" re-reads the order
  state; it cannot verify provider funds before an approval attempt.
- Telegram inline keyboards cannot set spacing between rows; the four duration buttons are one per row.
