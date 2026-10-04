# SWIFT-VPN-Bot — Production Deployment Checklist

> **Audience:** Server administrator deploying the bot for the first time, or after a major update.
> **Last updated:** Based on commit `2833ddd` — HooshPay production-ready integration.

---

## Quick Start

```bash
# 1. Copy and fill in environment variables
cp .env.example .env
nano .env          # fill every required value

# 2. Run the automated preflight check
node scripts/preflight.js

# 3. If all checks pass, start the bot
npm start
```

---

## Section 1 — Server Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| Node.js | 18.x LTS | 20.x LTS or 22.x |
| MongoDB | 6.0 standalone | 7.0 replica set |
| Redis | 6.x | 7.x |
| RAM | 512 MB | 1 GB |
| Outbound HTTPS | Required | — |
| Public HTTPS endpoint | Required (for webhooks) | Behind nginx/Caddy with TLS |

---

## Section 2 — Environment Variables

Copy `.env.example` to `.env` and fill **every field marked REQUIRED**.

### 2.1 Telegram

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ REQUIRED | Get from [@BotFather](https://t.me/BotFather). Format: `123456:ABC-DEF...` |
| `ADMINS` | ✅ REQUIRED | Comma-separated Telegram **user** IDs of admins. E.g. `123456789,987654321` |
| `GROUP_ID` | ✅ REQUIRED | Telegram **group/supergroup** chat ID (negative number). E.g. `-100123456789` |

**How to get GROUP_ID:** Add [@username_to_id_bot](https://t.me/username_to_id_bot) to your admin group, it will show the group ID.

### 2.2 Database

| Variable | Required | Description |
|---|---|---|
| `MONGO_URL` | ✅ REQUIRED | MongoDB connection string. E.g. `mongodb://user:pass@host:27017/swiftvpn?authSource=admin` |

### 2.3 Redis

| Variable | Required | Description |
|---|---|---|
| `REDIS_HOST` | ✅ REQUIRED | Redis hostname or IP. E.g. `127.0.0.1` |
| `REDIS_PORT` | ✅ REQUIRED | Redis port. Default: `6379` |
| `REDIS_PASSWORD` | Optional | Redis AUTH password if configured |

### 2.4 HooshPay — Primary Payment Gateway

| Variable | Required | Description |
|---|---|---|
| `HOOSHPAY_API_KEY` | ✅ REQUIRED | Get from [HooshPay dashboard](https://hooshpay.xyz). Used to create invoices. |
| `HOOSHPAY_WEBHOOK_SECRET` | ✅ REQUIRED | **Must match** the secret configured in HooshPay → Settings → Webhooks. Used for HMAC-SHA256 signature verification. **Never share this.** |
| `WEBHOOK_BASE_URL` | ✅ REQUIRED | Public HTTPS URL of this server. **No trailing slash.** E.g. `https://bot.yourdomain.com` |

> ⚠️ **Without `HOOSHPAY_WEBHOOK_SECRET`**, all incoming webhooks bypass signature validation. Any attacker who knows your webhook URL can fake payment confirmations.

#### Generating a strong webhook secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Paste the output into both your `.env` and the HooshPay dashboard.

#### Configuring HooshPay webhook:
1. Log into [hooshpay.xyz](https://hooshpay.xyz)
2. Go to **Settings → Webhooks**
3. Set URL to: `https://your-domain.com/api/hooshpay/webhook`
4. Set secret to the same value as `HOOSHPAY_WEBHOOK_SECRET`
5. Enable events: `payment.paid`, `payment.reversed`, `payment.refunded`

### 2.5 VPN Panel API

| Variable | Required | Description |
|---|---|---|
| `WIZARD_API_URL` | ✅ REQUIRED | Base URL of the VPN panel. E.g. `https://panel.yourdomain.com` |
| `VPN_API_KEY` | ✅ REQUIRED | Bearer token for the VPN panel API |

### 2.6 Payment Methods

| Variable | Required | Description |
|---|---|---|
| `CARD_NUMBER` | ✅ REQUIRED | 16-digit bank card number shown to users for card-to-card transfers |
| `TRX_WALLET` | ✅ REQUIRED | Tron (TRC-20) wallet address. Starts with `T`, 34 characters. |
| `CMC_API_KEY` | Optional | CoinMarketCap API key for live TRX/USD rate. Get free key at [coinmarketcap.com](https://pro.coinmarketcap.com/signup). If not set, TRX payments will fail. |

### 2.7 Profit Calculation

| Variable | Required | Default | Description |
|---|---|---|---|
| `COST_PER_DAY` | Optional | `200` | Server cost per day in Toman |
| `COST_PER_GB` | Optional | `300` | Server cost per GB in Toman |

### 2.8 Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | Optional | `3000` | Port for the Express webhook server |

---

## Section 3 — Pre-Deployment Checks

Run the automated check:

```bash
node scripts/preflight.js
```

**Expected output on a correctly configured server:**

```
── 1. Required Environment Variables ─────────────────────────
  ✔ PASS  BOT_TOKEN is set
  ✔ PASS  ADMINS is set
  ...
── Final Result ──────────────────────────────────────────────
  ✅ ALL CHECKS PASSED — SYSTEM IS GO FOR PRODUCTION
```

**If any check shows `✖ FAIL`**, fix it before starting the bot. Do not ignore failures.

---

## Section 4 — Manual Verification Steps

Complete these after the preflight script passes.

### 4.1 HOOSHPAY_WEBHOOK_SECRET

- [ ] Value is set in `.env`
- [ ] Value is **identical** in HooshPay dashboard webhook settings
- [ ] Value was generated with `crypto.randomBytes(48)` or equivalent (not a human-readable word)
- [ ] Value is NOT the placeholder `your_hooshpay_webhook_secret_here`

### 4.2 WEBHOOK_BASE_URL

- [ ] Points to a public IP or domain (not localhost)
- [ ] Uses HTTPS (valid TLS certificate — not self-signed for production)
- [ ] No trailing slash
- [ ] Port 443 (or custom port) is open in firewall
- [ ] Nginx/Caddy/reverse proxy is routing to `PORT=3000` correctly
- [ ] Test manually: `curl https://your-domain.com/health` → should return `{"ok":true,...}`

### 4.3 MongoDB

- [ ] Service is running: `systemctl status mongod`
- [ ] Connection string in `MONGO_URL` is correct
- [ ] Database user has `readWrite` permissions on the target database
- [ ] If using MongoDB Atlas, IP whitelist includes your server's IP

### 4.4 Redis

- [ ] Service is running: `systemctl status redis`
- [ ] `REDIS_HOST` and `REDIS_PORT` are correct
- [ ] If `REDIS_PASSWORD` is required, it is set
- [ ] Test: `redis-cli -h $REDIS_HOST -p $REDIS_PORT ping` → should return `PONG`

### 4.5 Webhook Route

- [ ] Bot server is running (or will start)
- [ ] `POST https://your-domain.com/api/hooshpay/webhook` returns `200`
- [ ] Test: `curl -X POST https://your-domain.com/api/hooshpay/webhook -H "Content-Type: application/json" -d '{}'` → `200 OK`

### 4.6 Web Admin Dashboard (new)

- [ ] Open `https://your-domain.com/admin` — the sign-in page loads
- [ ] Enter your Telegram ID (must be listed in `ADMINS`)
- [ ] Receive the one-time code from the bot in a private chat
- [ ] Sign in — the dashboard loads with live metrics
- [ ] `/api/admin/dashboard` without a session returns `401`
- [ ] Sign out works and the session cookie is cleared

### 4.7 Bot Startup

- [ ] Start with `npm start` and check for errors in console
- [ ] Confirm `✔ DB Ready` appears
- [ ] Confirm `✔ Webhook server listening on port 3000` appears
- [ ] Confirm `✔ HooshPay Recovery Cron Started` appears
- [ ] Send `/start` to the bot in Telegram — it should respond
- [ ] Send `پنل` or `/admin` in the admin group — the 👑 SWIFT ADMIN panel should appear
- [ ] Send `/admin` to the bot in a private chat (as an allowlisted admin) — the panel opens

### 4.7 Payment Flow Smoke Test

- [ ] As a test user: tap **💰 افزایش موجودی**
- [ ] Confirm **💳 پرداخت آنلاین (HooshPay)** button appears
- [ ] Enter an amount (e.g. `50,000`)
- [ ] Confirm an invoice is created (check HooshPay dashboard)
- [ ] Confirm payment link opens correctly
- [ ] Confirm **✅ پرداخت کردم** button is present
- [ ] Complete a real test payment
- [ ] Confirm balance is credited in the bot
- [ ] Check MongoDB: `db.hooshpayinvoices.findOne({})` — confirm `fulfilled: true, balanceCredited: true`

---

## Section 5 — Process Management (PM2)

### Install PM2

```bash
npm install -g pm2
```

### Create ecosystem file

```bash
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: "swift-vpn-bot",
    script: "bot.js",
    instances: 1,           // MUST be 1 — bot uses polling, not webhook mode
    exec_mode: "fork",      // NOT cluster — single instance for polling
    watch: false,
    max_memory_restart: "500M",
    env_file: ".env",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    merge_logs: true,
    restart_delay: 5000,    // wait 5s before restart to avoid rapid cycling
    max_restarts: 10,
    min_uptime: "10s",
  }]
};
EOF
```

> ⚠️ **Use `instances: 1` and `exec_mode: "fork"`**. Do NOT use cluster mode — the bot uses Telegram long-polling which must run in a single process. The HooshPay recovery cron has a Redis distributed lock that handles multiple instances, but the Telegram polling will conflict.

### Start, save, and enable on boot

```bash
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable on system boot
```

### Useful PM2 commands

```bash
pm2 logs swift-vpn-bot      # live log tail
pm2 status                   # process status
pm2 restart swift-vpn-bot   # restart
pm2 stop swift-vpn-bot      # stop
```

---

## Section 6 — Nginx Reverse Proxy (if applicable)

```nginx
server {
    listen 443 ssl;
    server_name bot.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/bot.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.yourdomain.com/privkey.pem;

    # Webhook endpoint — pass raw body intact (required for HMAC validation)
    location /api/hooshpay/webhook {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # CRITICAL: do not buffer — pass body through unchanged so HMAC is correct
        proxy_request_buffering off;
        proxy_buffering         off;
        client_max_body_size    64k;
    }

    # Health check and all other routes
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        client_max_body_size 64k;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name bot.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

> ⚠️ `proxy_request_buffering off` is **critical** for the webhook endpoint. If nginx buffers the request body, the raw bytes used for HMAC signature computation may differ from what the bot receives.

---

## Section 7 — Database Indexes

MongoDB indexes are created automatically by Mongoose on first startup. To verify they exist:

```js
// In mongosh or MongoDB Compass
use swiftvpn
db.hooshpayinvoices.getIndexes()
```

Expected indexes:
- `{ uid: 1 }` — unique
- `{ orderId: 1 }` — unique
- `{ fulfilled: 1, balanceCredited: 1, status: 1 }` — recovery cron
- `{ status: 1, createdAt: 1 }` — expiry cron
- `{ userId: 1, createdAt: -1 }` — user lookup

---

## Section 8 — Monitoring & Alerts

The bot emits **structured JSON logs** to stdout. Every payment event includes:

```json
{
  "ts": "2026-09-16T10:00:00.000Z",
  "service": "hooshpay",
  "level": "info",
  "message": "Phase-2 complete: balance credited",
  "cid": "550e8400-e29b-41d4-a716-446655440000",
  "uid": "inv_abc123",
  "userId": 123456789,
  "amount": 50000,
  "newBalance": 150000
}
```

### Recommended monitoring queries

```bash
# Watch payment confirmations live
pm2 logs swift-vpn-bot | grep '"message":"Phase-2 complete'

# Count failed fulfillments today
grep '"level":"error"' logs/error.log | grep hooshpay | wc -l

# Find any stuck invoices (should be 0)
grep '"message":"Crash recovery' logs/out.log
```

### Critical log patterns to alert on

| Pattern | Severity | Action |
|---|---|---|
| `"DB error crediting balance"` | 🔴 Critical | Check MongoDB, run `node scripts/preflight.js` |
| `"Balance credit FAILED"` | 🔴 Critical | Admin notified via Telegram, but also check logs |
| `"REVERSAL received"` | 🟠 High | Admin notified via Telegram automatically |
| `"Redis acquire failed"` | 🟡 Medium | Redis is down; payment still works via MongoDB guard |
| `"User not found"` | 🟡 Medium | Payment received but user deleted — manual credit needed |

---

## Section 9 — Recovery Procedures

### Stuck payments (fulfilled=true, balanceCredited=false)

The recovery cron handles this automatically every 5 minutes. To trigger it immediately:

1. In the Telegram admin group, send `/panel`
2. Tap **🏦 گزارش HooshPay**
3. If any stuck invoices appear, tap **⚡ اجرای تسویه‌های معلق**

### Manual balance credit (admin)

If a user paid but balance was not credited:

```js
// In mongosh
use swiftvpn
db.hooshpayinvoices.findOne({ uid: "inv_xxx" })
// Verify status and fulfilled fields, then:
db.users.updateOne({ telegramId: "USER_ID" }, { $inc: { balance: AMOUNT } })
db.hooshpayinvoices.updateOne({ uid: "inv_xxx" }, { $set: { balanceCredited: true } })
```

### Reset a hung lock (if a lock is stuck in Redis)

```bash
redis-cli -h $REDIS_HOST -p $REDIS_PORT DEL "hoosh:lock:INV_UID"
```

---

## Section 10 — Rollback Plan

If the deployment fails:

```bash
# Revert to previous working commit
git log --oneline -5
git checkout PREVIOUS_COMMIT_HASH -- .
npm start

# Or with PM2
pm2 stop swift-vpn-bot
git revert HEAD
pm2 start ecosystem.config.cjs
```

---

## Final GO / NO-GO Sign-off

| Check | Status | Signed off by |
|---|---|---|
| Preflight script passes (0 failures) | ⬜ | |
| HOOSHPAY_WEBHOOK_SECRET set in both .env and HooshPay dashboard | ⬜ | |
| WEBHOOK_BASE_URL is public HTTPS | ⬜ | |
| MongoDB healthy and indexed | ⬜ | |
| Redis healthy with SET NX working | ⬜ | |
| /health endpoint returns 200 | ⬜ | |
| Bot responds to /start | ⬜ | |
| Test payment completes end-to-end | ⬜ | |
| PM2 startup on boot enabled | ⬜ | |
| .env not committed to git | ⬜ | |

**Deploy only when all boxes are checked.**

---

## Section 7 — Admin Panel (web + Telegram)

| Topic | Notes |
|---|---|
| URL | `<WEBHOOK_BASE_URL>/admin` — served by the same Railway service, no extra deploy |
| Auth | Telegram allowlist (`ADMINS`) + one-time code DM + Redis session (HttpOnly cookie, CSRF token) |
| Session TTL | `ADMIN_SESSION_TTL_SECONDS` (default 8 h, min 15 min, max 24 h) |
| Telegram panel | `/admin` or `پنل` — private chat for allowlisted admins; group requires `GROUP_ID` |
| Audit | Every sensitive action lands in `AdminAuditLog` with actor, target, reason and IP (web) |
| Products | `AdminProduct` catalog (CRUD, reorder, enable) powers panel product-mix & profit analytics; defaults are seeded on first boot. The Telegram shop still sells the built-in plan list — catalog-driven checkout is a follow-up (README §12.5) |
| Broadcasts | Rate-limited (~25 msg/s), cancellable, resume from the last acknowledged recipient |
| Backups | Include the new collections: `AdminAuditLog`, `AdminProduct`, `AdminBroadcast`, `SystemHealth` |
