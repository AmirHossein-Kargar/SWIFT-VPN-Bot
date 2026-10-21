# Testing

```bash
npm test                 # unit + integration suites (node --test)
npm run build:storefront # needed once for the storefront build tests to run instead of skip
npm run test:e2e         # admin dashboard browser suite (needs Chrome)
npm run test:e2e:store   # public storefront browser suite (needs Chrome and the storefront build)
```

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
`hooshpayFulfillment`, `hooshpayIndexMigration`, `purchaseFlow`, `trxScanner` and
`webhookHttp` under `tests/integration/`.

## What is covered

| Area | Where | Notes |
|---|---|---|
| HooshPay | `tests/hooshpay.test.js`, `tests/unit/hooshpay*.test.js`, `tests/integration/hooshpayFulfillment.test.js`, `webhookHttp.test.js` | Payload contract, state machine, signature verification, two-phase credit, duplicate and concurrent webhooks, crash recovery, over real HTTP |
| NOWPayments / TRON / pricing | `tests/unit/nowpayments*.test.js`, `tronTopupFlow`, `cryptoTopupFlow`, `gheymatQuote` | Hosted invoice, IPN signature, custody, quote freshness, amount validation |
| TRX scanner | `tests/integration/trxScanner.test.js` | Claims, hash reuse, reverted transactions, recovery |
| Purchases and wallet | `tests/unit/purchaseService`, `customerPlans`, `plansCatalog`, `tests/integration/purchaseFlow.test.js` | Reserve, commit, refund, ambiguous results (provider stubbed) |
| Admin services and panels | `tests/unit/admin*.test.js`, `tests/integration/admin*.test.js` | Audit idempotency, auth sessions, validation, registry, Telegram panel authorization, CSRF and session enforcement over HTTP |
| Admin user actions | `adminUserMessaging`, `accessGate`, `adminSettings`, `adminTestEligibility`, `nextPanelHeaders` | Message delivery mapping, block enforcement, settings output never contains secret values, eligibility reset, anti-framing headers |
| Mock tests | `tests/unit/mockTests.test.js`, `mockTestsUi.test.js`, `tests/integration/adminTelegramMock.test.js` | Harness isolation and all scenarios against the real services; UI data contract |
| Storefront | `tests/integration/storefrontAndPanel.test.js`, `storefrontBuild.test.js`, `tests/unit/storefrontLogic`, `storefrontApi` | Routing, CSP, canonical URL, caching and compression, hand-off URL safety, API client |
| Configuration and startup | `envResolution`, `mongoStartup`, `moduleSmoke` | Environment aliases and validation, startup ordering, every production module imports cleanly |
| Telegram UI | `messageManager`, `myServicesFlow`, `handleGuide`, `persianUiGuard`, `profile*`, `showPaymentMethods`, `supportContact` | Message handling, Persian UI guard, privacy of profile data |

## Browser suites

- `npm run test:e2e` starts the real app on a random port with an in-memory session store and
  answers `/api/admin/*` from fixtures inside the browser, so it needs no database and never
  touches live services. It checks responsive layout, light/dark, right-to-left, drawer
  navigation, dialogs, touch targets, contrast and localization of the admin dashboard and the
  storefront.
- `npm run test:e2e:store` runs the public storefront under the real CSP: hydration, themes,
  duration tabs, the order review and every failure path, SEO tags, and the no-JavaScript view.
  It exits `0` with a `SKIP` message if the storefront build or Chrome is missing.
- Both need Chrome or Chromium (`CHROME_PATH` if it is not auto-detected). The storefront suite
  also runs accessibility checks with axe-core when it can resolve it (install `axe-core`
  locally or set `AXE_PATH`); without it those checks are skipped and reported as such.
- They are not part of `npm test`.

## Housekeeping

`next build` output (`admin-panel/.next`, `storefront/.next`) contains `.js` files that the module
smoke test would import. Remove those directories before running `npm test`;
`npm run build:storefront` already deletes the storefront cache.
