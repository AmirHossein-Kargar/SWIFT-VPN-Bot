---
name: swift-test
description: Choose and run the right SWIFT VPN Bot tests safely (never against a real MongoDB/Redis), read skip counts honestly, and run the release gate or browser suites when needed. Use before claiming any change works, and whenever test scripts, helpers or prerequisites change.
---

# Test and verify

`docs/testing.md` is the reference for what each suite covers. This skill is the procedure.

## 1. Pick the scope

- Map the change to suites with `docs/testing.md` ("What is covered") and `node scripts/check-context.mjs --diff`.
- One file: `node --test tests/unit/<name>.test.js`. By name: `npm test -- --test-name-pattern="<regex>"`
  (`scripts/run-tests.mjs` passes extra arguments to `node --test`).
- Money, catalog, admin mutation or persistence changes need the Mongo-backed suites (step 3). Unit tests alone do not
  verify them.

## 2. Safe default run (no database)

`tests/helpers/db.js` falls back to `127.0.0.1:27017`, where a real MongoDB may be running. Point it at a port with
nothing on it so the database suites skip instead of touching it, and leave `REDIS_URL` unset:

```bash
TEST_MONGO_URL=mongodb://127.0.0.1:27999/swiftvpn_test REDIS_URL= npm test
```

```powershell
$env:TEST_MONGO_URL = 'mongodb://127.0.0.1:27999/swiftvpn_test'; Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue; npm test
```

Read the summary: `ℹ skipped N` means N tests did **not** run. Every Mongo skip reason names MongoDB.

## 3. Full verification (disposable MongoDB + Redis)

Start throwaway servers on non-default loopback ports (for example mongod `--port 27100 --bind_ip 127.0.0.1` with a
scratch `--dbpath`, and redis-server `--port 27200 --bind 127.0.0.1 --save ""`), then:

```bash
TEST_MONGO_URL=mongodb://127.0.0.1:27100/swiftvpn_test REDIS_URL=redis://127.0.0.1:27200 npm run test:release
```

`scripts/test-release.mjs` refuses default ports, non-loopback hosts, a MongoDB holding non-test databases and a
non-empty Redis, then fails on any skip. Empty Redis between runs (`redis-cli -p 27200 flushall`). Stop only the
processes you started, by PID or port; never stop a system MongoDB/Redis service.

`scripts/run-tests.mjs` defaults `--test-concurrency` well above the CPU count (see `docs/testing.md` "Parallelism"),
so many test files open connections to the disposable MongoDB/Redis at once; if a run against real servers is flaky,
rerun with `TEST_CONCURRENCY=1` to isolate a concurrency-sensitive test from a genuinely broken one before reporting it.

## 4. Builds and browser suites

- `npm run build` checks both Next apps. Its `.next` output is git-ignored and skipped by
  `tests/unit/moduleSmoke.test.js`; leave an existing `.next` alone unless you created it.
- `npm run test:e2e` currently stalls on the legacy dashboard (see `docs/testing.md`); use `nextPanel.e2e.mjs` for admin.
- `npm run test:e2e` (admin, fixture backend) and `npm run test:e2e:store` (storefront under the real CSP) need Chrome
  (`CHROME_PATH`); the storefront suite needs a storefront build and exits 0 with `SKIP` without one. axe checks run only
  when `axe-core` resolves (`AXE_PATH`).
- `node tests/e2e/nextPanel.e2e.mjs` is the `/panel` suite (needs `npx next build admin-panel`; not an npm script): real
  session and CSRF middleware, delayed and failing API answers, and the navigation-hang regressions. `E2E_ONLY=<regex>`
  runs matching steps. A navigation bug here passed one-file runs and failed with a warm server, so repeat a flaky
  sequence and capture state on failure; do not add a sleep.
- Set `SHOTS` to a scratch folder for the storefront suite: without it, it overwrites the tracked `store-*.png` in the
  repo root. `tsc` can rewrite the untracked `admin-panel/tsconfig.tsbuildinfo`. Check `git status` before and after,
  and restore anything you changed that the owner did not ask for.

## 5. Report

State exactly what ran: command, pass/fail/skip counts, which suites skipped and why, and what remains unverified
(for example "Mongo-backed purchaseFlow not run: no disposable MongoDB"). Never call a run with skips a full pass.
A single failure that passes when rerun alone (for example a time-dependent case) is reported as flaky, not ignored.

Write the report to `.claude/_generated/swift-test-<YYYY-MM-DD-HHMM>.md` using the format under "Skill output" in
`CLAUDE.md` (include the failing test names and the relevant assertion output, not the whole log), then summarize in
chat with the file path.

## Keeping this skill current

Re-check this file whenever any of these change, and update it plus `docs/testing.md` in the same task:

- `package.json` test scripts, `scripts/run-tests.mjs`, `scripts/test-release.mjs`;
- `tests/helpers/db.js`, `tests/helpers/redisRequirement.js` or other fixtures that decide skip/require behaviour;
- browser-suite prerequisites (`tests/e2e/*`), the Node version in `engines`;
- CI: there is no `.github/workflows` today. If one appears, document what it runs and which suites it skips here.

`node scripts/check-context.mjs --diff` flags these files (areas `test-infra`, `package-scripts`, `ci-deploy-config`).
Edit this skill rather than creating a second testing skill.
