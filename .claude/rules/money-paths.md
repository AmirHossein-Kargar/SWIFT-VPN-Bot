---
paths:
  - "services/**"
  - "paymentHandlers/**"
  - "models/**"
  - "api/**"
  - "handlers/**"
  - "config/db.js"
  - "config/mongoIndexMigration.js"
---

# Money-path invariants

Behaviour and rationale are documented in `docs/payments.md` and `docs/reserved-orders.md`; this file lists what a
change must never break. If a change needs to break one, stop and ask the owner.

- **Credit only after verification.** A wallet is credited only after the provider's signed callback (HooshPay HMAC,
  NOWPayments IPN signature) or an authenticated status check is verified, the amount matches and the invoice is known.
  Rejected callbacks change nothing.
- **Atomic, idempotent writes.** Every balance change is a single-document conditional MongoDB update guarded by a state
  flag or unique operation/purchase id (`fulfilled`, `balanceCredited`, unique indexes). Duplicate or concurrent
  deliveries must lose the race and change nothing. Never read-modify-write a balance.
- **Crash safety.** Multi-phase flows leave a resumable state that a recovery cron completes exactly once. A new phase
  needs a recovery path and a test for the crash between phases.
- **Redis is never authoritative.** Locks may fail open; MongoDB guards must still guarantee a single credit or debit.
- **Provisioning.** Ambiguous WizardXray results are never replayed (its `create` has no idempotency key); they are held
  for admin review. Definitive failures refund exactly once. A proven provider balance shortage parks the order as
  `awaiting_provider` with the debit kept; it is never auto-refunded.
- **Trust persisted data, not callbacks.** Telegram callback data carries opaque ids only; price, plan and user always
  come from the stored record.
- **Units.** Amounts are stored and shown in Toman and are never divided by 10 (Gheymat's `IRT` is already Toman).
- **Catalog.** Checkout, storefront and quotes read plans from `AdminProduct` through `services/plans.js`.
- **Indexes.** Unique indexes are part of the money guarantees. Changing a schema or index needs a migration path in
  `config/mongoIndexMigration.js` (or a documented reason it is safe) and Mongo-backed tests.
- **Sentinel stays read-only and complete.** `services/sentinel` writes only `SentinelFinding` and its checkpoint, and reaches
  money collections only through `readOnly.js`. A new balance writer or ledger key must be taught to `services/sentinel/ledger.js`
  and `bundle.js` in the same change, or every affected wallet reports as drift. See `docs/sentinel.md`.
- **Telemetry observes, and only observes.** Money code may call the `observe*` functions in `services/reliability/telemetry.js`, which are
  synchronous, never throw and do no I/O. Never await one, branch on one, or read `Reliability*` collections from a money path. See
  `docs/reliability.md`.
- **Logging.** Log `errorType`/`code`/status only; never provider payloads, tokens, card numbers or full ids.

Tests for these paths are Mongo-backed and skip without a disposable MongoDB; see
`.claude/skills/swift-test/SKILL.md` before claiming a money change is verified.
