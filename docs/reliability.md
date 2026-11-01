# Service Reliability Center

An operational command center at `/panel/reliability`. It answers four questions: is the system working, what is not, which
orders are affected, and what shows it. **It reads and reports; it changes nothing.** It runs inside the one bot process: no
worker, no extra Railway service, no second polling client, and no new dependency.

- [Pages](#pages)
- [Health states](#health-states)
- [Where the data comes from](#where-the-data-comes-from)
- [Telemetry that does not exist](#telemetry-that-does-not-exist)
- [Metrics and windows](#metrics-and-windows)
- [Incidents](#incidents)
- [Real-time delivery and freshness](#real-time-delivery-and-freshness)
- [Topology and motion](#topology-and-motion)
- [The no-interference guarantee](#the-no-interference-guarantee)
- [Storage, indexes and cost](#storage-indexes-and-cost)
- [Troubleshooting](#troubleshooting)
- [Testing](#testing)

## Pages

| Tab | Route | Shows |
|---|---|---|
| Command center | `/panel/reliability` | Overall state, signals for 15 minutes to 24 hours, the service topology with a detail panel, open incidents, recent events |
| Incidents | `/reliability/incidents[/:id]` | Open and resolved incidents; evidence, blast radius, affected orders, next steps, correlated events |
| Events | `/reliability/events` | Operational timeline, filtered by range, severity, component and type |
| Order trace | `/reliability/orders[/:id]` | Unresolved orders oldest first; one order's lifecycle; lookup by order id or Telegram ID |
| History | `/reliability/history` | Throughput, failures, P95 latency and each component's state over time, with a table view |

The sidebar entry is **Service reliability** under System. `/panel/system-health` stays as it is: an on-demand reading of the
same checks, without history, incidents or topology.

## Health states

| State | Means |
|---|---|
| Healthy | Recent **positive** evidence that it works |
| Degraded | Working, with evidence of a problem |
| Failed | Evidence that it is not working |
| Stale | It was checked, but too long ago to describe now (three missed intervals) |
| Unknown | No evidence either way |

**Healthy needs positive evidence. No errors is not evidence.** A check that never ran is *Unknown*, a check that went quiet is
*Stale*, and orders that cannot be read are *Unknown*, never zero and never healthy. Traffic is one kind of evidence and a passing
active check is another, so a quiet system with every dependency configured reads twelve of twelve.

**Overall:** a failed critical component is *Failed*; anything failed or degraded is *Degraded*; no evidence on a critical
component is *Unknown* or *Stale*. Only then is it *Healthy*, and blind spots on optional components are listed beside it, so
a quiet payment provider at night does not raise an alarm and is not called healthy either.

**A dead monitor cannot look healthy.** Freshness is judged when a snapshot is read, because a stopped collector cannot report
its own death. Past three intervals everything reads *Stale*, whatever it said when it was fresh. With `RELIABILITY_ENABLED=off`
everything reads *Unknown*.

## Where the data comes from

| Component | Evidence | Source |
|---|---|---|
| MongoDB | Active ping, every tick | `HEALTH_CHECKERS` in `services/admin/monitoring.js` |
| Redis | A short-lived key written and read back, every tick, because sessions and locks need writes and a read-only replica answers `PING` | Same |
| Telegram Bot API | `getMe` and `getWebhookInfo`, on the probe interval | Same |
| Polling loop | The poller's own last-success stamp; no extra Telegram call | `getPollingEvidence` |
| Express app | Loopback `GET /livez`, 5xx share, event-loop delay | `services/reliability/collector.js`, `perf_hooks` |
| WizardXray | `status` (the bot reaches its service panel), `me` (the key works, the prices are readable), then a location list, a sample `price` agreeing with `me`, and whether the wallet can fund the cheapest plan. All reads. Plus real create calls | `HEALTH_CHECKERS`, `api/wizardApi.js` |
| HooshPay | `GET /balance` with the API key, or real traffic. 401 is the key, 403 a blocked account, 503 a disabled gateway or no active card, and only a JSON `success: true` counts as healthy | `probeHooshPay`, `observeWebhook` |
| NOWPayments | `GET /status`, then `GET /merchant/coins` with the API key, or real traffic | `probeNowPayments`, `observeWebhook` |
| Webhook path | Secrets present, callback outcomes by HTTP status, and a [signed test callback](#signed-test-callback) every 10 minutes | `checkWebhookPath`, `observeWebhook` on the route |
| Order workflow | Stored records | `WalletPurchase`, through Sentinel's read-only wrappers |
| Telegram delivery | The outbox, each delivery's result, and a send to the admin group every 10 minutes | `WalletPurchase.notificationPending`, `notifyPurchaseOnce`, `checkDeliveryPath` |
| Background jobs | Each job's report against its schedule | `recordJobRun`, `observeJob`, `JOBS` in `constants.js` |

The order lifecycle reuses Sentinel's feed for stored stages. Payments and orders meet only at the wallet, so the trace states
that a payment is **not linked** to an order rather than guessing, and links to Sentinel for the money view.

Every trace stage carries a basis: *Recorded* (a stored field says so), *Inferred*, or *No telemetry* (this record cannot tell).
Delay limits are the ones System Health already uses: 10 minutes in a working state, 2 minutes for delivery and refunds.

### Signed test callback

A quiet payment path used to read *Unknown*, because nothing proves a webhook without a callback. So every 10 minutes
`checkWebhookPath` posts one correctly signed callback per configured provider to this server's own routes, naming a random invoice
that cannot exist with a status that credits nothing. The only passing answer is 404 `invoice_not_found`, which can only come after
the route, the JSON parser, the signature check against the configured secret and a MongoDB lookup have all worked. A wrong
secret answers 401, and a database outage answers 503.

It cannot touch money: the id is random, no record can match it, and neither handler writes for an unknown invoice, which
`tests/integration/reliabilityChecks.mongo.test.js` proves against a real database. Each call does log one "unknown invoice" warning.
The calls carry a per-process random header so they stay out of the callback counts. A guessed header changes nothing.

`sendChatAction` is the delivery equivalent: the one send-class call that leaves no message. Admins see "typing" in the admin group
for a few seconds every 10 minutes.

## Telemetry that does not exist

These limits are deliberate statements, not gaps to paper over:

- **A quiet check is not a full transaction.** The reachability checks prove the provider answers and accepts the key. They do not create
  an invoice, because that would be a real invoice. HooshPay's `GET /balance` is documented by path alone, so only `success` is relied on
  ([what is confirmed](wizardxray.md#what-the-live-provider-has-confirmed)).
- **Nothing measures Telegram's delivery to the phone**, only that Telegram accepted the message. The test send proves the admin group
  can be reached, not that one customer's chat can.
- **Job starts are not observed**, only completions and failures, because jobs report when they finish. A job's history is in
  process memory, so after a restart every job is *Unknown* until it reports.
- **`job.started` and per-handler bot latency do not exist.** Telegram updates are counted when they arrive; how long handlers
  take is not measured.
- **Telemetry starts at deployment.** Windows report how much of themselves was really observed, and a chart gap means no data.
- **Redis down means no signing in.** Admin sessions live in Redis and fail closed, so during a Redis outage this page cannot be
  opened. A page already open keeps its last data, and reads *Disconnected*.
- **Payment events have no order link**, and a webhook event's correlation id is its `request_id`, the same id as in the logs.

## Metrics and windows

Windows are 15 minutes, 1 hour, 6 hours and 24 hours. Every figure on a card states its window, unit and source.

- **Percentiles** are withheld below 5 samples (P50), 20 (P95) and 100 (P99): with 8 samples, "P99" is only the maximum.
  Request latency comes from fixed histogram buckets, so a value reads `≤250 ms`, an upper bound. A rank past the last bucket
  reads `>60 s`, never an invented number. Durations from stored order timestamps are exact.
- **Rates** need 5 attempts; below that the count is shown instead.
- **Errors** are 5xx answers and failed or timed-out provider calls. A rejected callback (bad signature, mismatched details) is
  counted separately: it is the check working. A proven refusal from a provider is *rejected*, not *failed*.
- **Fulfilment success** counts orders created in the window that reserved funds. A request refused for balance never started,
  and running orders are shown beside the rate, not inside it.
- **Coverage:** a minute with a stored rollup was measured, even if nothing happened; a minute with none is a gap, never zero.
- The dashboard's own requests and `/health`, `/livez`, `/ready` are excluded from traffic, so watching does not change the numbers.

## Incidents

`services/reliability/rules.js` evaluates pure conditions on every tick. `incidents.js` holds their lifecycle.

| Code | Severity | Raised when |
|---|---|---|
| `DEPENDENCY_DOWN` | Critical / High | A dependency, including HooshPay, NOWPayments and the webhook path, failed two checks in a row (Telegram: one) |
| `DEPENDENCY_DEGRADED` | Medium | A dependency is slow or partly working |
| `POLLING_CONFLICT` | Critical | 409: another process polls with this token |
| `POLLING_FAILING`, `POLLING_STALLED` | High | No successful poll since an error, or for 90 seconds |
| `WEBHOOK_SECRET_MISSING` | High | A configured provider has no webhook secret |
| `WEBHOOK_FAILURES` | High | Three or more 5xx answers in 15 minutes |
| `WEBHOOK_REJECTED_BURST` | Medium | Ten or more rejected callbacks in 15 minutes |
| `PROVIDER_TIMEOUTS`, `PROVIDER_ERRORS` | High | Three timeouts, or three failures at 50% or more, in 15 minutes. A rejected API key or a documented server-side failure counts as a failure, not as a refusal |
| `ORDERS_NEED_REVIEW`, `ORDERS_STUCK_PROVISIONING`, `ORDERS_INTERRUPTED`, `REFUNDS_PENDING` | High | Order counts from the records |
| `ORDERS_AWAITING_PROVIDER`, `DELIVERY_PENDING` | Medium | Same |
| `ADMIN_ALERTS_PENDING` | Low | Same |
| `JOB_FAILING`, `JOB_OVERDUE` | High / Medium | Failed runs, or no report for three intervals |
| `SENTINEL_BEHIND` | Medium / Low | Reconciliation is delayed or stale |
| `TELEMETRY_NOT_PERSISTED` | Medium | Three failed writes in a row |
| `HTTP_ERRORS` | High / Medium | 5% or 25% of 20 or more requests answered 5xx |

- **Deduplication:** `fingerprint` is `code:subject`, and a partial unique index allows one open row per fingerprint. A problem
  that continues is one row with a detection count, and a second process adopts the winner's id.
- **Recovery** needs three clean evaluations, so a flapping dependency stays one incident. A problem back within 15 minutes
  reopens its incident.
- **Missing telemetry never resolves anything.** A rule that cannot read its input reports its group as unevaluated, and that
  group's open incidents stay as they are. So a provider or webhook incident stays open until real traffic or a passing check shows
  recovery, and a job's incident survives a restart, when the job is *Unknown* rather than fixed. A burst of rejected
  callbacks is the exception: it is an event, not a broken state, so it clears with time.
- **Escalation:** a rising severity updates the same row. A falling one does not lower it.
- **MongoDB's own outage:** ids are made in memory, so the incident is written when the database returns, with its true first
  detected time.

Next steps are advice: each reads something or links to an existing audited tool. No incident has a button that acts.

Incidents do not message the admin group. They are visible in the panel only.

## Real-time delivery and freshness

`GET /api/admin/reliability/stream` is Server-Sent Events: one-way, one process, no dependency. A snapshot goes out after each
tick and events are batched to one write a second, all from memory, so a viewer adds no database load.

- **Access:** the normal `/api/admin` stack. The session is re-checked every minute while a stream is open, failing closed, and a
  lapsed session closes it.
- **Limits:** 4 streams per admin, 24 overall; a stream ends after 10 minutes and reconnects; a slow socket is dropped past 1 MB
  buffered; a ping every 15 seconds.
- **Reconnect:** the browser reconnects with growing delays up to 60 seconds, sending its last event id as `?cursor=` (a new
  `EventSource` sends no `Last-Event-ID`), and gets only what it missed, up to the last 100 events of this process. Events merge by
  id, so a repeat cannot show twice. After two failures it also polls `/reliability/snapshot`. A routine rotation is not a failure.
- **A dead monitor on a live connection:** pings can continue after the monitor stops, so the page judges the snapshot's age itself
  and turns everything *Stale*. The same applies when the connection is lost: no state stays green on old data, and dots stop.
- **Hidden tabs** hold no connection.
- **Shutdown:** `http.Server.close()` waits for open responses, so streams are closed before it, or a deploy would hang.

The label at the top is the honest part. *Live* needs a connection that spoke recently **and** a monitor that ran recently.

| Label | Means |
|---|---|
| Connecting | Opening the stream |
| Live | Connected, and the monitor ran recently |
| Polling | The stream is unavailable; the page is asking for updates |
| Reconnecting | The connection dropped; the last data stays on screen |
| Stale | Connected, but the monitor has not reported |
| Disconnected | No answer from the server |
| Paused while hidden | Updates resume when the tab is visible |
| Signed out | The session ended |

## Topology and motion

SVG links, real `<button>` nodes and compositor-run dots on one CSS 3D plane: the same technique as Sentinel's money paths, with
the particle and tilt code shared in `components/shared/scene-motion.tsx`. There is no canvas loop and no 3D library, which would
add weight for no information. Reduced motion removes the dots, tilt and flashes.

A dot means traffic this process measured in the last 15 minutes, on that link. A quiet link has none. A dashed-dot link is a
dependency nothing can count, so it never moves, whatever it carries. Selecting a node lights what touches it, in both directions;
selecting an incident lights its blast radius from the `dependsOn` map.

The list view is the same information with no picture. It is the layout below 768 px, and a remembered choice above that.

Theme: every colour is a token from `design/theme.css`, and states are always written out too. New CSS is the `rf-*` block in
`admin-panel/app/globals.css`; recharts loads only on the History tab.

## The no-interference guarantee

- **The recorder cannot affect what it observes.** `services/reliability/telemetry.js` imports nothing from the application;
  every observer is synchronous, does no I/O and catches its own errors. Series come from a fixed list, so no request can name one.
- **The webhook handlers are unchanged.** `observeWebhook` sits on the route and judges by the status code the handler answered. The
  signed test callback goes through them exactly as a provider's does.
- **Only `store.js` writes**, and it knows `ReliabilityEvent`, `ReliabilityIncident` and `ReliabilityRollup`. The job also keeps its
  own `JobCheckpoint` row, `service-reliability`.
- **Money collections are read through Sentinel's `readOnly.js`.** No module here imports code that moves money or provisions.
- **There is no mutating route**, so nothing here can cancel an order, restart a job or touch a balance.
- **Sensitive data:** fields are selected by name, so service links and hashes never leave the database; customer ids are masked;
  all event text passes `sanitize.js`, which removes tokens, URLs, addresses, card numbers and Telegram ids.

Nothing in the payment, wallet or order code reads these collections. Deleting them changes no balance.

`tests/unit/reliabilityReadOnly.test.js` enforces this statically. `tests/integration/reliability.mongo.test.js` proves every money
collection byte-identical after ticks and every read view.

## Storage, indexes and cost

| Collection | Holds | Kept |
|---|---|---|
| `ReliabilityEvent` | Operational events, keyed by `eventId` | 7 days (TTL) |
| `ReliabilityRollup` | One closed minute per process, so the 24-hour view survives a restart | 2 days (TTL) |
| `ReliabilityIncident` | Incidents | Open: kept. Resolved: 90 days (TTL) |

All indexes are additive and created at startup by `createIndexes()`. `WalletPurchase.idx_reliability_delivery_pending` is partial
on `notificationPending: true`, so it stays tiny, and it stops the delivery count walking every completed order once a minute. It
is non-unique and changes no money guarantee, so no migration is needed.

Cost of one process: one tick every 30 seconds runs a ping, a Redis write and read, and a loopback request; once a minute it also calls Telegram
`getMe` and `getWebhookInfo`, WizardXray `status` and `me`, HooshPay `/balance`, NOWPayments `/status` and `/merchant/coins`, and reads the
order records (the indexed counts, up to 100 backlog rows, up to 3,000 orders from the last day). WizardXray `get_hosts` and `price`
run once in 5 minutes, and the signed test callbacks and the admin-group send once in 10. A tick holds a `JobCheckpoint` lease only to
write. Memory is bounded: 24 hours of sparse minutes and 1,000 events. Reads of the snapshot and history do no I/O.

## Troubleshooting

| You see | It means | Do |
|---|---|---|
| Everything *Stale* | The monitor stopped ticking | Check logs for `"service":"service-reliability"`; a failed tick logs `Reliability tick failed` |
| Everything *Unknown* | Just started, or `RELIABILITY_ENABLED=off` | Wait one tick, or check the variable |
| *Polling* permanently | A proxy is breaking SSE | Check `/api/admin/reliability/stream` is not buffered. The page keeps working, more slowly |
| `stream_capacity` | Four tabs open for one admin | Close one |
| Provider *Unknown* | It is not configured here, or no check has finished yet | Set its API key, or wait one minute |
| Provider *Degraded* or *Failed* naming the API key | The provider answered and refused the key | Replace the key |
| HooshPay *Failed*: blocked, or gateway disabled or no card | 403 or 503 from HooshPay. The key is fine | Check the account in the HooshPay dashboard |
| Webhook path *Failed*: `answered 401` | The stored secret is not the one the route verifies with | Check `HOOSHPAY_WEBHOOK_SECRET` or `NOWPAYMENTS_IPN_SECRET` |
| WizardXray *Degraded*: `cannot fund` | The provider wallet is below the cheapest plan's cost | Top it up. New orders wait as `awaiting_provider` until then |
| Job *Unknown* after a deploy | No run reported yet by this process | Wait one interval |
| *Telemetry is not being saved* | MongoDB writes fail | Live values continue; only history is at risk until a restart |
| Persistence reads *standby* | Another process holds the lease | Normal for a moment during a deploy |

Logs use `"service":"service-reliability"`. `RELIABILITY_ENABLED=off` stops the monitor; the rest of the application is unaffected.
Configuration: [RELIABILITY variables](configuration.md#telegram-and-admin).

## Testing

| Suite | Covers |
|---|---|
| `tests/unit/reliabilityTelemetry.test.js` | Bounds, burst coalescing, classification, sanitizing |
| `tests/unit/reliabilityHealth.test.js` | Every state, positive evidence, freshness, a dead monitor |
| `tests/unit/reliabilityIncidents.test.js` | Rules, deduplication, escalation, recovery, reopen, unevaluated groups |
| `tests/unit/reliabilityMetrics.test.js` | Windows, sample floors, coverage, gaps, cohorts, the order trace |
| `tests/unit/reliabilityCollector.test.js` | Failed probes, MongoDB and Redis outages, persistence failures, restarts, timers |
| `tests/unit/reliabilityReadOnly.test.js` | The static no-interference guarantees |
| `tests/unit/reliabilityPanel.test.js` | What may be called Live, merging, filters, topology, formats |
| `tests/integration/reliabilityHttp.test.js` | Auth, CSRF surface, validation, sanitizing and the event stream, over real HTTP |
| `tests/integration/reliability.mongo.test.js` | Real orders, byte-identical money, two processes, restarts, index plans |
| `tests/integration/reliabilityChecks.mongo.test.js` | All twelve checks with the real checkers, app and database and stand-in providers, passing on a quiet system and each one failing with its dependency |
| `tests/e2e/reliability.e2e.mjs` | Themes, widths, interactions, live updates, reconnection, outages, axe, main-thread cost |

Recipes are in [Testing](testing.md).
