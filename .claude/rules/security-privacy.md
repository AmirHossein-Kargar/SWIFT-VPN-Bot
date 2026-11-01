# Security and privacy invariants

The repository is public; `docs/privacy.md` is the policy and `docs/configuration.md` covers secret handling.

- **Fail closed.** No admins unless `ADMINS` is valid; every webhook is rejected unless its secret is configured and
  the signature verifies. New endpoints follow the same default.
- **Admin access.** Allow-list plus a one-time Telegram code, Redis-backed `HttpOnly` sessions, CSRF tokens, trusted-origin
  checks and rate limits. CORS and the origin check never authenticate: they must never replace or bypass the session or token. Every admin mutation writes its audit entry before acting. A new admin route must use the
  existing middleware in `web/adminRouter.js` / `web/adminMiddleware.js`, not its own checks. Admin presence is a record for the
  directory: no access decision may read it, and it must never delay or fail a request (`docs/admin.md`).
- **Long-lived responses.** Access can end while a response is open, so a stream re-checks its session on a timer and fails closed;
  it is capped, drops a slow reader, and closes before `http.Server.close()`, which would otherwise wait for it. See
  `docs/reliability.md`.
- **Secrets.** Never commit, log, print or return them to a browser; the settings view reports only whether a value is
  configured. Logs carry error type/code, never request bodies, tokens or connection strings.
- **Personal and payment data.** Fixtures use obviously fake values (rules in `docs/privacy.md`); build realistic-looking
  values at runtime as `tests/unit/checkSensitive.test.js` does. When reporting findings, cite file/line/category,
  never the value.
- **Web hardening.** The storefront keeps its strict CSP (`script-src 'self'`); `/panel` keeps its nonce-based CSP and stays
  non-framable. In production, trust origins from configuration only, never from `Host`. CORS answers with an exact origin,
  never `*`. See `.claude/rules/frontend.md` and `docs/admin.md`.
- **Status claims need evidence.** A settings or status field for a protection comes from `web/securityPosture.js` or another
  real check, never a literal `true`. A new guard or pre-session route is taught to it in the same change.
- **History.** Rewriting git history, force-pushing or deleting branches needs the owner's explicit approval.
