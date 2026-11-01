# Configuration reference

All configuration is read from environment variables. The annotated template is
[`.env.example`](../.env.example); this page is the full reference. Every variable listed
here is read by the code (`config/env.js` and the modules named in the notes).

- **Local development:** copy `.env.example` to `.env` (git-ignored) and fill it in.
- **Railway / other hosts:** set the variables on the service instead of shipping a file.
- **Validate before starting:** `npm run preflight` checks that required variables are
  present and well-formed and probes MongoDB, Redis and the configured services. It prints
  variable *names* and error classes only, never values.

## Safe handling of secrets

- Never commit `.env` or any real value. `.gitignore` excludes `.env` and `.env.*`
  (except `.env.example`).
- Use the placeholders in `.env.example`; keep real tokens, keys and webhook secrets only in
  your host's secret store.
- Generate webhook secrets with a CSPRNG, for example:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- Rotate any secret that was ever pasted into a chat, log, ticket or commit. Deleting it
  from the current files does not revoke it.
- Never log or print connection strings, tokens or payment identifiers. The startup and
  preflight code reports only the failing stage or variable name.

## Deployment mode

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | unset (treated as non-production) | Set to `production` on every production host (Railway does **not** set this for you). It gates several production-only checks: rejecting a loopback MongoDB/Redis host, requiring HTTPS for `WIZARD_API_URL`/`HOOSHPAY_API_BASE_URL`, disabling Mongoose's per-boot `autoIndex`, switching the admin dashboard's internal Next.js middleware out of dev-server mode, and making the admin APIs trust configured browser origins only (otherwise the request's own origin also counts, and Settings shows *Development mode*). Leaving it unset does not stop the bot from starting; it silently skips those checks |

## Required

The bot refuses to start (fail-fast, with the variable name) if any of these is missing or
malformed.

| Variable | Purpose | Validation / notes |
|---|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather | `<numeric id>:<secret>` format |
| `ADMINS` | Comma-separated numeric Telegram user IDs with admin rights | Positive integers. **Fail-closed:** if empty or invalid, nobody is an admin |
| `GROUP_ID` | Admin group chat ID | Negative integer, e.g. `-100…`. Admin actions in the group are only accepted from this chat |
| `MONGO_URL` | MongoDB connection string | See [aliases](#alternate-names) below. A URI without a database name gets `/swiftvpn` (or `MONGO_DB_NAME`). Production must not use a loopback host |
| `REDIS_URL` **or** `REDIS_HOST` (+ `REDIS_PORT`) | Redis for sessions, locks and cron leases | Production must not use a loopback host. Redis is never authoritative for money |
| `WIZARD_API_URL` | WizardXray API v1 base URL, no trailing slash (the method name is appended) | Public HTTPS |
| `VPN_API_KEY` | WizardXray bearer token | |
| `HOOSHPAY_API_KEY` | HooshPay API key | |
| `HOOSHPAY_WEBHOOK_SECRET` | HMAC-SHA256 secret for HooshPay webhook signatures | ≥ 32 characters. If unset, every webhook is rejected |
| `NOWPAYMENTS_API_KEY` | NOWPayments API key (sent only as `x-api-key`) | Not the public key |
| `NOWPAYMENTS_IPN_SECRET` | NOWPayments HMAC-SHA512 IPN secret | ≥ 32 characters. If unset, every IPN is rejected |
| `WEBHOOK_BASE_URL` | Public HTTPS origin of this server | **No trailing slash**, no path. Also used for the storefront canonical URL and trusted as the panel's browser origin |
| `TRX_WALLET` | TRON address that receives direct TRX deposits | Valid 34-character Base58 address |

## Optional

### Telegram and admin

| Variable | Default | Purpose |
|---|---|---|
| `OWNER_TELEGRAM_ID` | first `ADMINS` entry | Owner of the multi-admin registry. Only the owner can add or remove other admins; owners cannot be removed from the panel |
| `ADMIN_CACHE_TTL_SECONDS` | `60` | How long the admin allowlist (environment + database admins) is cached |
| `USER_SPEND_SORT` | `aggregate` | `persisted` ranks the admin "Top spending" list from `User.totalSpent`, but only after `scripts/user-spend-backfill.mjs --verify` ran clean; see [Persisted user spend](user-spend.md) |
| `USER_SPEND_HOOK` / `USER_SPEND_SWEEPER` | on | `off` disables the post-completion counter recompute / the background sweeper that repairs the counters; see [Persisted user spend](user-spend.md) |
| `SENTINEL_ENABLED` | on | `off` stops the [Money Flow Sentinel](sentinel.md) reconciliation job; the panel then shows it as off |
| `SENTINEL_INTERVAL_SECONDS` | `120` (30–3600) | How often reconciliation runs |
| `SENTINEL_USERS_PER_TICK` | `100` (10–2000) | Wallets reconciled per run by the rolling pass |
| `SENTINEL_GRACE_MINUTES` | `15` (1–1440) | How long a writer may sit between its two steps before it counts as a finding |
| `SENTINEL_STUCK_MINUTES` | `30` (5–10080) | When an intermediate payment or order state counts as stuck |
| `SENTINEL_AWAITING_PROVIDER_HOURS` | `24` (1–720) | When waiting on the provider is reported |
| `SENTINEL_LEDGER_EPOCH` | `2026-10-05T00:00:00.000Z` | Records older than this may predate the wallet ledger, so they can never produce a confirmed balance finding. An out-of-range `SENTINEL_*` value falls back to its default |
| `RELIABILITY_ENABLED` | on | `off` stops the [Service Reliability Center](reliability.md) monitor; the panel then reads Unknown, never healthy |
| `RELIABILITY_INTERVAL_SECONDS` | `30` (10–300) | How often the monitor pings MongoDB and Redis and re-evaluates incidents |
| `RELIABILITY_PROBE_SECONDS` | `60` (30–600) | How often it calls Telegram and WizardXray and reads the order records. An out-of-range `RELIABILITY_*` value falls back to its default |
| `ADMIN_PENDING_DELETE_MIN_HOURS` | `72` (minimum `24`) | Minimum age before the admin panel may delete a still-pending or expired top-up record; see [Deleting payment records](admin.md#deleting-payment-records-admin-panel) |
| `SUPPORT_CONTACT` | empty | Support contact shown to users (`@username` or numeric ID). If empty, the direct-support buttons are hidden |
| `SUPPORT_TERMS_URL` | empty | https URL of the terms page, shown as a button before a support ticket is created. Ignored unless https |
| `SUPPORT_GROUP_ALERTS` | off | `1` posts one content-free "new ticket" alert (id + panel link) in `GROUP_ID`; support conversations are never copied to the group; see [support](support.md) |
| `BOT_USERNAME` | from Telegram `getMe()` | Bot username (no `@`) for storefront checkout deep links |
| `MOCK_TESTS_ENABLED` | `false` | Must be exactly `true` to let admins run the isolated [mock-test harness](admin.md#mock-tests) |

### Database and Redis

| Variable | Default | Purpose |
|---|---|---|
| `MONGO_DB_NAME` | `swiftvpn` | Database name used when the URI has none |
| `REDIS_USERNAME` | `default` | Redis 6+ ACL username |
| `REDIS_PASSWORD` | empty | Redis password |
| `REDIS_TLS` | unset | `true` / `false`. Any other value is rejected at startup |

### Payments and pricing

| Variable | Default | Purpose |
|---|---|---|
| `HOOSHPAY_API_BASE_URL` | `https://hooshpay.xyz/api/v1` | Override the HooshPay API base URL (public HTTPS) |
| `NOWPAYMENTS_API_BASE_URL` | `https://api.nowpayments.io/v1` | Override the NOWPayments API base URL (public HTTPS) |
| `NOWPAYMENTS_IPN_CALLBACK_URL` | `<WEBHOOK_BASE_URL>/api/nowpayments/ipn` | Public HTTPS IPN URL. If you set it, register the identical URL in the NOWPayments dashboard |
| `NOWPAYMENTS_PRICE_CURRENCY` | `usd` | Fiat currency sent to NOWPayments. Keep `usd` (the live quote is USDT→IRT) |
| `NOWPAYMENTS_PAY_CURRENCY` | TRON | Pay currency for hosted invoices |
| `NOWPAYMENTS_FIXED_RATE` | `false` | Pass the fixed-rate flag to NOWPayments invoices |
| `NOWPAYMENTS_FEE_PAID_BY_USER` | `false` | Pass the fee-paid-by-user flag to NOWPayments invoices |
| `NOWPAYMENTS_CATALOG_TTL_SECONDS` | `300` | Cache time for the NOWPayments currency catalog (30–3600) |
| `NOWPAYMENTS_MIN_AMOUNT_CURRENCY_TO` | pay currency | Outcome currency used as `currency_to` in `GET /v1/min-amount`. Leave unset when each coin is paid out as itself; set it (e.g. `usdttrc20`) when the account auto-converts to another coin |
| `NOWPAYMENTS_MIN_AMOUNT_MARGIN_PERCENT` | `0` | Percent added to the provider's minimum before an amount is accepted (0–100). Off by default; see [Payments](payments.md#which-currencies-are-offered-and-the-minimum-amount) |
| `NOWPAYMENTS_ENABLED_CURRENCIES` | all allowlisted | Comma-separated provider codes (e.g. `usdttrc20,trx`) that **narrow** the built-in allowlist in [`services/nowpayments/allowlist.js`](../services/nowpayments/allowlist.js). It can switch a network off without a deploy; it can never add a currency |
| `NOWPAYMENTS_EMAIL` / `NOWPAYMENTS_PASSWORD` | unset | Custody / Mass Payouts credentials (JWT login). Set **both or neither**; needed only for the admin Custody features |
| `NOWPAYMENTS_PUBLIC_KEY` | unset | Not used by the payment flow. If it equals `NOWPAYMENTS_API_KEY`, the configuration is rejected |
| `GHEYMAT_API_BASE_URL` | `https://backend.gheymat.online` | Override the live USDT/IRT quote API (public HTTPS) |
| `GHEYMAT_API_TOKEN` | unset | Optional paid-plan token for the quote API, sent only as `x-api-token`. The free tier needs none |
| `GHEYMAT_CACHE_TTL_SECONDS` | `600` | Quote cache time (30–3600) |
| `GHEYMAT_MAX_QUOTE_AGE_SECONDS` | `900` | A quote older than this is refused instead of used (60–3600) |
| `CMC_API_KEY` | unset | CoinMarketCap key for the **legacy** direct-TRX quote. Without it a fixed fallback price is used. Not used by the NOWPayments flow |
| `TOPUP_MIN_TOMAN` / `TOPUP_MAX_TOMAN` | `10000` / `50000000` | Wallet top-up limits (Toman, integers). Invalid or inverted values fall back to the defaults |
| `CARD_NUMBER` | unset | **Legacy.** 16-digit card for the manual card-to-card flow, which is no longer offered in the top-up menu. Validated only if set |

### Server and tuning

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Express port. Railway injects it — do not hard-code it there |
| `WEBHOOK_RATE_LIMIT_PER_MIN` | `600` | Per-IP webhook limit per 60 s window (`0` disables it; max 100000) |
| `ADMIN_SESSION_TTL_SECONDS` | `28800` | Web admin session lifetime (900–86400) |
| `ADMIN_ALLOWED_ORIGINS` | empty | Comma-separated exact origins, beyond `WEBHOOK_BASE_URL` and Railway's `RAILWAY_PUBLIC_DOMAIN`, that browsers may use for the admin and support APIs. Set it if you open the panel on a second domain, or sign-in is refused with `origin_not_allowed`. Wildcards, paths and (in production) plain HTTP except loopback are ignored; the settings page counts ignored entries. See [browser protections](admin.md#browser-protections) |
| `WIZARD_STATUS_TTL_SECONDS` | `90` | Cache time for live WizardXray status in "My services" and admin views (`0` = always fresh) |
| `COST_PER_DAY` / `COST_PER_GB` | `200` / `300` | Cost constants (Toman) used by the admin profit reports |

### Tests only

| Variable | Default | Purpose |
|---|---|---|
| `TEST_MONGO_URL` | `mongodb://127.0.0.1:27017/swiftvpn_test` | MongoDB for the DB-backed suites. The database name **must** contain `test` (each test file gets its own database). Never point it at production |
| `TEST_CONCURRENCY` | `max(8, availableParallelism() * 4)` | `--test-concurrency` for `npm test` (`scripts/run-tests.mjs`); set to `1` for a serial run while debugging |

## Alternate names

The first name that is set wins.

| Setting | Accepted names |
|---|---|
| MongoDB URI | `MONGO_URL`, `MONGODB_URI`, `MONGO_URI`, a MongoDB-scheme `DATABASE_URL`, or the parts `MONGOHOST`/`MONGO_HOST` + `MONGOPORT`/`MONGO_PORT` + `MONGOUSER`/`MONGO_USER` + `MONGOPASSWORD`/`MONGO_PASSWORD` (user and password must be set together) |
| Redis | `REDIS_URL`, or `REDIS_HOST`/`REDISHOST` + `REDIS_PORT`/`REDISPORT` + `REDIS_USERNAME`/`REDISUSER` + `REDIS_PASSWORD`/`REDISPASSWORD` |

Railway's native variable names are accepted as-is. The retired names
`NOW_PAYMENTS_API_KEY` (extra underscore) and any TON flow are not used.

## Owner-run scripts (not app configuration)

`NOWPAYMENTS_SANDBOX_API_KEY` is read only by `scripts/sandbox-invoice-check.mjs`, a manual
owner-run check against the NOWPayments sandbox (never CI, never production). It is documented
in that script's header comment, not here or in `.env.example`, because it is never read by the
running bot.
