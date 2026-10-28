# Privacy and sensitive-data policy

This repository is public. Anything committed, including in tests, docs and history, should be
treated as permanently public. Deleting it later does not recall copies.

## Never commit

- Real secrets: bot tokens, API keys, webhook/IPN secrets, database or Redis URLs with real
  passwords, private keys, session cookies.
- Personal data: real names, email addresses, phone numbers, Telegram user IDs, usernames of
  real people, screenshots or logs that contain them.
- Financial data: real card numbers, IBANs, wallet addresses that belong to a person, invoices,
  receipts, payment links.
- Runtime state: `.env` files, `sessions/`, logs, database dumps. These are git-ignored; keep it
  that way.

## Fixtures and sample data

Tests and examples must use values that are obviously fake and cannot be mistaken for real ones:

| Data | Use |
|---|---|
| Card numbers | A number that fails the Luhn check, or a published network test number (for example `4242 4242 4242 4242`) |
| Phone numbers | Ascending or repeated digits (`0912 345 6789`, `0900 000 0000`) |
| Email | `user@example.com`, `*.example.test` (reserved domains) |
| Telegram IDs | Round placeholders such as `424242` or `111111111` |
| Secrets and tokens | Values containing `test`, `fake`, `secret`, `placeholder`, `xxxx` |
| TRON addresses | Synthetic, checksum-valid addresses derived from a hash of a label, or the public USDT contract |
| Hostnames | `example.com`, `*.internal`, `*.invalid` |

If a fixture must look real to exercise validation, build it at runtime (see
`tests/unit/checkSensitive.test.js`) so the source file never contains it.

## Automated checks

`scripts/check-sensitive.mjs` scans for Luhn-valid card numbers, Iranian IBANs, bot tokens, common
API-key formats, private keys, URIs with real-looking credentials, high-entropy secret
assignments, non-placeholder emails and non-placeholder Iranian mobile numbers. It never prints a
value, only `file:line CATEGORY [length]`.

```bash
npm run check:sensitive                       # every tracked file
node scripts/check-sensitive.mjs --staged     # only the lines you are about to commit
git config core.hooksPath .githooks           # run it automatically before every commit (once per clone)
```

- Personal names and handles are project-specific. Put one regular expression per line in the
  untracked file `.git/info/privacy-blocklist` and the scanner will flag them too.
- A deliberate fixture can opt out with `privacy-allow: <reason>` in a comment on the same line.
  Use it sparingly and say why.
- The scan runs in `npm test` (`tests/unit/checkSensitive.test.js`).
- It complements GitHub secret scanning and push protection (below); it does not replace them.

## Commit identity

Commit metadata is public too. Use your GitHub noreply address, shown under
GitHub → Settings → Emails (form `<id>+<username>@users.noreply.github.com`), and enable
**Keep my email addresses private** and **Block command line pushes that expose my email**.

```bash
git config user.name  "<your public name or username>"
git config user.email "<your GitHub noreply address>"
```

Run these without `--global` to apply them to this repository only.

## GitHub settings (repository owner)

- Settings → Code security: enable **Secret scanning** and **Push protection**. They detect
  provider-format tokens but not card numbers or personal data, hence the local checker.
- Settings → Branches: protect `master` and require pull requests, so history is not rewritten
  or force-pushed by accident.

## If something sensitive was committed

1. Do not push. If it is only in local commits, amend or rebase it out.
2. If it was pushed: treat it as exposed. Rotate or revoke secrets; for payment data contact the
   issuer; for personal data decide whether a history rewrite is warranted.
3. Removing a file in a new commit does **not** remove it from history. A rewrite
   (`git filter-repo`), a force-push and a request to GitHub Support to purge cached views and
   pull-request refs are needed, and copies in clones, forks and archives cannot be recalled.
