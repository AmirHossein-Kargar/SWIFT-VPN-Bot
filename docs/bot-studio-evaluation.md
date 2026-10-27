# Bot Studio evaluation and System Health diagnostics

Reference: <https://github.com/telefunction/bot-studio> (version 1.5.1 at evaluation time, read from a shallow clone; nothing from it was copied into this repository).

## What Bot Studio is

A Vue 3 + Vite + Tailwind 4 single-page app that browses Telegram's Bot API schema (`public/schema/bot-api.json`, refreshed by a GitHub Actions schema cron), builds request payloads and **sends them from the visitor's browser straight to `https://api.telegram.org/bot<token>/<method>`** with a token the visitor types in.

It has **no** scheduled monitoring, uptime history, alerting or incident detection (searched `src/` and `scripts/`; the only "cron" is the schema-update workflow). It is a request builder, not a monitoring system.

## Decision

| Option | Verdict |
|---|---|
| A. Restricted Telegram API explorer tab | Rejected. A generic explorer adds attack surface (even allow-listed, it is a Bot API proxy behind the admin session) and `getUpdates` through it would 409-conflict with the single long-polling consumer. The only Bot API calls that help operators are fixed and read-only, so they are built into System Health instead. |
| B. Reuse Bot Studio components | Rejected. Different framework (Vue vs this React/Next panel), and its model is "token in the browser", which this project forbids. |
| C. Replace existing checks | Rejected. Bot Studio has no equivalent of MongoDB/Redis/WizardXray/payment/job checks. |
| D. Reject direct integration | **Chosen**, plus the independently useful improvements below. |

### Licence
Bot Studio is **GPL-3.0-only**. This repository declares no licence. Copying or adapting its code into the admin panel would ship GPL code to browsers inside a combined work, i.e. distribution, which would require offering the corresponding source of the combined work under GPL-3.0. That is incompatible with keeping this private codebase's licensing open, so no code or schema file was copied. Using it as an external tool (for example its hosted page with a throw-away test bot's token, never the production token) is unaffected.

## What was implemented instead (all server-side, read-only)

In `services/admin/monitoring.js`, surfaced on the existing System Health page:

- **Telegram check, extended** (still `getMe` first, so existing semantics are kept):
  - Long-polling health: `startBot.js` now reports `polling_error` (status code only) via `recordPollingError`. A recent **409 Conflict** (another process polling with the same token, which silently starves this instance) marks the bot **down** with an actionable message; other recent errors mark it degraded. There is no success event, so a 2-minute quiet window means recovered.
  - `getWebhookInfo` (read-only, does not consume updates): reports whether a webhook is registered (degraded, because it conflicts with polling), the pending-update backlog (degraded above 100) and Telegram's last delivery error, scrubbed of tokens/URLs and truncated. The webhook URL itself is never returned.
  - If `getWebhookInfo` fails the bot is not turned red; the card says the info is unavailable.
- **Order fulfilment check** (new service `orders`): counts of reserved orders waiting for provider funds, orders needing manual reconciliation, stalled provisioning (> 10 min), pending refunds, undelivered admin alerts and created-but-undelivered services (see `docs/reserved-orders.md`). Counts and one age only; no customer or order identifiers. A backlog is **degraded**, never **down**, so it cannot turn the overall status red the way MongoDB, Redis or Telegram can.
- **Outage behaviour fixed:** with MongoDB down the persisted-state lookup used to block the page ~10 s on Mongoose's buffer; it is now skipped when there is no connection.
- Admin UI: the two cards show their details (`admin-panel/lib/health-details.ts`, `health-overview.tsx`).

No new endpoint, process, poller, database or outbound URL was added. The existing `/api/admin/system/health` route keeps its session, CSRF and rate-limit middleware; results stay cached for 30 s, so Telegram is called at most twice per cache window. The bot token is never read by the browser or placed in a response.

## Known limits

- Health history and alerting do not exist (only last success/failure per service). Adding a time series and push alerts would be a separate feature.
- `/ready` latches `telegram: false` after the first `polling_error` and is never set back to true (`startBot.js`, `server.js`). The Railway healthcheck is `/health`, so it is not fatal, but `/ready` can stay 503 after a transient blip. Left unchanged; flagged for a decision.
