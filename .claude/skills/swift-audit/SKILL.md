---
name: swift-audit
description: Audit the SWIFT VPN Bot's trust boundaries, money paths, privileged admin operations and sensitive-data handling, and keep the boundary inventory current. Use for security reviews, before releases, and when a new integration, route or privileged operation is added.
---

# Security audit

Policy lives in `.claude/rules/security-privacy.md`, `.claude/rules/money-paths.md` and `docs/privacy.md`. This skill
is the audit procedure and the inventory it checks against.

## Trust-boundary inventory

| Boundary | Entry point | Must hold |
|---|---|---|
| Telegram updates (messages, callback data) | `bot.js`, `handlers/` | Callback data is opaque ids; amounts and prices come from stored records; blocked users are gated (`services/users/accessGate.js`) |
| HooshPay webhook | `POST /api/hooshpay/webhook` (`server.js`) | HMAC verified before any state change; amount and invoice matched; idempotent |
| NOWPayments IPN | `POST /api/nowpayments/ipn` (`server.js`) | Signature verified; only `finished` credits; idempotent |
| Admin web API and dashboard | `/api/admin` (`web/adminRouter.js`), `/panel` | Allow-list + one-time code, session, CSRF, same-origin, rate limits, audit before mutation |
| Customer support portal | `/api/support` (`web/supportRouter.js`), `/panel/support` | Customer session scoped to own tickets and attachments |
| Public storefront API | `/api/store` (`web/storeRouter.js`): `/catalog`, `/plans/:planId` | Read-only, no customer data, strict CSP on the page |
| Outbound providers | `api/wizardApi.js`, `services/hooshpay/`, `services/nowpayments/`, `services/pricing/` | Timeouts; ambiguous results never replayed; no secrets in logs |
| NOWPayments custody and payouts (optional) | `services/admin/custody.js` | Credentials only from env; admin-only; audited |
| Datastores | MongoDB, Redis | MongoDB authoritative for money; Redis never trusted for balances |

Privileged operations to trace end to end: wallet credit/debit, refunds and retries (`services/admin/payments.js`),
payment deletion, custody conversions/payouts, admin registry changes, broadcasts, ticket deletion, catalog edits.

## Procedure

1. **Refresh the inventory.** List the mounted routes (`app.use`/`app.post` in `server.js`, `router.<method>` in
   `web/*Router.js`) and outbound clients. Anything missing from the table is a new boundary: audit it and add it to
   the table in this task.
2. **Per boundary,** read the handler and its middleware and confirm each "must hold" item against code and tests. Note
   any check that exists only in the UI.
3. **Money paths:** for each credit/debit/refund, find the conditional update and the unique key that make it
   idempotent, and the recovery cron that finishes an interrupted flow.
4. **Secrets and data:** grep new logging for payloads, tokens, connection strings; run `npm run check:sensitive`.
   Do not rewrite git history; history findings go to the owner.
5. **Dependencies:** `npm audit --omit=dev` for production advisories; check `overrides` in `package.json` against
   `docs/storefront.md` (Security notes).
6. **Report** findings with severity, `file:line`, a concrete exploit or failure scenario, and the fix, plus any
   inventory rows you added or removed. Cite sensitive values by file, line and category only, never the value.
   Write it to `.claude/_generated/swift-audit-<YYYY-MM-DD-HHMM>.md` using the format under "Skill output" in
   `CLAUDE.md`, then summarize in chat with the file path.

## Keeping this skill current

- The table above must match the code. A new route, webhook, provider client, admin capability or datastore is added
  here in the same task that introduces it (areas `money-paths`, `admin-security`, `support` and `privacy-tooling` in
  `.claude/context-map.json` point back to this file).
- If a boundary is removed, delete its row; do not leave historical entries.
- Put new invariants in the rule files, and keep only the audit steps here.
