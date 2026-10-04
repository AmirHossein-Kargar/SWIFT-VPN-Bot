# SWIFT-VPN-Bot

A production Telegram bot for selling VPN (VLESS) services: wallet top-ups via
three payment methods, automatic service provisioning through the WizardXray
panel, and an admin panel that runs entirely inside a Telegram group.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Local development](#3-local-development)
4. [Environment variables](#4-environment-variables)
5. [Money-safety model](#5-money-safety-model)
6. [Railway deployment](#6-railway-deployment)
7. [HooshPay webhook](#7-hooshpay-webhook)
8. [Railway scaling — one replica](#8-railway-scaling--one-replica)
9. [Testing](#9-testing)
10. [Production checklist](#10-production-checklist)
11. [Operations & recovery](#11-operations--recovery)
12. [Admin Panel ecosystem (web + Telegram)](#12-admin-panel-ecosystem-web--telegram)

---

## 1. What it does

**User side**

- `/start` — main menu.
- **🛒 خرید سرویس** — pick a duration (30/60/90 days) then a plan; the plan price
  is deducted from the wallet and a VLESS subscription is created on the panel
  and delivered with a QR code.
- **💰 افزایش موجودی** — top up the wallet with one of three methods:
  - **HooshPay** — online gateway (card-to-card, automatic, webhook-confirmed)
  - **TRX** — Tron transfer, matched automatically by a background scanner
  - **کارت به کارت** — manual bank transfer with a receipt uploaded to the admin group
- **📦 سرویس‌های من** — list services, view details/usage, change link, get a QR
  code, activate/deactivate, delete.
- **🎁 سرویس تست** — one free trial service per user.
- **👤 پروفایل من / 📖 راهنما / 🛠 پشتیبانی** — profile, guide, support relay.

**Admin side** (in the Telegram admin group)

- `/panel` — admin panel: TRX wallet scan, system status, financial reports
  (comprehensive / detailed / monthly / crypto / bank / HooshPay / users),
  API service purchase, and messaging a user directly.
- Receipt approval for manual bank payments (approve / reject) directly from the
  receipt card posted to the group.
- HooshPay invoice lookup by UID or order id, and forced re-fulfillment.

---

## 2. Architecture

```
                       Telegram (long polling)
                                │
                    ┌───────────▼───────────┐
                    │        bot.js         │  message / callback routing
                    └───────────┬───────────┘
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  handlers/               paymentHandlers/         services/
  ─────────               ────────────────         ─────────
  onMessage               payHoosh  ──┐            buyService/    → WizardXray
  handleCallbackQuery     payTrx      │            manageServices/
  admin/groupManager      payBank     │            hooshpay/      → HooshPay API
  admin/reports           handleBankRecipt         trxWalletScanner → TronScan
                          handleTrxAmount
        └───────────┬───────────┴───────────┬───────────┘
                    ▼                       ▼
              MongoDB (mongoose)         Redis
         authoritative money state   sessions · locks · cron exclusion
                    ▲
                    │
        ┌───────────┴────────────┐
        │      server.js         │  Express
        │  POST /api/hooshpay/webhook
        │  GET  /health   GET /ready
        └────────────────────────┘
```

**Components**

| Component | Role |
|---|---|
| **Telegram bot** | `node-telegram-bot-api` in **polling** mode. Started by `startBot.js`. |
| **MongoDB** | Authoritative store for users, balances, invoices and services. All money mutations use atomic single-document writes. |
| **Redis** | Session store (TTL'd), in-flight payment locks, cron/scanner mutual exclusion. **Never** authoritative for money. |
| **HooshPay** | Primary online gateway. Invoice created via REST; confirmation arrives as a signed webhook. |
| **WizardXray** | VPN panel REST API: create / find / change-link / delete / deactivate service. |
| **TRX scanner** | Polls TronScan every 5 minutes, matches incoming TRX against unpaid invoices, credits the wallet. |
| **Express server** | Receives HooshPay webhooks, serves health probes and hosts the **web admin dashboard** (`/admin`, `web/public`) plus the admin JSON API (`/api/admin/*`). Runs inside the same process as the bot. |
| **Admin services** | `services/admin/*` — the single implementation of authorization, audit logging, user/VPN/payment/product management, recovery, broadcast, analytics and health checks shared by the Telegram panel and the web dashboard. |

**Process layout** — `npm start` boots one process that starts, in order:
MongoDB → Express → Telegram polling → TRX scanner → HooshPay cron → signal handlers.

---

## 3. Local development

**Requirements:** Node.js **20 or newer** (developed on Node 22), MongoDB, Redis.

```bash
git clone <repository-url>
cd SWIFT-VPN-Bot

npm install
cp .env.example .env      # then fill in every REQUIRED value
```

Validate the configuration before starting:

```bash
npm run preflight         # exits non-zero if anything critical is missing
```

Run the tests and start the bot:

```bash
npm test                  # unit + integration suites
npm start                 # starts everything (bot + webhook server)
```

| Command | What it does |
|---|---|
| `npm start` | Production entry point — `node bot.js` |
| `npm test` | Full test suite (`node --test`) |
| `npm run preflight` | Configuration / connectivity pre-deployment check |

> The DB-backed integration suites need a reachable MongoDB. Point
> `TEST_MONGO_URL` at a throwaway database whose name contains `test` (each test
> file automatically gets its own database). When MongoDB is unreachable those
> suites **skip** rather than fail — a green run with skips means the money-path
> assertions did **not** execute.

---

## 4. Environment variables

The full annotated template lives in [`.env.example`](.env.example). This is the
authoritative list — every variable below is read somewhere in the codebase.

### Required

| Variable | Purpose | Example / notes |
|---|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather | `123456789:AA...` |
| `ADMINS` | Comma-separated Telegram user IDs with admin rights | `11111111,22222222`. **Fail-closed**: if empty, nobody is an admin. |
| `GROUP_ID` | Admin group chat id (negative) | `-1001234567890`. Admin actions are only accepted from this chat. |
| `MONGO_URL` | MongoDB connection string | Also accepts `MONGODB_URI`, `MONGO_URI`, `DATABASE_URL`, or `MONGOHOST`+`MONGOPORT`+`MONGOUSER`+`MONGOPASSWORD`. `mongodb://user:pass@host:27017/swiftvpn?authSource=admin` |
| `REDIS_HOST` | Redis host | Also accepts `REDISHOST`, or a full `REDIS_URL`. `127.0.0.1` |
| `REDIS_PORT` | Redis port | Also accepts `REDISPORT`. `6379` |
| `WIZARD_API_URL` | VPN panel base URL, no trailing slash | `https://panel.example.com` |
| `VPN_API_KEY` | VPN panel bearer token | |
| `HOOSHPAY_API_KEY` | HooshPay API key | |
| `HOOSHPAY_WEBHOOK_SECRET` | HMAC-SHA256 secret for webhook signatures | **Mandatory.** If unset, every webhook is rejected. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `WEBHOOK_BASE_URL` | Public HTTPS base URL of this server, **no trailing slash** | `https://your-app.up.railway.app` |
| `CARD_NUMBER` | 16-digit card number shown for manual transfers | |
| `TRX_WALLET` | Tron address receiving TRX (starts with `T`, 34 chars) | |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_USERNAME` | `default` | Redis 6+ ACL username. Also accepts `REDISUSER`. |
| `REDIS_PASSWORD` | *(empty)* | Redis password. Also accepts `REDISPASSWORD`. |
| `MONGO_DB_NAME` | `swiftvpn` | Database name used when the Mongo URI does not specify one |
| `CMC_API_KEY` | fallback `0.08` | CoinMarketCap key for the TRX quote. **Strongly recommended** — without it invoices are mis-priced by the fallback rate. |
| `PORT` | `3000` | Express port. Railway injects this — do not hardcode it there. |
| `WEBHOOK_RATE_LIMIT_PER_MIN` | `600` | Per-IP webhook limit per 60 s window. `0` disables it. |
| `COST_PER_DAY` | `200` | Cost per service-day (Toman) for admin profit reports |
| `COST_PER_GB` | `300` | Cost per GB sold (Toman) for admin profit reports |
| `TEST_MONGO_URL` | `mongodb://127.0.0.1:27017/swiftvpn_test` | Test-only. Name must contain `test`. |
| `ADMIN_SESSION_TTL_SECONDS` | `28800` | Web admin session lifetime (900–86400 s). |

> **Removed:** `NOW_PAYMENTS_API_KEY` and the whole NowPayments/TON flow were
> deleted — they were unreachable at runtime (the session step that triggered
> them was never set anywhere).

---

## 5. Money-safety model

This section documents exactly what happens on every money path. It is the
behaviour the code and the test suite guarantee.

### 5.1 HooshPay (automatic)

```
create invoice (HooshPay API) → persist HooshPayInvoice (status: pending)
        │
        ▼
signed webhook  →  HMAC-SHA256 verify  →  amount verify  →  find invoice
        │
        ▼
Phase 1  findOneAndUpdate({_id, fulfilled:false}) → {fulfilled:true, status:"paid"}
        ▼
Phase 2  findOneAndUpdate({_id, fulfilled:true, balanceCredited:false})
         → {balanceCredited:true}   then  User.$inc{ balance }
        ▼
Telegram confirmation
```

- **Idempotent.** Both phases are single atomic MongoDB writes. A duplicate
  webhook, a double-click on “I have paid”, or a retry all lose the race and
  change nothing. Ten concurrent deliveries credit exactly once.
- **Crash-safe.** A crash between Phase 1 and Phase 2 leaves
  `{fulfilled: true, balanceCredited: false}`. The recovery cron completes it on
  the next cycle (≤ 5 minutes) — exactly once.
- **Redis is not authoritative.** If Redis is down the in-flight lock
  *fails open* and the MongoDB guards still guarantee a single credit.
- **Rejections never credit:** bad/missing signature, amount mismatch, unknown
  invoice, or a paid webhook for an invoice already `reversed`.
- **Reversals** (`reversed` / `refunded` / `chargedback`) move `paid → reversed`
  and alert the admin. A later `paid` webhook for a reversed invoice is ignored.

### 5.2 TRX (automatic scanner)

Same two-phase pattern (`status: "unpaid" → "paid"`, then `balanceCredited`),
plus:

- `transactionHash` is a **sparse unique index** — one on-chain transaction can
  settle at most one invoice; reuse raises `E11000` and is treated as consumed.
- The scanner stops after the first successful match per transaction, so a single
  deposit can never clear several pending invoices.
- Amount matching uses a 1 % tolerance to absorb rate drift between quote and payment.
- Wallet credit happens **before** the Telegram notification, so a user is never
  told “paid” for money that was not added.

### 5.3 Manual bank transfer

A receipt is posted to the admin group with a **✅ Confirm** button.

- **Admin-only.** The callback re-checks that the clicker is in `ADMINS` **and**
  in `GROUP_ID` — a forwarded message’s buttons still deliver callbacks, so
  identity is never inferred from the button itself.
- **Single credit.** Confirmation is an atomic
  `findOneAndUpdate({ paymentId, status: { $ne: "confirmed" } })`. A double-click
  or a replayed callback credits once.
- **Amount comes from the database**, never from `callback_data`.

### 5.4 Purchasing a service (wallet → VPN)

```
1. RESERVE   User.findOneAndUpdate({telegramId, balance:{$gte:price}}, {$inc:{balance:-price}})
2. PROVISION POST /create to the WizardXray panel
3. COMMIT    User.updateOne({telegramId}, {$push:{services}, $inc:{totalServices:1}})
4. ROLLBACK  on any failure → User.$inc{balance:+price}  + admin-group alert
```

- **No TOCTOU.** The reservation is atomic, so two concurrent purchases can never
  both pass a balance check; the balance can never go negative.
- **No lost updates.** Field-level `$inc`/`$push` replaced whole-document
  `save()`, which could silently overwrite a balance a payment had just credited.
- **No silent money loss.** If the panel returns an error or the request times
  out, the reservation is refunded automatically and the user is told; the admin
  group is alerted. If the refund *itself* fails, the group receives an explicit
  “fix this balance manually” alert instead of failing quietly.
- **One caveat:** if the panel creates the service but the DB commit fails, the
  user keeps the config and is **not** refunded (they received value) — the admin
  group is alerted to record the service manually.

---

## 6. Railway deployment

### 6.1 Push to GitHub

```bash
git add -A
git commit -m "chore: production readiness"
git push origin <branch>
```

Confirm `.env` is **not** in the commit (`.gitignore` covers `.env` and `.env.*`,
with `.env.example` explicitly kept).

### 6.2 Create the Railway project

1. Sign in at [railway.app](https://railway.app) → **New Project**.
2. **Deploy from GitHub repo** → select this repository.
3. Railway detects Node and runs `npm install` then `npm start`.

### 6.3 Add the datastores and wire their variables

- **New → Database → MongoDB** (or an external MongoDB Atlas cluster).
- **New → Database → Redis** (or an external Redis).

A Railway database service exposes its credentials to **its own** service, not to
yours. You must add them to the **application** service as *reference variables*
on the **Variables** tab (the reference picker autocompletes these):

```text
MONGO_URL   = ${{MongoDB.MONGO_URL}}
REDIS_URL   = ${{Redis.REDIS_URL}}
```

That is usually enough. If you prefer discrete values instead of a URL, the
Railway-native names are accepted **as-is** — no renaming required:

```text
REDIS_HOST      = ${{Redis.REDISHOST}}
REDIS_PORT      = ${{Redis.REDISPORT}}
REDIS_USERNAME  = ${{Redis.REDISUSER}}
REDIS_PASSWORD  = ${{Redis.REDISPASSWORD}}
```

MongoDB additionally accepts `MONGODB_URI`, `MONGO_URI`, `DATABASE_URL`, or the
discrete `MONGOHOST` / `MONGOPORT` / `MONGOUSER` / `MONGOPASSWORD`.

> **A variable added to the database service is not visible to your app.**
> Forgetting this is the single most common cause of
> `The "uri" parameter to openUri() must be a string, got "undefined"`.

After adding variables Railway creates *staged changes* — press **Deploy** to
apply them, then confirm the startup log shows:

```text
  ✔ MongoDB   resolved from MONGO_URL
  ✔ Redis     resolved from REDIS_URL
  ✔ All required variables are present
```

If anything is missing the app prints exactly which variable is absent and exits
with a non-zero code, rather than failing later with a cryptic driver error.

### 6.4 Configure environment variables

Service → **Variables** → add every **Required** variable from
[section 4](#4-environment-variables). Do not set `PORT` — Railway provides it.

### 6.5 Start command and Node version

| Setting | Value |
|---|---|
| Start command | `npm start` (equivalent to `node bot.js`) |
| Build command | *(default)* `npm install` |
| Node version | `>=20` (declared in `package.json` → `engines`) |

### 6.6 Public domain

Service → **Settings → Networking → Generate Domain**. Copy the HTTPS URL, e.g.
`https://your-app.up.railway.app`, and set:

```
WEBHOOK_BASE_URL=https://your-app.up.railway.app
```

**No trailing slash.** Then redeploy so the value is picked up.

### 6.7 Health check

Service → **Settings → Deploy → Healthcheck Path** → `/health`.

- `GET /health` → **200** whenever the process is alive (plus `ts`, `pid`, `uptime`).
  Railway restarts on a non-200, so a transient MongoDB blip must not cause a
  restart loop — dependency state is reported separately.
- `GET /ready` → **200** only when MongoDB is connected, **503** otherwise. Use
  this for external monitoring / uptime checks.

### 6.8 Deploy and verify

1. **Deploy** and watch **Logs** for:
   ```
   ✔ MongoDB connected successfully
   ✔ DB Ready
   ✔ Webhook server listening on port <PORT>
   ✔ HooshPay Recovery Cron Started
   🚀 TRX Wallet Scanner Started
   ```
2. Verify the probes:
   ```bash
   curl -i https://YOUR-DOMAIN/health   # expect 200 {"ok":true,...}
   curl -i https://YOUR-DOMAIN/ready    # expect 200 {"ready":true,...}
   ```
3. Verify the bot: send `/start` in Telegram.
4. Verify the webhook: create an invoice in the bot and complete a real payment,
   then confirm “PAYMENT_SIGNATURE_VALID” → “PAYMENT_CREDITED” in the logs.
5. **Redeployment:** pushing to the connected branch redeploys automatically.
6. **Rollback:** Railway → Deployments → pick a previous build → **Redeploy**.
   (Or `git revert` + push, to keep the branch honest.)

### 6.9 Common deployment failures

| Symptom in the logs | Cause | Fix |
|---|---|---|
| `The "uri" parameter to openUri() must be a string, got "undefined"` | `MONGO_URL` was added to the **database** service instead of the application service, or staged changes were never deployed | Add `MONGO_URL = ${{MongoDB.MONGO_URL}}` to the **app** service and press **Deploy** |
| `❌ Redis Client Error: getaddrinfo ENOTFOUND` | Redis variables not referenced into the app service | Add `REDIS_URL = ${{Redis.REDIS_URL}}` (or the discrete names) and redeploy |
| `❌ FATAL — these variables are missing or empty` | Required variables absent | The block lists each missing name; add them and redeploy |
| `❌ ADMINS is missing or contains no valid IDs` | `ADMINS` empty or non-numeric | Use plain numeric Telegram IDs, comma-separated |
| `409 Conflict` on polling | More than one replica | Set **Replicas = 1** |
| `⚠️ npm warn config production Use --omit=dev instead` | Railway sets `NPM_CONFIG_PRODUCTION` | Harmless — informational only |

---

## 7. HooshPay webhook

Production URL format:

```
https://YOUR-RAILWAY-DOMAIN/api/hooshpay/webhook
```

Register exactly that URL in the HooshPay dashboard and set the same secret in
`HOOSHPAY_WEBHOOK_SECRET`.

- `WEBHOOK_BASE_URL` must be the **public HTTPS origin only**, with **no trailing
  slash** and no path. The app appends `/api/hooshpay/webhook` itself.
- Signature verification is **mandatory**: keys are sorted (ksort), the payload is
  re-serialised compactly, and the HMAC-SHA256 is compared with
  `crypto.timingSafeEqual`. A missing secret rejects **all** webhooks — there is
  no bypass.
- The endpoint always answers **200** immediately and processes asynchronously;
  fulfillment is idempotent and crash-safe, so an early 200 cannot lose a payment
  (the recovery cron finishes anything interrupted).
- Oversized payloads (> 64 KB) are rejected with **413**; per-IP rate limiting
  defaults to 600 requests/minute (`WEBHOOK_RATE_LIMIT_PER_MIN=0` disables it).

---

## 8. Railway scaling — one replica

> ### ⚠️ This service MUST run with exactly **1 replica**.

The Telegram bot uses **long polling**. Two replicas would compete for the same
updates and trigger `409 Conflict`, causing missed messages and erratic
behaviour. The TRX scanner, the HooshPay cron and the Express server all live in
that same process.

Redis locks (`hoosh:cron:*`, `trx:scan:cron`) prevent duplicate *cron* and
*scanner* execution across instances, but they cannot make long polling safe.

To scale horizontally you must first migrate the bot to **Telegram webhook mode**
(`setWebhook` + a `POST /telegram/webhook` route, with the same single-writer
discipline for the update stream). Until then: **replicas = 1**.

On Railway: Service → **Settings → Deploy → Replicas = 1**.

---

## 9. Testing

```bash
npm test
```

| Location | Scope | Requires MongoDB |
|---|---|---|
| `tests/hooshpay.test.js` | HooshPay payload contract & invoice state machine | no |
| `tests/unit/` | Real `utils/auth.js`, real webhook signature verification, real amount validators | no |
| `tests/integration/hooshpayFulfillment.test.js` | Real two-phase credit, duplicate & concurrent webhooks, crash recovery | yes |
| `tests/integration/webhookHttp.test.js` | Real Express app over HTTP: signature/amount/size handling, concurrency | yes |
| `tests/integration/purchaseFlow.test.js` | Real purchase flow with a stubbed panel: reserve/commit/**refund** | yes |
| `tests/integration/adminBankConfirm.test.js` | Real admin callbacks: authorization, double-click, tampered amount | yes |
| `tests/integration/trxScanner.test.js` | Real scanner claims, hash reuse, reverted transactions, recovery | yes |
| `tests/unit/adminAudit.test.js` | Audit idempotency, replay/conflict handling, metadata redaction | no |
| `tests/unit/adminAuthSession.test.js` | Web sign-in codes (single use, rate limited) and session lifecycle | no |
| `tests/unit/adminValidation.test.js` | Admin input hardening (IDs, amounts, pagination, reasons) | no |
| `tests/integration/adminServices.test.js` | Real admin services: user search, balance idempotency, products, payments, recovery, VPN registry, broadcast safety | yes |
| `tests/integration/adminWeb.test.js` | Real HTTP: login flow, CSRF, session enforcement, SPA, admin API | no (data tests: yes) |
| `tests/integration/adminTelegramPanel.test.js` | Telegram panel authorization, navigation, safe failures | no (data screens: yes) |

Expected result on a machine with MongoDB available: **212 tests, all passing,
0 skipped** (without MongoDB the DB-backed suites skip by design).

```text
# tests 212
# pass 212
# fail 0
```

---

## 10. Production checklist

**MongoDB**
- [ ] `MONGO_URL` set and reachable; `/ready` returns 200.
- [ ] Automated backups enabled (Atlas snapshot schedule or `mongodump` cron).
- [ ] Indexes built on first boot (`hooshpayinvoices`, `cryptoinvoices`, `users`).

**Redis**
- [ ] `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` correct; logs show `✔ Redis connected`.
- [ ] Persistence (AOF/RDB) enabled if you value session continuity.

**Telegram**
- [ ] `BOT_TOKEN` valid; logs show no `polling_error`.
- [ ] `ADMINS` contains real numeric IDs — a typo locks everyone out of the panel.
- [ ] `GROUP_ID` is the **negative** supergroup id.
- [ ] Bot is an admin in the group (needed to read messages / delete receipts).

**HooshPay**
- [ ] `HOOSHPAY_API_KEY` valid.
- [ ] `HOOSHPAY_WEBHOOK_SECRET` is a long random value (**not** a placeholder).
- [ ] `WEBHOOK_BASE_URL` is the public HTTPS origin, no trailing slash.
- [ ] Webhook URL registered in the HooshPay dashboard.
- [ ] One real low-value payment completed end-to-end.

**WizardXray**
- [ ] `WIZARD_API_URL` / `VPN_API_KEY` valid; `/status` in the admin panel works.
- [ ] Panel account has enough balance to provision.

**TRX**
- [ ] `TRX_WALLET` correct (starts with `T`, 34 chars).
- [ ] `CMC_API_KEY` set (otherwise a fixed fallback price is used).
- [ ] One real small TRX payment matched and credited.

**Railway**
- [ ] **Replicas = 1.**
- [ ] Healthcheck path `/health`.
- [ ] `WEBHOOK_BASE_URL` matches the generated domain exactly.

**Secrets**
- [ ] `.env` is not committed (`git log --all -- .env` is empty).
- [ ] No token or key appears in logs or the repository.

**Webhook / logs / backups**
- [ ] `/health` and `/ready` monitored externally.
- [ ] Alert on log patterns `PAYMENT_SIGNATURE_INVALID`, `REFUND FAILED`,
      `REFUND`, `Balance credit FAILED`, `Cron cycle error`.
- [ ] MongoDB backups verified by a test restore.

---

## 11. Operations & recovery

**Health**
```bash
curl -s https://YOUR-DOMAIN/health   # liveness
curl -s https://YOUR-DOMAIN/ready    # readiness (MongoDB)
```

**Stuck HooshPay payments** (Phase 1 done, Phase 2 missing) — self-healing within
5 minutes. To force it: admin panel → HooshPay report → **ارسال مجدد موجودی**
(for a single invoice), or inspect with:
```
db.hooshpayinvoices.find({ fulfilled: true, balanceCredited: false })
```
This set should be empty except transiently during a crash.

**Stuck TRX credit** — the scanner repairs `{ status: "paid", balanceCredited: false }`
at the start of each cycle.

**Recommended log alerts**
| Pattern | Meaning |
|---|---|
| `PAYMENT_SIGNATURE_INVALID` | Someone is posting unsigned/forged webhooks |
| `Amount mismatch` | A webhook amount disagreed with the stored invoice |
| `REFUND FAILED` | A wallet refund failed — **manual correction required** |
| `Balance credit FAILED` | Phase-2 write failed; the flag was rolled back and will retry |
| `Cron cycle error` | The recovery cron threw |

**Graceful shutdown** — `SIGTERM`/`SIGINT` stop Telegram polling, the TRX scanner
and the cron, then close Express, MongoDB and Redis before exiting. Railway sends
`SIGTERM` on redeploy, so in-flight work finishes instead of being cut off.

For VPS/PM2/Nginx deployment details, deeper monitoring queries and the manual
recovery playbook, see [`DEPLOYMENT_CHECKLIST.md`](DEPLOYMENT_CHECKLIST.md).

---

## 12. Admin Panel ecosystem (web + Telegram)

Both admin interfaces are thin presentations over the same audited service
layer. **No business logic is duplicated** between them.

```
Telegram admin panel (handlers/admin/panel.js)     Web dashboard (web/public SPA)
                    │                                        │
                    └──────────────┬─────────────────────────┘
                                   ▼
                        services/admin/*  (shared)
   authorization · audit · users · vpns · payments · recovery · products
   broadcast · analytics · monitoring · auth (web sessions)
                                   │
                 ┌─────────────────┼──────────────────┐
                 ▼                 ▼                  ▼
       existing models      WizardXray client   HooshPay client
       (User, invoices,     (api/wizardApi.js)  (services/hooshpay/*)
        WalletPurchase…)         │                  │
                                 └──── Redis ───────┘
                              sessions · locks · rate limits
```

### 12.1 Web dashboard

Open `<WEBHOOK_BASE_URL>/admin`. Sign-in is Telegram-based:

1. Enter the Telegram ID of an account listed in `ADMINS`.
2. The bot DMs a one-time code (valid 5 minutes, single use, SHA-256 stored).
3. The server issues a Redis-backed session (HttpOnly, `Secure`, `SameSite=Lax`
   cookie + double-submit CSRF token; TTL `ADMIN_SESSION_TTL_SECONDS`).

Pages: Dashboard (KPIs, revenue/orders/users charts, popular packages, live
system health), Users (search/filters/sorts + profile with balance, block,
payments, services), VPN Services (registry + WizardXray detail with
change-link/disable/revoke), Payments (all providers, status tabs, full
timeline incl. webhook events), Recovery (queue + safe retry-all), Products
(CRUD/duplicate/reorder/enable — the panel catalog that powers product-mix &
profit analytics; the Telegram shop still sells the built-in plan list, see
§12.5),
Broadcast (preview, audience, rate-limited delivery, cancel, progress),
Analytics, Referrals, Audit Log, System health.

JSON API (all session + CSRF protected, idempotent via `operationId`):

| Route | Purpose |
|---|---|
| `POST /api/admin/auth/request-code` · `POST /api/admin/auth/verify` · `POST /api/admin/auth/logout` · `GET /api/admin/auth/session` | Authentication |
| `GET /api/admin/dashboard` | KPI + chart data |
| `GET /api/admin/users` · `GET /api/admin/users/:id` · `POST /api/admin/users/:id/balance` · `…/block` · `…/unblock` | User management |
| `GET /api/admin/vpns` · `GET /api/admin/vpns/:username` · `POST /api/admin/vpns/:username/actions` | VPN management |
| `GET /api/admin/payments` · `GET /api/admin/payments/:key` · `POST …/retry` · `…/recovery-required` · `…/resolve` · `POST /api/admin/payments/bank/:id/confirm` · `…/reject` | Payments |
| `GET /api/admin/recovery` · `POST /api/admin/recovery/retry-safe` | Recovery |
| `GET/POST/PATCH /api/admin/products…` · `POST /api/admin/products/reorder` | Catalog |
| `POST /api/admin/broadcast` (+`/preview`, `/cancel/:id`, `/status/:id`, `GET /broadcasts`) | Broadcast |
| `GET /api/admin/analytics` · `GET /api/admin/audit` · `GET /api/admin/system/health` · `GET /api/admin/referrals` | Analytics / audit / ops |

### 12.2 Telegram panel

`/admin` (private chat for allowlisted admins, or the admin group) → 👑 SWIFT
ADMIN main menu. Navigation follows the same sections as the web dashboard,
with confirmations for every sensitive action and pagination where needed.
The panel stores long IDs in the chat session and references them by index so
`callback_data` stays under Telegram's 64-byte limit.

### 12.3 Money safety in admin actions

- **Balance changes** use a new durable idempotency ledger
  (`User.appliedAdminBalanceKeys`) written atomically with the `$inc` — a
  repeated HTTP callback or replayed button can never change a balance twice.
- **Payment retries** call the *existing* idempotent fulfillment paths
  (`fulfillHooshOrder`, `confirmBankPayment`, scanner Phase-2, purchase
  commit). Duplicate webhooks still credit exactly once.
- **Ambiguous provisioning is never replayed** — manual-review orders are
  surfaced, not re-created, so a paid order can never provision twice.
- Every mutation writes an `AdminAuditLog` record **before** executing
  (`started` → `succeeded`/`failed`), keyed by a unique `operationId`.

### 12.4 New database collections

`AdminAuditLog`, `AdminProduct`, `AdminBroadcast`, `SystemHealth` — plus
additive fields on existing models (VPN expiry/traffic on services & purchases,
recovery/retry bookkeeping on all invoice models, `lastActivityAt` /
`referralCode` / block metadata on `User`). Indexes are created automatically
at startup; nothing existing is dropped or rewritten.

### 12.5 Honest limitations

- VPN **extend-time / increase-traffic / regenerate-config** are marked
  unavailable everywhere: the configured WizardXray client has no safe
  endpoint for them (the user-facing bot already shows the same notice).
- **Product catalog scope:** the `AdminProduct` catalog is real data that
  powers the panel's product-mix and profit analytics, but the Telegram
  shop's checkout still sells the built-in plan list
  (`plans30/60/90`). Editing a product does not change what the shop
  charges. Wiring the checkout to the catalog
  (`getActiveProducts`/`getActiveProductById` in `services/plans.js`,
  which already fall back to the built-in list when the DB is empty or
  unreachable) is a deliberate follow-up so it can ship with full
  DB-backed integration coverage of the money path.
- Activity/referral tracking starts with this release — historical accounts
  appear on their next interaction.
- `expired VPNs` counts tracked orders; services registered before this
  release without a linked purchase show as *unknown expiry* until looked up
  individually.
