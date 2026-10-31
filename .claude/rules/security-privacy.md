# Security and privacy invariants

The repository is public; `docs/privacy.md` is the policy and `docs/configuration.md` covers secret handling.

- **Fail closed.** No admins unless `ADMINS` is valid; every webhook is rejected unless its secret is configured and
  the signature verifies. New endpoints follow the same default.
- **Admin access.** Allow-list plus a one-time Telegram code, Redis-backed `HttpOnly` sessions, CSRF tokens, same-origin
  checks and rate limits. Every admin mutation writes its audit entry before acting. A new admin route must use the
  existing middleware in `web/adminRouter.js` / `web/adminMiddleware.js`, not its own checks.
- **Long-lived responses.** Access can end while a response is open, so a stream re-checks its session on a timer and fails closed;
  it is capped, drops a slow reader, and closes before `http.Server.close()`, which would otherwise wait for it. See
  `docs/reliability.md`.
- **Secrets.** Never commit, log, print or return them to a browser; the settings view reports only whether a value is
  configured. Logs carry error type/code, never request bodies, tokens or connection strings.
- **Personal and payment data.** Fixtures use obviously fake values (rules in `docs/privacy.md`); build realistic-looking
  values at runtime as `tests/unit/checkSensitive.test.js` does. When reporting findings, cite file/line/category,
  never the value.
- **Web hardening.** The storefront keeps its strict CSP (`script-src 'self'`); `/panel` stays non-framable. See
  `.claude/rules/frontend.md`.
- **History.** Rewriting git history, force-pushing or deleting branches needs the owner's explicit approval.
