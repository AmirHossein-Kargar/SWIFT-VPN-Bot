# SWIFT VPN Bot: instructions for Claude Code

A Telegram bot that sells VLESS subscriptions: customers fund a wallet (HooshPay, NOWPayments), buy plans that are
provisioned on a WizardXray panel, and admins work from Telegram or the Next.js dashboard at `/panel`. One Node.js
process (`bot.js` → `startBot.js` → `server.js`) runs the bot, the Express API, the storefront and the recovery crons.
Architecture, features and the repository layout are in `README.md`; do not repeat them here.

## Where each fact lives (single source of truth)

| Topic | Authoritative file |
|---|---|
| Product overview, architecture diagram, layout, endpoints | `README.md` |
| Environment variables, aliases, secret handling | `docs/configuration.md`, `.env.example` |
| Money paths and their guarantees | `docs/payments.md`, `docs/reserved-orders.md` |
| Financial monitoring and reconciliation | `docs/sentinel.md` |
| Admin surfaces and `/api/admin` | `docs/admin.md` |
| Support tickets | `docs/support.md` |
| Storefront build, routes, CSP | `docs/storefront.md` |
| Colour palette, scrollbars, skeletons for both Next apps | `design/theme.css` |
| Deployment, health checks, scaling | `docs/deployment.md`, `docs/operations.md`, `DEPLOYMENT_CHECKLIST.md` |
| Test suites and prerequisites | `docs/testing.md` |
| Sensitive-data policy | `docs/privacy.md` |
| Invariants Claude must not break, by area | `.claude/rules/*.md` (loaded for matching paths) |
| Review, audit, test and maintenance procedures | `.claude/skills/*/SKILL.md` |
| Which docs describe which code (impact map) | `.claude/context-map.json` |

A fact is written once, in the file above, and linked from elsewhere. If two files disagree, investigate the code and
tests before deciding which one is wrong; do not assume the current code is the intended rule.

## Commands

| Command | Use |
|---|---|
| `npm test` | Unit + integration suites (`scripts/run-tests.mjs`). Read the test-safety rules below first |
| `npm run test:release` | Full suite against disposable MongoDB + Redis; any skip fails |
| `npm run check:sensitive` | Scan tracked files for secrets and personal data (never prints values) |
| `npm run check:context` | Validate the Claude context: documented paths, npm scripts, links, skills, impact map |
| `node scripts/check-context.mjs --diff` | Map the current change set to the docs and rules that must be re-checked |
| `npm run build` | Build `/panel` (admin-panel) and the storefront |
| `npm run build:guide-images` | Redraw the top-up guide images from `storefront/lib/topup-guide.json` (needs Chrome; the images are committed) |
| `npm run test:e2e` / `npm run test:e2e:store` | Browser suites (need Chrome; not part of `npm test`) |

## Test safety (non-negotiable)

- `tests/helpers/db.js` defaults `TEST_MONGO_URL` to `127.0.0.1:27017`, where a developer's real MongoDB may run.
  Always set `TEST_MONGO_URL` explicitly: a disposable server on a non-default port, or an unused port to skip the
  database suites. Never point tests at ports 27017 or 6379, and never stop a MongoDB/Redis service you did not start.
- A skipped Mongo/Redis suite is "not verified", never "passed". Report skip counts.
- Recipes for disposable servers, the release gate and browser suites: `.claude/skills/swift-test/SKILL.md`.

## Invariants that apply everywhere

- Run exactly one replica (Telegram long polling). Startup order is HTTP → MongoDB (indexes) → Redis → crons → update handlers → polling.
- MongoDB is the only authority for money; Redis holds locks, sessions and leases and is never trusted for balances.
- The admin service catalog (`AdminProduct`, read through `services/plans.js`) is the source of truth for checkout.
- Customer bot and storefront text is Persian (RTL); the `/panel` dashboard is English.
- The repository is public: never commit or print secrets, personal data, real card numbers or Telegram IDs.
- Area rules: `.claude/rules/money-paths.md`, `.claude/rules/security-privacy.md`, `.claude/rules/frontend.md`.

## Git safety

- The working tree usually contains the owner's uncommitted work. Stage explicit paths only (never `git add .` or
  `-A`), never revert, clean or reformat files you did not change, and commit or push only when asked.
- On `master`, create a branch before committing. Commit messages use Conventional Commits (`feat:`, `fix:`, `docs:`).
- `core.autocrlf` is on and files mix CRLF/LF: never rewrite line endings wholesale.
- The pre-commit hook (`.githooks/pre-commit`, enabled with `git config core.hooksPath .githooks`) runs the sensitive-data
  scan; never bypass it.

## Engineering context maintenance (inline, while you work)

This file, `.claude/rules/`, `.claude/skills/`, `.claude/context-map.json` and the docs above change together with
the code, in the same step, never as a separate pass at the end. Whenever an edit makes a statement in them false or
incomplete, fix that statement right away, while you still have the code open.

- **Before editing an area,** read its rules and docs (`node scripts/check-context.mjs --diff` names them for the files
  you are touching).
- **When you rename, add or remove** a script, env var, route, model field or index, status value, module, provider,
  deploy or CI file, grep `CLAUDE.md`, `.claude/`, `README.md` and `docs/` for it and update every hit immediately.
  Typical homes: npm scripts → the commands table here, `README.md`, `docs/testing.md`, `swift-test`; env vars →
  `docs/configuration.md`, `.env.example`; payment providers, webhooks, schemas → `docs/payments.md`, the money rule,
  the `swift-audit` inventory; admin routes → `docs/admin.md`; deploy/CI → `docs/deployment.md`, `swift-test`.
- **New modules that matter** get a glob in `.claude/context-map.json`; deleted or renamed paths are removed or renamed
  there in the same edit.
- **Verify before writing:** document behaviour you confirmed from code, configuration or a run, never intended or
  assumed behaviour. Record anything unverified as an open question. When code and docs disagree, investigate before
  choosing; if the code looks wrong, report it instead of documenting the bug as a rule.
- **Edit minimally:** each fact lives in the file that owns it (table above); remove false statements instead of adding
  caveats; keep unrelated text and the owner's uncommitted edits intact; never create a second skill or rule for an
  existing purpose. Skills update their own procedures when their "Keeping this skill current" triggers fire.
- **Before finishing,** run `npm run check:context`, grep for any old term you replaced, and end with the report below.
  Internal bug fixes, same-behaviour refactors and test-only changes usually need no update; say so in the report.
- **Context-only audit** (when asked to audit the context without touching app code): edit only `CLAUDE.md`,
  `.claude/**`, `README.md`, `docs/**`, `DEPLOYMENT_CHECKLIST.md`; run `npm run check:context -- --strict` and
  `node scripts/check-context.mjs --diff $(git log -1 --format=%H -- CLAUDE.md .claude)`, then re-check scripts,
  mounted routes, startup order and models against what the context says.

**Context maintenance report** (last section of the final message of a meaningful task):

```
Context maintenance
- Documentation impact: Yes/No
- Files updated: <file> (why) ... | none, because <reason>
- Validation: <commands run and results>
- Unresolved drift: <items or "none known">
- Automated checks: <ran / unavailable and why>
```

**What is automated and what is not.** A Stop hook in `.claude/settings.json` runs
`scripts/check-context.mjs --hook-stop` as a backstop: once per new change set (content hashes kept in
`.git/claude-context-state.json`; the first run only records a baseline) it blocks the stop when files in a
high-impact area changed or an edited context file has a broken reference. It never re-blocks while continuing from a
Stop hook, and on any internal error it lets the stop proceed. `npm test` includes `tests/unit/checkContext.test.js`,
which fails on broken references in the Claude context files. None of this can judge whether prose is still correct;
that judgement is yours, during the work. No scheduled or CI job runs these checks.

## Skills

| Skill | Use it when |
|---|---|
| `swift-code-review` | Reviewing a diff, branch or PR in this repo |
| `swift-audit` | Auditing trust boundaries, money paths, admin access, privacy |
| `swift-test` | Choosing and running the right tests safely, interpreting skips |

**Skill output.** Each of these skills writes its full report to a new file
`.claude/_generated/<skill>-<YYYY-MM-DD-HHMM>.md` (local time; add `-2`, `-3` if the name exists; create the folder if
needed) and then gives a short summary in chat with the file path. The folder is git-ignored: never stage, commit or
link its files from tracked docs. Every report starts with a header: skill, date and time, scope (branch, short `HEAD`,
and whether uncommitted changes were included), and the commands run with their results; then the skill's own report
sections. Cite sensitive values by file, line and category only, never the value.
