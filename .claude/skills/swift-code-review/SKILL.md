---
name: swift-code-review
description: Review a diff, branch or PR of the SWIFT VPN Bot against this repo's invariants (money paths, admin security, CSP, Persian UI, test coverage, documentation impact). Use for any code review in this repository; it complements the generic /code-review.
---

# Review a change

Findings must be real defects or real risks with a concrete failure scenario. No style nits.

## 1. Establish the change set

- Local work: `git diff HEAD --stat` plus `git ls-files --others --exclude-standard`. The tree often contains the
  owner's unrelated uncommitted work; ask which files are in scope if that is unclear.
- A branch: `git diff master...HEAD`. A PR: `gh pr diff <number>`.
- Run `node scripts/check-context.mjs --diff <base>` to list the impacted areas and the rules/docs to read.

## 2. Read the governing rules first

For every impacted area, read the listed `.claude/rules/*.md` and docs. Review against them, not against memory.

## 3. Checklist

- **Money** (`.claude/rules/money-paths.md`): conditional single-document updates, idempotency keys, exactly-once
  refunds, no replay of ambiguous provider results, verification before credit, recovery path for every new phase,
  Toman never divided by 10, Redis never authoritative.
- **Persistence**: schema or unique-index changes have a migration path and Mongo-backed tests; queries used by crons
  are indexed.
- **Admin and webhooks** (`.claude/rules/security-privacy.md`): new routes use the existing auth/CSRF/same-origin/audit
  middleware; webhook handlers fail closed; inputs validated (`services/admin/validation.js`); no secrets or payloads
  in logs or responses.
- **Startup/runtime**: startup order (HTTP, MongoDB, Redis, crons, update handlers, polling) and single-replica assumptions intact;
  shutdown stops what startup starts.
- **Frontend** (`.claude/rules/frontend.md`): no inline scripts in the storefront, `/panel` headers intact, Persian RTL
  text for customers, English for the admin panel.
- **Catalog**: plan data read through `services/plans.js`, never from the static fallback directly.
- **Tests**: new behaviour has tests at the right level; money changes have Mongo-backed tests; the review states which
  tests were run and which skipped (`.claude/skills/swift-test/SKILL.md`).
- **Privacy**: `node scripts/check-sensitive.mjs --staged` (or `--all`) is clean; fixtures follow `docs/privacy.md`.
- **Context impact**: docs, rules, skills and `.claude/context-map.json` updated where the change made them wrong, and
  nowhere else ("Engineering context maintenance" in `CLAUDE.md`).

## 4. Report

List findings most severe first, each with `file:line`, what breaks, and the concrete inputs or sequence that break it.
Then list what was not verified. If nothing survived scrutiny, say so plainly.

Write the report to `.claude/_generated/swift-code-review-<YYYY-MM-DD-HHMM>.md` using the format under "Skill output"
in `CLAUDE.md`, then summarize in chat with the file path.

## Keeping this skill current

- When a review uncovers a new invariant, convention or recurring bug class, add it to the rule file for that area
  (or create a new rule with a `paths:` scope) and add a one-line pointer to the checklist above. Keep the detail in
  the rule, not here.
- When an area is added to `.claude/context-map.json`, make sure the checklist covers it.
- If a checklist item names a file or function that no longer exists, fix the item in the same task;
  `npm run check:context` catches renamed files but not renamed concepts.
