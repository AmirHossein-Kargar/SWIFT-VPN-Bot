# Operations and recovery

Day-two tasks for a running deployment. For first-time setup see [Deployment](deployment.md)
and, for a VPS, [`DEPLOYMENT_CHECKLIST.md`](../DEPLOYMENT_CHECKLIST.md).

## Production checklist

**MongoDB**

- [ ] `MONGO_URL` is set and reachable; `/ready` returns 200 (it also requires Redis and Telegram polling).
- [ ] Automated backups are enabled (Atlas snapshot schedule or a `mongodump` cron) and a test restore has worked.
- [ ] Indexes were built on first boot (`hooshpayinvoices`, `cryptoinvoices`, `users`).

**Redis**

- [ ] Redis variables are correct and the log shows `Redis connected`.
- [ ] Persistence (AOF/RDB) is enabled if you value session continuity.

**Telegram**

- [ ] `BOT_TOKEN` is valid and the log shows no `polling_error`.
- [ ] `ADMINS` contains real numeric IDs (a typo locks everyone out of the panel).
- [ ] `GROUP_ID` is the **negative** supergroup ID, and the bot is an admin there.

**Payments**

- [ ] `HOOSHPAY_API_KEY` and `HOOSHPAY_WEBHOOK_SECRET` are valid; the secret is long and random, not a placeholder.
- [ ] `NOWPAYMENTS_API_KEY` is the API key (not the public key); `NOWPAYMENTS_IPN_SECRET` matches the dashboard.
- [ ] `WEBHOOK_BASE_URL` is the public HTTPS origin with no trailing slash, and both webhook URLs are registered.
- [ ] One real low-value payment per provider has completed end to end.
- [ ] `TRX_WALLET` is correct; `CMC_API_KEY` is set if you still use the legacy direct-TRX flow.

**VPN panel**

- [ ] `WIZARD_API_URL` and `VPN_API_KEY` are valid; the status view in the admin panel works.
- [ ] The panel account has enough balance to provision.

**Platform**

- [ ] Replicas = 1; the healthcheck path is `/health`; `/ready` is monitored externally.
- [ ] No `.env` is committed (`git log --all -- .env` is empty) and no token or key appears in logs.

## Alerts

The bot writes structured JSON logs (`ts`, `service`, `level`, `message`, …). Alert on these
messages:

| Message (substring) | Level | Meaning / action |
|---|---|---|
| `Critical startup dependency failed` | error | A startup stage failed; read the `stage` field ([troubleshooting](deployment.md#troubleshooting)) |
| `Webhook secret is not configured` | error | Every webhook is being rejected until the secret is set |
| `Webhook signature rejected` · `IPN signature rejected` | warn | Unsigned or forged callbacks; a burst is worth investigating |
| `Signed payment fields failed local invoice validation` | warn | A signed notification disagreed with the stored invoice (for example the amount); nothing was credited |
| `Atomic wallet credit failed` · `Atomic TRX wallet credit failed` | error | A credit write failed; the invoice stays recoverable and the cron retries |
| `Webhook processing failed; gateway retry requested` | error | The gateway will redeliver |
| `Payment reversal recorded; wallet debit is a manual reconciliation` | warn | A paid invoice was reversed at the provider; an admin must decide how to reconcile the wallet |
| `WizardXray create outcome is ambiguous; reservation retained and request will not be replayed` | warn | An order is in manual review: confirm on the panel whether the service exists |
| `Wallet reservation result is unknown; purchase recovery required` · `Wallet purchase recovery step failed` · `WizardXray created a service but its result needs database recovery` | error | A purchase needs recovery; use the admin Recovery page |
| `TRX transfer matches multiple invoices; automatic credit withheld` | warn | Ambiguous deposit; an admin must review it |
| `Redis scan lease unavailable; using database safeguards` | warn | Redis is down; credits still use the MongoDB guards |

## Recovery

**Stuck HooshPay payment** (`fulfilled: true`, `balanceCredited: false`) heals by itself within
5 minutes. To force it: admin Telegram panel → **گزارش HooshPay** → **اجرای تسویه‌های معلق**, or
**ارسال مجدد موجودی** for a single invoice. To inspect:

```js
db.hooshpayinvoices.find({ fulfilled: true, balanceCredited: false })
```

This set should be empty except briefly after a crash.

**Stuck TRX credit:** the scanner repairs `{ status: "paid", balanceCredited: false }` at the
start of every cycle. **Stuck NOWPayments invoice:** the recovery cron re-checks open invoices
every 2 minutes.

**Payments and orders needing a decision** are listed in the web dashboard's **Recovery** and
**Payments** pages, which call the same idempotent fulfillment paths the webhooks use (safe to
retry; duplicates still credit once).

**A user paid but was not credited.** Do not edit balances by hand in MongoDB: that bypasses
the idempotency ledger and the audit log, so a later retry can credit twice. Verify the invoice
state, then use the admin panel: retry the payment from **Payments**, or, if the provider
confirms payment but fulfillment cannot run, **Users → Credit** with a reason (audited and
idempotent). Record the invoice ID in the reason.

**Stuck Redis lock:** lock keys expire on their own; to clear one, `redis-cli DEL "<key>"`
(for example `hoosh:cron:<job>`).

## Monitoring queries

Examples assume PM2 logs; adapt the paths to your platform.

```bash
pm2 logs swift-vpn-bot | grep '"message":"PAYMENT_CREDITED'     # watch credits live
grep '"level":"error"' logs/error.log | grep -c hooshpay          # errors today
```

## Money Flow Sentinel

The `/panel/sentinel` reconciliation job runs in this process. Its health is the status bar on those pages, not System Health. It logs
under `"service":"money-flow-sentinel"`. A failing run changes no money: the panel shows reconciliation as delayed, then
stale, with the last error type. The first pass after a deploy may list many informational findings for customers from
before the wallet ledger; that is history, not a fault. `SENTINEL_ENABLED=off` stops the job. See
[Money Flow Sentinel](sentinel.md).

## Service Reliability Center

`/panel/reliability` is the first place to look when something seems wrong: it shows what has evidence of working, what does
not, and what has none. It logs under `"service":"service-reliability"`. A failing monitor changes no business record: the page
goes *Stale* by itself. Right after a deploy, jobs read *Unknown* until each reports, and a quiet payment provider reads *Unknown*
until real traffic proves it; neither is a fault. `RELIABILITY_ENABLED=off` stops it. See
[troubleshooting](reliability.md#troubleshooting).

## Shutdown and restarts

`SIGTERM` / `SIGINT` stop Telegram polling, the TRX scanner and the crons, close the panel's live streams, then close Express,
MongoDB and Redis before exiting, so in-flight work finishes. Railway sends `SIGTERM` on
redeploy.
