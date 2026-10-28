import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const {
  REPO_ROOT, globToRegExp, extractReferences, diffManifest, classifyChanges, decideStop, loadMap,
  checkReferences, checkSkills, checkMap, runStopHook,
} = await import("../../scripts/check-context.mjs");

const map = loadMap();
const areaIds = (result) => result.areas.map((area) => area.id).sort();

describe("check-context: the repository's own context is consistent", () => {
  test("no broken path, npm-script or link reference in CLAUDE.md and .claude/", () => {
    const errors = checkReferences(REPO_ROOT).filter((finding) => finding.severity === "error");
    assert.deepEqual(errors, []);
  });

  test("every skill has matching frontmatter and every impact-map glob and review target exists", () => {
    assert.deepEqual(checkSkills(REPO_ROOT), []);
    assert.deepEqual(checkMap(REPO_ROOT), []);
  });
});

describe("check-context: reference extraction", () => {
  test("finds repo paths, npm scripts and relative links, and ignores routes, placeholders and package names", () => {
    const refs = extractReferences([
      "Run `npm run check:context` and `npm test`; see `docs/payments.md:12` and [ops](docs/operations.md#recovery).",
      "Not paths: `/api/admin`, `<WEBHOOK_BASE_URL>/panel`, `@hookform/resolvers`, `PRODUCT_CREATED/UPDATED`, `.js`, [x](https://example.com).",
    ].join("\n"));
    assert.deepEqual(refs.paths.map((ref) => ref.value), ["docs/payments.md"]);
    assert.deepEqual(refs.scripts.map((ref) => ref.value), ["check:context", "test"]);
    assert.deepEqual(refs.links.map((ref) => ref.value), ["docs/operations.md"]);
  });

  test("globs support **, * and {a,b}", () => {
    assert.ok(globToRegExp("services/**").test("services/nowpayments/ipnHandler.js"));
    assert.ok(globToRegExp("tests/**/*.test.js").test("tests/unit/a.test.js"));
    assert.ok(!globToRegExp("docs/*.md").test("docs/sub/a.md"));
    assert.ok(globToRegExp("models/{User,AdminProduct}.js").test("models/AdminProduct.js"));
  });
});

describe("check-context: change-impact classification (representative changes)", () => {
  test("a package script change is high impact and names the docs that list commands", () => {
    const manifest = diffManifest({ scripts: { test: "a" } }, { scripts: { test: "a", lint: "b" } });
    assert.deepEqual(manifest, ["script added: lint"]);
    const result = classifyChanges(["package.json"], map, { manifest });
    const area = result.areas.find((entry) => entry.id === "package-scripts");
    assert.equal(area.impact, "high");
    assert.ok(area.review.includes("CLAUDE.md") && area.review.includes(".claude/skills/swift-test/SKILL.md"));
  });

  test("a dependency-only package.json change is downgraded to low impact", () => {
    const manifest = diffManifest({ scripts: { test: "a" }, dependencies: { x: "1" } }, { scripts: { test: "a" }, dependencies: { x: "2" } });
    assert.deepEqual(manifest, []);
    assert.equal(classifyChanges(["package.json"], map, { manifest }).areas[0].impact, "low");
  });

  test("a critical money-path module maps to the payments docs, the money rule and the audit skill", () => {
    const result = classifyChanges(["services/nowpayments/ipnHandler.js"], map);
    assert.deepEqual(areaIds(result), ["money-paths"]);
    const review = result.areas[0].review;
    for (const target of ["docs/payments.md", ".claude/rules/money-paths.md", ".claude/skills/swift-audit/SKILL.md"]) {
      assert.ok(review.includes(target), target);
    }
  });

  test("a model change hits persistence and its domain area", () => {
    assert.deepEqual(areaIds(classifyChanges(["models/SupportTicket.js"], map)), ["persistence", "support"]);
  });

  test("test-only edits and stray files have no high-impact area", () => {
    const result = classifyChanges(["tests/unit/healthStatus.test.js", "store-dark-1280.png"], map);
    assert.deepEqual(result.areas.map((area) => [area.id, area.impact]), [["tests", "low"]]);
    assert.deepEqual(result.unmapped, ["store-dark-1280.png"]);
  });

  test("context files are reported separately for reference validation", () => {
    const result = classifyChanges(["CLAUDE.md", ".claude/rules/money-paths.md"], map);
    assert.deepEqual(result.contextFiles, ["CLAUDE.md", ".claude/rules/money-paths.md"]);
    assert.deepEqual(result.areas, []);
  });
});

describe("check-context: Stop-hook decision", () => {
  test("first run records a baseline and never blocks", () => {
    assert.equal(decideStop({ previous: null, current: { "services/plans.js": "a" }, map }).block, false);
  });

  test("blocks once for a new high-impact change, then stays quiet for the same change set", () => {
    const first = decideStop({ previous: {}, current: { "services/plans.js": "a" }, map });
    assert.equal(first.block, true);
    assert.match(first.reason, /catalog: services\/plans\.js/);
    assert.match(first.reason, /Engineering context maintenance/);
    assert.equal(decideStop({ previous: { "services/plans.js": "a" }, current: { "services/plans.js": "a" }, map }).block, false);
  });

  test("low-impact changes do not block; a broken reference in an edited context file does", () => {
    assert.equal(decideStop({ previous: {}, current: { "tests/unit/x.test.js": "a" }, map }).block, false);
    const broken = decideStop({
      previous: {},
      current: { "CLAUDE.md": "b" },
      map,
      refErrors: () => [{ file: "CLAUDE.md", line: 3, value: "docs/gone.md", detail: "does not exist" }],
    });
    assert.equal(broken.block, true);
    assert.match(broken.reason, /broken reference CLAUDE\.md:3 `docs\/gone\.md`/);
  });
});

describe("check-context: hook end to end in a throwaway git repository", () => {
  let repo;
  const write = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "check-context-"));
    git("init", "-q");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    copyFileSync(join(REPO_ROOT, ".claude/context-map.json"), join(repo, ".claude/context-map.json"));
    write("package.json", JSON.stringify({ scripts: { test: "node --test" }, dependencies: { a: "1" } }));
    write("CLAUDE.md", "Run `npm test`. See `docs/payments.md`.\n");
    write("docs/payments.md", "# Payments\n");
    write("services/nowpayments/ipnHandler.js", "export const x = 1;\n");
    write("tests/unit/a.test.js", "// test\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  test("baseline, low-impact edit, critical edit, repeat, script change, stop_hook_active, broken reference", () => {
    write("tests/unit/a.test.js", "// changed before the first run\n");
    assert.equal(runStopHook(repo, {}), null, "first run only records a baseline");

    write("tests/unit/a.test.js", "// test-only edit\n");
    assert.equal(runStopHook(repo, {}), null, "test-only edit is low impact");

    write("services/nowpayments/ipnHandler.js", "export const x = 2;\n");
    const critical = runStopHook(repo, {});
    assert.equal(critical?.decision, "block");
    assert.match(critical.reason, /money-paths: services\/nowpayments\/ipnHandler\.js/);
    assert.equal(runStopHook(repo, {}), null, "same change set is not reported twice");

    write("package.json", JSON.stringify({ scripts: { test: "node --test" }, dependencies: { a: "2" } }));
    assert.equal(runStopHook(repo, {}), null, "dependency-only manifest change");
    write("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." }, dependencies: { a: "2" } }));
    assert.match(runStopHook(repo, {})?.reason ?? "", /package-scripts: package\.json \[script added: lint\]/);

    write("services/nowpayments/ipnHandler.js", "export const x = 3;\n");
    assert.equal(runStopHook(repo, { stop_hook_active: true }), null, "never re-blocks while continuing from a Stop hook");

    write("CLAUDE.md", "Run `npm run missing-script`. See `docs/gone.md`.\n");
    const broken = runStopHook(repo, {});
    assert.match(broken?.reason ?? "", /broken reference CLAUDE\.md:1 `missing-script`/);
    assert.match(broken.reason, /broken reference CLAUDE\.md:1 `docs\/gone\.md`/);
  });
});
