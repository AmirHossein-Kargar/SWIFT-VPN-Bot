# Deployment checklist (VPS / PM2 / Nginx)

> **Audience:** an administrator deploying the bot to a server for the first time, or after a
> major update. For Railway see [docs/deployment.md](docs/deployment.md); for day-two tasks see
> [docs/operations.md](docs/operations.md).

## Quick start

```bash
cp .env.example .env     # then fill in every required value (see docs/configuration.md)
npm install
npm run preflight        # must report 0 failures
npm run build            # builds /panel and the public storefront
npm start
```

## 1. Server requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| Node.js | 20 (see `engines` in `package.json`) | Current LTS |
| MongoDB | A version supported by Mongoose 8 | Replica set |
| Redis | 6.x | 7.x |
| RAM | 512 MB | 1 GB |
| Network | Outbound HTTPS; public HTTPS endpoint for webhooks | Reverse proxy (Nginx/Caddy) with TLS |

## 2. Environment variables

Copy `.env.example` to `.env` and set every required variable. The complete reference, with
defaults, aliases and validation rules, is [docs/configuration.md](docs/configuration.md); do
not duplicate it here. Points that most often go wrong on a VPS:

- **`GROUP_ID`** is the admin group's chat ID (a negative number). Read it from the `chat.id`
  field of a bot update (for example from `getUpdates` after posting in the group). Do **not**
  add unknown third-party bots to the admin group to discover it.
- **`WIZARD_API_URL`** is the WizardXray **API v1 base URL** with no trailing slash (the method
  name is appended), not the panel's web address.
- **`WEBHOOK_BASE_URL`** is the public HTTPS origin only: no trailing slash, no path.
- **`CARD_NUMBER`** is optional and legacy (the manual card-to-card flow is no longer offered); it is
  validated only if set.
- **NOWPayments** keys and the IPN secret are required; `NOWPAYMENTS_API_KEY` must be the API
  key, not the public key.

### Configuring the HooshPay webhook

1. Generate a long random secret and put it in `HOOSHPAY_WEBHOOK_SECRET`:
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
2. In the HooshPay dashboard open the webhook settings.
3. Set the URL to `https://<your-domain>/api/hooshpay/webhook` and the secret to the same value.
4. Enable the payment events your dashboard offers (paid, reversed, refunded).

Without `HOOSHPAY_WEBHOOK_SECRET` the webhook fails closed and rejects every callback. Configure
NOWPayments the same way: IPN URL `https://<your-domain>/api/nowpayments/ipn` and the secret in
`NOWPAYMENTS_IPN_SECRET`. Never share these values or paste them into chats or tickets.

## 3. Pre-deployment check

```bash
npm run preflight
```

It validates the configuration (naming the variable and rule, never printing values), connects
to MongoDB and Redis, and probes the public health endpoint, the webhook routes and the
HooshPay, NOWPayments and WizardXray APIs. It ends with
`Preflight result: N failure(s), M warning(s).` Fix every `✖ FAIL` before starting the bot.
Warnings about probes that "did not complete" are expected before the first deploy.

## 4. Manual verification

### 4.1 HooshPay webhook secret

- [ ] Set in `.env` and **identical** in the HooshPay dashboard
- [ ] Generated randomly (not a word or placeholder), at least 32 characters

### 4.2 `WEBHOOK_BASE_URL`

- [ ] Public domain with HTTPS and a valid certificate (not localhost, not self-signed)
- [ ] No trailing slash; port 443 open; the proxy forwards to `PORT` (default 3000)
- [ ] `curl https://your-domain.com/health` returns `{"ok":true,…}`

### 4.3 MongoDB

- [ ] Service is running (`systemctl status mongod`) and `MONGO_URL` is correct
- [ ] The database user has `readWrite` on the target database
- [ ] Atlas: the server's IP is on the access list

### 4.4 Redis

- [ ] Service is running and the host, port and password variables are correct
- [ ] `redis-cli -h $REDIS_HOST -p $REDIS_PORT ping` returns `PONG`

### 4.5 Webhook route

- [ ] `curl -X POST https://your-domain.com/api/hooshpay/webhook -H "Content-Type: application/json" -d '{}'`
      returns **`401`** (`invalid_signature`). That proves the route is mounted and rejects unsigned
      bodies; a `404` means the proxy or URL is wrong.

### 4.6 Admin dashboards

- [ ] `https://your-domain.com/panel` shows the sign-in page (and `/next-panel`, `/panel-next`, `/admin` redirect to it; expect a one-time re-login after the move)
- [ ] A Telegram ID from `ADMINS` receives the one-time code from the bot and can sign in
- [ ] `GET /api/admin/dashboard` without a session returns `401`
- [ ] Signing out clears the session cookie

### 4.7 Bot startup

- [ ] `npm start` runs without errors; the log shows `✔ DB Ready` and
      `✔ Webhook server listening on port <PORT>`
- [ ] The log shows `✔ HooshPay Recovery Cron Started` and `✔ NOWPayments Recovery Cron Started`
- [ ] `/start` gets a reply
- [ ] As an allow-listed admin, `/admin` in a private chat (or `/panel` / `پنل` in the admin group)
      opens the **👑 SWIFT ADMIN** panel

### 4.8 Payment smoke test

- [ ] As a test user tap **💰 افزایش موجودی**; both **💳 پرداخت آنلاین کارت به کارت** (HooshPay) and
      **🪙 پرداخت با کریپتو** (NOWPayments) appear
- [ ] In the NOWPayments dashboard the IPN secret and callback URL match
      `https://<host>/api/nowpayments/ipn`
- [ ] The bot can reach the Gheymat USDT/IRT quote (the free tier is rate-limited; the default
      quote cache is 10 minutes). Set `GHEYMAT_API_TOKEN` only if you use a paid plan
- [ ] Enter an amount; an invoice is created and the payment link opens; the **✅ پرداخت کردم**
      button is present
- [ ] Complete one real low-value payment and confirm the balance is credited
- [ ] `db.hooshpayinvoices.findOne({})` shows `fulfilled: true, balanceCredited: true`

## 5. Process management (PM2)

```bash
npm install -g pm2
```

`ecosystem.config.cjs`:

```js
module.exports = {
  apps: [{
    name: "swift-vpn-bot",
    script: "bot.js",
    instances: 1,           // MUST be 1: the bot uses long polling
    exec_mode: "fork",      // NOT cluster
    watch: false,
    max_memory_restart: "500M",
    env_file: ".env",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    merge_logs: true,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: "10s",
  }],
};
```

> **Use `instances: 1` and `exec_mode: "fork"`.** Cluster mode would run several pollers on the
> same bot token and Telegram would answer `409 Conflict`. The Redis leases protect the crons,
> not the polling.

```bash
mkdir -p logs
npm run build                 # after every update, before restarting
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                   # run the command it prints to enable start on boot
pm2 logs swift-vpn-bot        # live logs; also: pm2 status | restart | stop
```

## 6. Nginx reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    # Webhook: pass the body through unchanged (required for signature validation)
    location /api/hooshpay/webhook {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_buffering         off;
        client_max_body_size    64k;
    }

    # Everything else: storefront, dashboards, API, health
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 64k;
    }
}

server {
    listen 80;
    server_name bot.example.com;
    return 301 https://$host$request_uri;
}
```

> `proxy_request_buffering off` matters for the webhook: if the proxy rewrites the body, the bytes
> the bot verifies may differ from the bytes the gateway signed. The sample host name is a
> placeholder; replace it with your own.

## 7. Database indexes

Mongoose creates the indexes on first start. To verify:

```js
use swiftvpn
db.hooshpayinvoices.getIndexes()
```

Expected on `hooshpayinvoices`:

- `{ uid: 1 }`: unique **and sparse** (several invoices may have no `uid`)
- `{ orderId: 1 }`: unique
- `{ fulfilled: 1, balanceCredited: 1, status: 1 }`: recovery cron
- `{ status: 1, createdAt: 1 }`: expiry cron
- `{ userId: 1, createdAt: -1 }`: user lookup

### Legacy `uid` index: automatic one-time migration

Earlier releases created `{ uid: 1 }` as unique but **not** sparse. MongoDB never redefines an
existing index, so that index made index creation fail on every start (`IndexOptionsConflict`,
code 85) and the bot stopped before polling.

On startup the app now replaces exactly that legacy definition (`hooshpayinvoices.uid_1`, key
`{ uid: 1 }`, unique, not sparse) with the unique + sparse index. The replacement can only relax
the constraint, so no invoice data is affected, and it is idempotent.

Any other `uid` index (custom name or options, non-unique) is **never dropped**: startup fails
closed with the stage `index_migration` and names the conflicting index so you can reconcile it
by hand (`db.hooshpayinvoices.getIndexes()`).

## 8. Monitoring, alerts and recovery

The bot writes structured JSON logs to stdout (`ts`, `service`, `level`, `message`, plus context
such as `userId` and `amount`). The messages worth alerting on, the recovery procedures for stuck
payments, and what *not* to do (never edit balances by hand in MongoDB) are in
[docs/operations.md](docs/operations.md). Log an alert on `Critical startup dependency failed`
first: its `stage` field says whether the config, MongoDB, the index migration or Redis failed.

## 9. Rollback

Prefer a non-destructive revert:

```bash
git log --oneline -5
git revert <bad-commit>        # creates a new commit; history is preserved
npm install && npm run build
pm2 restart swift-vpn-bot
```

Redeploying an earlier release is also fine. Data changes are additive, with one exception: a
release older than the `uid` index migration (section 7) defines the original non-sparse index and
will fail index creation against the migrated one, so roll back only to releases that include the
migration.

## 10. Admin panel notes

| Topic | Notes |
|---|---|
| URLs | `<WEBHOOK_BASE_URL>/panel` (Next.js; `/next-panel`, `/panel-next` and `/admin` redirect to it); served by the same process, nothing extra to deploy |
| Auth | Telegram allow-list (`ADMINS`) + one-time code by direct message + Redis session (HttpOnly cookie, CSRF token) |
| Session lifetime | `ADMIN_SESSION_TTL_SECONDS` (default 8 h, min 15 min, max 24 h) |
| Telegram panel | `/admin`, `/panel` or `پنل`; in private chat for allow-listed admins, or in the group set by `GROUP_ID` |
| Audit | Every sensitive action is stored in `AdminAuditLog` with actor, target, reason and IP (web) |
| Plans | The `AdminProduct` catalog (create, edit, reorder, enable) drives panel analytics only. Customers are always charged from the fixed plan list in `services/plans.js` (see [docs/payments.md](docs/payments.md)) |
| Broadcasts | Sent in batches of 25 with a pause between batches, cancellable |
| Backups | Include the new collections (`AdminAuditLog`, `AdminAccount`, `AdminProduct`, `AdminBroadcast`, `SystemHealth`, `MockTestRun`, `PaymentTombstone`) |

## Final go / no-go

| Check | Done |
|---|---|
| `npm run preflight` reports 0 failures | ☐ |
| `HOOSHPAY_WEBHOOK_SECRET` and `NOWPAYMENTS_IPN_SECRET` are set in `.env` and in the provider dashboards | ☐ |
| `WEBHOOK_BASE_URL` is a public HTTPS origin | ☐ |
| MongoDB healthy and indexed; Redis healthy | ☐ |
| `/health` returns 200 and `/ready` returns 200 | ☐ |
| Bot answers `/start`; admin panel opens | ☐ |
| A real low-value payment completes end to end | ☐ |
| Exactly one process / replica | ☐ |
| PM2 start on boot is enabled | ☐ |
| `.env` is not committed (`git log --all -- .env` is empty) | ☐ |

**Deploy only when every box is checked.**
