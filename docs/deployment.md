# Deployment

The bot, the Express server and all background jobs run in **one Node.js process**
(`npm start` → `node bot.js`). This page covers Railway, which the project is set up for.
For a VPS with PM2 and Nginx see [`DEPLOYMENT_CHECKLIST.md`](../DEPLOYMENT_CHECKLIST.md); for
day-two tasks see [Operations](operations.md).

## Requirements

- Node.js 20 or newer (`engines` in `package.json`)
- MongoDB (mandatory: the bot does not start polling until it is reachable and its indexes exist)
- Redis (sessions, locks, cron leases)
- A public HTTPS URL for the payment webhooks
- **Exactly one replica** — see [Scaling](#scaling-one-replica)

## Railway

1. **Create the project.** Railway → *New Project* → *Deploy from GitHub repo* → select this
   repository and the branch you want to deploy. Pushing to that branch redeploys.
2. **Add MongoDB and Redis** (Railway databases or external services such as Atlas).
3. **Wire their variables into the application service.** A database service exposes its
   credentials to *itself*, not to your app. On the application service's *Variables* tab add
   reference variables:

   ```text
   MONGO_URL = ${{MongoDB.MONGO_URL}}
   REDIS_URL = ${{Redis.REDIS_URL}}
   ```

   Railway's native names (`REDISHOST`, `MONGOHOST`, …) are also accepted; see
   [alternate names](configuration.md#alternate-names). After adding variables press **Deploy**
   to apply the staged changes. Forgetting this step is the most common cause of
   `The "uri" parameter to openUri() must be a string`.
4. **Set the remaining required variables** from the
   [configuration reference](configuration.md#required). Do not set `PORT`; Railway provides it.
5. **Build and start commands.**

   | Setting | Value |
   |---|---|
   | Build | `npm install && npm run build` — builds the `/panel-next` dashboard and the public storefront. If the storefront build is missing, `/` falls back to the static page |
   | Start | `npm start` |
   | Healthcheck path | `/health` |
   | Replicas | `1` |

6. **Generate a public domain** (*Settings → Networking*), set
   `WEBHOOK_BASE_URL=https://<your-domain>` (**no trailing slash**) and redeploy.
7. **Verify** (see [below](#verify-a-deployment)).
8. **Roll back** from *Deployments → pick a previous build → Redeploy*, or `git revert` and push so
   the branch history stays honest.

### Verify a deployment

The startup log should contain these lines (exact wording and order can vary slightly):

```text
  ✔ MongoDB   resolved from MONGO_URL
  ✔ Redis     resolved from REDIS_URL
  ✔ Required variables are present and structurally valid
✔ Webhook server listening on port <PORT>
✔ DB Ready
Redis connected (configuration: …)
🚀 TRX Wallet Scanner Started
✔ HooshPay Recovery Cron Started
✔ NOWPayments Recovery Cron Started
```

Then:

```bash
curl -i https://YOUR-DOMAIN/health   # 200 whenever the process is alive
curl -i https://YOUR-DOMAIN/ready    # 200 only when MongoDB, Redis and Telegram polling are all ready
```

Send `/start` to the bot in Telegram, then complete one real low-value payment end to end and
confirm the `PAYMENT_CREDITED` log line and the new wallet balance.

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /health`, `GET /livez` | `200` while the process is alive. Railway restarts on non-200, so dependency state is deliberately **not** part of it (a MongoDB blip must not cause a restart loop) |
| `GET /ready` | `200` only when HTTP, MongoDB, Redis **and** Telegram polling are all ready; otherwise `503`. The JSON body (`{ ready, dependencies: { http, mongo, redis, telegram } }`) shows which one is not. Use it for external monitoring |

## Webhooks

| Provider | URL | Verification |
|---|---|---|
| HooshPay | `<WEBHOOK_BASE_URL>/api/hooshpay/webhook` | HMAC-SHA256 with `HOOSHPAY_WEBHOOK_SECRET` |
| NOWPayments | `<WEBHOOK_BASE_URL>/api/nowpayments/ipn` (or `NOWPAYMENTS_IPN_CALLBACK_URL`) | HMAC-SHA512 with `NOWPAYMENTS_IPN_SECRET` |

Register exactly these URLs in the provider dashboards and set the same secrets in the
environment. `WEBHOOK_BASE_URL` must be the public HTTPS **origin only**; the app appends the
path itself.

- Signature verification is mandatory: for HooshPay the keys are sorted, the payload is
  re-serialized compactly and compared with `crypto.timingSafeEqual`. A missing secret rejects
  **all** deliveries; there is no bypass.
- HooshPay deliveries are answered `200` immediately and processed asynchronously. Fulfillment
  is idempotent and crash-safe, so an early `200` cannot lose a payment (the recovery cron
  finishes anything interrupted).
- Payloads over 64 KB are rejected with `413`. The per-IP limit defaults to 600 requests per
  minute (`WEBHOOK_RATE_LIMIT_PER_MIN`, `0` disables it).
- Behind a reverse proxy, pass the request body through unbuffered so the signed bytes are
  unchanged (see the Nginx example in the checklist).

## Scaling: one replica

> **This service must run with exactly one replica.**

The Telegram bot uses long polling; two replicas compete for the same updates and Telegram
answers `409 Conflict`, causing missed messages. The TRX scanner, the recovery crons and the
Express server live in the same process. Redis leases (`hoosh:cron:*`, `trx:scan:cron`,
`lock:invoice-cleanup`) stop duplicate *cron* runs but cannot make long polling safe.

Scaling horizontally would first require moving the bot to Telegram webhook mode with a
single-writer update stream. On Railway: *Settings → Deploy → Replicas = 1*.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The "uri" parameter to openUri() must be a string` or `✖ MongoDB NOT CONFIGURED` | The Mongo variable was added to the database service, or staged changes were never deployed | Add `MONGO_URL = ${{MongoDB.MONGO_URL}}` to the **application** service and deploy |
| `✖ Redis NOT CONFIGURED` or Redis `ENOTFOUND` errors | Redis variables not referenced into the application service | Add `REDIS_URL = ${{Redis.REDIS_URL}}` (or the discrete names) and redeploy |
| `❌ N required configuration problem(s); values were not printed` | Required variables missing or malformed | The lines above it name each variable and the rule it broke; fix them and redeploy |
| `✖ ADMINS Every admin ID must be a positive safe integer` | `ADMINS` empty or not numeric | Use plain numeric Telegram IDs, comma-separated |
| `Critical startup dependency failed` with `stage` `index_migration` | A custom `uid` index on `hooshpayinvoices` blocks replacing the legacy `uid_1` index | The log names the conflicting index; it is never dropped automatically. Inspect `db.hooshpayinvoices.getIndexes()` and reconcile by hand |
| Other `stage` values: `mongo_config`, `mongo_connect`, `mongo_ping`, `index_init`, `redis_connect` | The named startup stage failed | Fix that dependency; connection strings and credentials are never printed |
| `polling_error` with status `409` | More than one replica or another process uses the same bot token | Set replicas to 1 and stop other instances |
| HooshPay webhooks return `401 invalid_signature` (log: `Webhook signature rejected`) | `HOOSHPAY_WEBHOOK_SECRET` differs from the dashboard value | Set the same secret in both places. For NOWPayments the equivalent log line is `IPN signature rejected` |
