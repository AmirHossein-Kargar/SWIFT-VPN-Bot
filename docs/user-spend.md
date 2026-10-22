# Persisted user spend (admin "Top spending" list)

The admin user list can be sorted by total spending. The original implementation computes each user's spend with a
per-user `$lookup` over `WalletPurchase`, which takes seconds at tens of thousands of users and hits its 8 s
`maxTimeMS` at roughly 50k. This feature keeps two **derived** counters on `User` so the ranking is an index scan.

| Field | Meaning |
|---|---|
| `User.totalSpent` | Sum of `WalletPurchase.amount` for the user's purchases with `status: "completed"` (Toman) |
| `User.completedOrderCount` | Number of those purchases |

Exactly the definition the aggregate uses: top-ups, admin balance edits and every non-completed purchase
(`reserving`, `reserved`, `provisioning`, `uncertain`, `provisioned`, `refund_pending`, `refunded`, `failed`,
`manual_review`) are excluded; revoked or expired services stay counted because their purchases stay `completed`.
**Nothing money-related reads these fields**; balances, purchase status, idempotency ledgers, payments and
provisioning are untouched by this feature.

## Flags

| Variable | Default | Effect |
|---|---|---|
| `USER_SPEND_SORT` | `aggregate` | `persisted` asks the list to use the counters. It is honored **only** while every condition in [When the persisted ranking is used](#when-the-persisted-ranking-is-used) holds; otherwise the exact aggregate is used and a warning is logged. |
| `USER_SPEND_HOOK` | on | `off` disables the best-effort recompute after a purchase completes. |
| `USER_SPEND_SWEEPER` | on | `off` disables the background sweeper. |

`off`, `false`, `0`, `disabled` and `no` turn the two boolean flags off. Any value other than `persisted` (compared
case-insensitively, surrounding spaces ignored) leaves the list on the aggregate.

## How the counters stay correct

* **Writer.** Every writer recomputes the user's full `(sum, count)` from `WalletPurchase` in one aggregation and
  *raises* the stored pair with one conditional update (a write is allowed only if neither stored field would
  decrease). The pair is replaced as a unit, so it is always exactly a pair some read returned; two independent
  `$max` could store a pair no read returned. The stored pair is never above the truth and converges to it as soon
  as one read starts after the last completion. Details and proof sketch: header of `services/users/userSpend.js`.
* **Hook.** After a purchase is committed as `completed` (`commitProvisionedPurchase`), a fire-and-forget recompute
  runs. It never throws, never blocks and cannot change the purchase result; failure only leaves the counters
  stale until the sweeper runs.
* **Sweeper** (`services/users/userSpendSweeper.js`, its own job, MongoDB lease, every 2 minutes). The two phases are
  isolated: a failure in one is recorded under its own checkpoint keys and never stops the other from running in the
  same tick, and the tick is reported healthy only when every phase that ran succeeded.
  Phase A re-reads recent completions through `idx_wallet_purchase_completed_at`; Phase B walks **every** user and
  repairs under-counts and missing counters, independent of any timestamp. Phase A is a latency optimisation
  covering write delay or clock skew up to 15 minutes; anything it misses is repaired by Phase B within one pass
  (users / 1000 ticks, about an hour at 30k users).
* **Over-counts are never lowered automatically.** They cannot be produced by this code; they would come from a
  manual edit or corruption. They are counted, sampled in the `user-spend-sweeper` checkpoint (`state.lastPass`),
  logged, and they switch the persisted ranking off.

## When the persisted ranking is used

`USER_SPEND_SORT=persisted` is only a request. The list uses the counters only while **all** of these hold (checked by
`evaluatePersistedSpendReadiness` in `services/users/userSpend.js`); anything else, including missing, malformed,
inconsistent or unreadable checkpoint data, falls back to the exact aggregate:

| # | Condition | Threshold |
|---|---|---|
| 1 | The last `--verify` was clean (`user-spend-verify` marker) and consistent | no missing, over or unexplained under-counts recorded |
| 2 | The sweeper has completed a fully successful tick (both phases) recently | within **15 minutes** (`SWEEPER_MAX_AGE_MS`; it ticks every 2 minutes) and not in the future by more than 5 minutes |
| 3 | No failure is outstanding | overall, scan-phase and reconcile-phase consecutive failures are all 0 |
| 4 | At least one reconcile pass has completed, recently | finished within max(**6 hours**, **3 x that pass's own duration**) |
| 5 | The last completed pass and the pass in progress reported no discrepancies | 0 missing counters, 0 under-counts, 0 over-counts |

Consequences to expect: a freshly deployed system is not ready until the sweeper has completed one full pass (about an
hour at 30k users); one transient sweeper failure, or one under-count found by a pass, switches the persisted ranking
off until the sweeper has succeeded again and a clean pass has completed (up to two pass durations after a
discrepancy); a stopped or failing sweeper switches it off after at most 15 minutes. The answer is cached for 30 seconds
(never beyond the moment it stops being fresh) and the sweeper drops it immediately in its own process, so a newly
detected problem takes effect within 30 seconds on every process.

## Rollout

1. Deploy with the defaults (`USER_SPEND_SORT` unset). The fields default to 0, the indexes build at startup
   (`idx_user_spend_rank`, `idx_wallet_purchase_completed_at`; create them beforehand with `createIndex` on a very
   large database to avoid a slow start), the hook and the sweeper start.
2. Backfill (resumable, safe while purchases continue; it only raises). What each CLI mode writes:
   `--dry-run` writes no counters and no progress but takes and releases the backfill lease (the `user-spend-backfill`
   document in `jobcheckpoints` is created if absent and its lease fields are set, then cleared), so it cannot run
   together with a real backfill; `--backfill` writes counters and its progress checkpoint; `--verify` writes no counters but
   writes the `user-spend-verify` marker. The script connects with `autoIndex` and `autoCreate` off, so it never builds
   indexes or creates collections as a side effect:
   `node scripts/user-spend-backfill.mjs --dry-run` then `--backfill --sleep-ms 50`.
3. Verify: `node scripts/user-spend-backfill.mjs --verify`. It exits 0 only when there are no missing counters, no
   over-counts and no unexplained under-counts, and it writes the verification marker that `USER_SPEND_SORT=persisted` needs.
   A lagging counter is excused as timing lag **only** when the whole gap (spent and count) is covered by purchases that
   completed within the last 30 seconds (`--grace-ms`, at most 300000): the stored counters must already contain everything
   older. A bigger gap, an older or future-dated purchase, malformed data, or no recent purchase is an *unexplained*
   under-count and fails the check. If a lagging user is reported, wait for the sweeper and run it again.
4. Let the sweeper finish one full Phase-B pass (`state.lastPass` in the `user-spend-sweeper` checkpoint document). This is
   now enforced: without a recent clean completed pass the persisted ranking stays off (see the table above).
5. Set `USER_SPEND_SORT=persisted` and restart. The page still shows exact totals (from the aggregate over the
   page's users); only the ranking uses the counters.

## Rollback

* `USER_SPEND_SORT` unset (or `aggregate`) and restart: the original query is back immediately.
* `USER_SPEND_SWEEPER=off` / `USER_SPEND_HOOK=off` stop the writers independently; neither affects money.
* The extra fields and indexes are inert and can stay. Reverting the code needs no data change (older code ignores
  unknown fields). Optional cleanup: `$unset` the two fields and drop the two indexes.

## Known limitations

* Freshness: the ranking can lag the truth by seconds (hook) to minutes (sweeper), and by up to one reconcile pass
  in the worst case. The user detail page and the displayed totals are always exact.
* The static guard test (`tests/unit/userSpendWriterGuard.test.js`) detects code that writes the literal status
  `"completed"` without the hook; a dynamically built status is invisible to it. The unreleased
  `services/manualFulfillment.js` completes purchases without the hook; it is not wired in today, and the guard test
  fails if it ever is.
* `$$NOW` / pipeline updates (MongoDB 4.2+) are required by the lease.
