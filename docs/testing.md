# Testing

```bash
npm test                 # unit + integration suites (node --test)
npm run build:storefront # needed once for the storefront build tests to run instead of skip
npm run test:e2e         # admin dashboard browser suite (needs Chrome)
npm run test:e2e:store   # public storefront browser suite (needs Chrome and the storefront build)
```

## Parallelism

`scripts/run-tests.mjs` runs every test file as a `node --test` worker and defaults
`--test-concurrency` to `max(8, availableParallelism() * 4)`: almost all wall time in this suite is
spent waiting on I/O (MongoDB/Redis round trips, loopback HTTP, mongoose connect retries when no
database is configured), not CPU, so running well beyond the CPU count overlaps that waiting instead
of leaving it serialized. Each test file already gets its own throwaway database (`tests/helpers/db.js`)
and binds servers to port `0`, so concurrent files cannot collide.

Override with `TEST_CONCURRENCY=<n> npm test`, or pass `--test-concurrency=<n>` directly (`npm test --
--test-concurrency=1` for a serial run while debugging); either one takes precedence over the computed
default.

## MongoDB-backed suites

Many integration suites exercise real money paths against a real MongoDB. Point
`TEST_MONGO_URL` at a throwaway database whose name contains `test`
(default `mongodb://127.0.0.1:27017/swiftvpn_test`); each test file gets its own database and the
helper refuses any other name.

> When MongoDB is unreachable these suites are **skipped, not failed**. A green run with skips
> means the money-path assertions in those suites did **not** execute. Read the skip count in the
> `npm test` summary; every skip reason names MongoDB.

Suites that need MongoDB: `adminBankConfirm`, `adminRegistryMutations`, `adminServices`,
`adminTelegramPanel` (data screens), `adminWeb` (data tests), `catalogShop`,
`hooshpayFulfillment`, `hooshpayIndexMigration`, `purchaseFlow`, `orderStatusMessage.mongo`, `trxScanner` and
`webhookHttp` under `tests/integration/`.

## What is covered

| Area | Where | Notes |
|---|---|---|
| HooshPay | `tests/hooshpay.test.js`, `tests/unit/hooshpay*.test.js`, `tests/integration/hooshpayFulfillment.test.js`, `webhookHttp.test.js` | Payload contract, state machine, signature verification, two-phase credit, duplicate and concurrent webhooks, crash recovery, over real HTTP |
| NOWPayments / TRON / pricing | `tests/unit/nowpayments*.test.js`, `tronTopupFlow`, `cryptoTopupFlow`, `gheymatQuote` | Hosted invoice, IPN signature, custody, quote freshness, amount validation |
| TRX scanner | `tests/integration/trxScanner.test.js` | Claims, hash reuse, reverted transactions, recovery |
| Purchases and wallet | `tests/unit/purchaseService`, `customerPlans`, `plansCatalog`, `tests/integration/purchaseFlow.test.js`, `orderStatusMessage.mongo.test.js` | Reserve, commit, refund, ambiguous results (provider stubbed); the one order status message through the real callback handler: edit failures, retries, concurrency, recovery of the customer notice |
| Admin services and panels | `tests/unit/admin*.test.js`, `tests/integration/admin*.test.js` | Audit idempotency, auth sessions, validation, registry, Telegram panel authorization, CSRF and session enforcement over HTTP |
| Admin user actions | `adminUserMessaging`, `accessGate`, `adminSettings`, `adminTestEligibility`, `nextPanelHeaders` | Message delivery mapping, block enforcement, settings output never contains secret values, eligibility reset, anti-framing headers |
| Mock tests | `tests/unit/mockTests.test.js`, `mockTestsUi.test.js`, `tests/integration/adminTelegramMock.test.js` | Harness isolation and all scenarios against the real services; UI data contract |
| Storefront | `tests/integration/storefrontAndPanel.test.js`, `storefrontBuild.test.js`, `tests/unit/storefrontLogic`, `storefrontApi`, `topupGuide`, `themeTokens` | Routing, CSP, canonical URL, caching and compression, hand-off URL safety, API client; the top-up guide against the bot's source; the shared palette (contrast, static-page copies, button scale) |
| Configuration and startup | `envResolution`, `mongoStartup`, `moduleSmoke` | Environment aliases and validation, startup ordering, every production module imports cleanly |
| Telegram UI | `messageManager`, `myServicesFlow`, `handleGuide`, `persianUiGuard`, `profile*`, `showPaymentMethods`, `supportContact` | Message handling, Persian UI guard, privacy of profile data |
| Engineering context | `tests/unit/checkContext.test.js` | References in `CLAUDE.md` and `.claude/` resolve; impact map and skills are valid; change classification and the Stop-hook decision (`scripts/check-context.mjs`) |

## Browser suites

- `npm run test:e2e` starts the real app on a random port with an in-memory session store and
  answers `/api/admin/*` from fixtures inside the browser, so it needs no database and never
  touches live services. It checks responsive layout, light/dark, right-to-left, drawer
  navigation, dialogs, touch targets, contrast and localization of the admin dashboard and the
  storefront. **Known broken (seen on `a8cd18b`, 2026-10-31):** it opens `/admin` and waits for the legacy `#app.ready`, but
  `/admin` now leads to the Next panel, so it stalls there and starts a Next dev server in the test process. Until it is
  ported, `nextPanel.e2e.mjs` is the working admin suite.
- `node tests/e2e/nextPanel.e2e.mjs` (after `npx next build admin-panel`) drives the real `/panel` with the real session,
  CSRF and origin middleware. It covers money actions under delayed and failing API answers (nothing looks successful
  early, a retry keeps its `operationId`, a double click sends one request), filter navigation, charts and reduced motion.
- `npm run test:e2e:store` runs the public storefront under the real CSP: hydration, themes,
  duration tabs, the order review and every failure path, SEO tags, and the no-JavaScript view.
  It exits `0` with a `SKIP` message if the storefront build or Chrome is missing.
- Both need Chrome or Chromium (`CHROME_PATH` if it is not auto-detected). The storefront suite
  also runs accessibility checks with axe-core when it can resolve it (install `axe-core`
  locally or set `AXE_PATH`); without it those checks are skipped and reported as such.
- They are not part of `npm test`.

## Housekeeping

`next build` output (`admin-panel/.next`, `storefront/.next`) is git-ignored and skipped by the module
smoke test, so it can stay in place while running `npm test`; `npm run build:storefront` deletes the
storefront cache itself.
