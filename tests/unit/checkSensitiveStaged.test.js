/**
 * Regression tests for the staged-diff mode of scripts/check-sensitive.mjs (what the
 * pre-commit hook runs). Two bypasses were confirmed and fixed:
 *
 *   1. an added line whose text starts with "++" (shown in a diff as "+++ ...") was
 *      mistaken for a file header and never scanned;
 *   2. added lines of a renamed-and-edited file (diff status R) were never scanned.
 *
 * Everything runs in throwaway Git repositories under the OS temp directory, with the
 * user's Git configuration isolated, so no file of this repository is ever staged.
 * The fake card number is generated at run time (no sensitive-looking literal lives in
 * this file) and is never printed: assertions only name files, lines and categories.
 *
 * CHECK_SENSITIVE_SCANNER can point at another copy of the scanner (used to prove these
 * tests fail against the pre-fix version).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCANNER = process.env.CHECK_SENSITIVE_SCANNER || join(ROOT, "scripts", "check-sensitive.mjs");
const { luhn, parseStagedDiff } = await import(pathToFileURL(SCANNER).href);

/** A Luhn-valid 16-digit number that is not on the scanner's allowlist, built at run time. */
function makeCard() {
  const prefix = ["4", "0", "0", "0", "0", "5", "6", "6", "5", "5", "6", "6", "5", "5", "5"].join("");
  for (let check = 0; check < 10; check += 1) if (luhn(prefix + check)) return prefix + check;
  throw new Error("no check digit");
}
const CARD = makeCard();

const sandbox = mkdtempSync(join(tmpdir(), "swift-scan-"));
const emptyGlobalConfig = join(sandbox, "empty.gitconfig");
writeFileSync(emptyGlobalConfig, "");
after(() => { try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort, temp only */ } });

function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_") && key !== "NODE_OPTIONS") env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyGlobalConfig, ...extra };
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, env: childEnv(), encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args[0]} failed`);
  return result.stdout;
}

let counter = 0;
function makeRepo() {
  const dir = join(sandbox, `repo-${++counter}`);
  mkdirSync(dir);
  git(dir, "init", "-q");
  return dir;
}

function write(dir, relative, lines) {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function scan(cwd, args = ["--staged"], extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCANNER, ...args], { cwd, env: childEnv(extraEnv), encoding: "utf8" });
  return { status: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
}

const findings = (out) => (out.match(/CARD_NUMBER \[/g) || []).length;
const benign = (count, label = "line") => Array.from({ length: count }, (_, index) => `${label} ${index + 1} of the document`);

function commitBase(dir, relative, lines) {
  write(dir, relative, lines);
  git(dir, "add", "--", relative);
  git(dir, "commit", "-q", "--no-verify", "-m", "base");
}

describe("staged scan: lines starting with '+' or '++' (bypass 1)", () => {
  test("every added line is scanned, with the right file and line number, whatever it starts with", () => {
    const dir = makeRepo();
    write(dir, "plus.txt", [`+ ${CARD}`, `++ ${CARD}`, `+++ ${CARD}`, "clean line"]);
    git(dir, "add", "--", "plus.txt");
    const { status, out } = scan(dir);
    assert.equal(status, 1);
    assert.equal(findings(out), 3);
    for (const line of [1, 2, 3]) assert.match(out, new RegExp(`plus\\.txt:${line}\\s+CARD_NUMBER`));
    assert.ok(!out.includes(CARD), "the value must never be printed");
  });

  test("header-looking content cannot rename the file in findings or hide a later finding", () => {
    const dir = makeRepo();
    write(dir, "hdr.txt", ["++ b/other.txt", "+++ b/elsewhere.txt", `value ${CARD}`]);
    git(dir, "add", "--", "hdr.txt");
    const { status, out } = scan(dir);
    assert.equal(status, 1);
    assert.match(out, /hdr\.txt:3\s+CARD_NUMBER/);
    assert.ok(!/other\.txt|elsewhere\.txt/.test(out), "findings must be attributed to the real file");
  });

  test("a clean file of such lines is not a false positive", () => {
    const dir = makeRepo();
    write(dir, "ok.txt", ["+ plus", "++ plusplus", "+++ plusplusplus", "++ b/looks/like/a/header"]);
    git(dir, "add", "--", "ok.txt");
    const { status, out } = scan(dir);
    assert.equal(status, 0);
    assert.match(out, /no sensitive values found/);
  });
});

describe("staged scan: renamed and edited files (bypass 2)", () => {
  const guide = benign(30, "guide");

  test("added lines in a renamed-and-edited file are scanned (git reports it as R)", () => {
    const dir = makeRepo();
    commitBase(dir, "docs/guide.md", guide);
    git(dir, "mv", "docs/guide.md", "docs/guide-moved.md");
    write(dir, "docs/guide-moved.md", [...guide, `extra ${CARD}`]);
    git(dir, "add", "--", "docs/guide-moved.md");
    assert.match(git(dir, "diff", "--cached", "--name-status"), /^R\d+\tdocs\/guide\.md\tdocs\/guide-moved\.md/m, "precondition: git must report a rename");
    const { status, out } = scan(dir);
    assert.equal(status, 1);
    assert.match(out, /docs\/guide-moved\.md:31\s+CARD_NUMBER/);
    assert.equal(findings(out), 1);
    assert.ok(!out.includes(CARD));
  });

  test("a pure rename and a rename with a harmless edit pass", () => {
    const dir = makeRepo();
    commitBase(dir, "a.md", guide);
    git(dir, "mv", "a.md", "b.md");
    assert.equal(scan(dir).status, 0, "pure rename");
    write(dir, "b.md", [...guide, "one more harmless line"]);
    git(dir, "add", "--", "b.md");
    assert.match(git(dir, "diff", "--cached", "--name-status"), /^R\d+/m);
    assert.equal(scan(dir).status, 0, "rename with a harmless edit");
  });

  test("the same line in an ordinary new file is still found (control)", () => {
    const dir = makeRepo();
    commitBase(dir, "base.md", guide);
    write(dir, "plain-new.js", [`const c = "${CARD}";`]);
    git(dir, "add", "--", "plain-new.js");
    const { status, out } = scan(dir);
    assert.equal(status, 1);
    assert.match(out, /plain-new\.js:1\s+CARD_NUMBER/);
  });
});

describe("staged scan: behaviour that must not change", () => {
  test("nothing staged passes; deleting a file that already contained a value does not count as adding it", () => {
    const dir = makeRepo();
    assert.equal(scan(dir).status, 0, "empty repository");
    commitBase(dir, "old.txt", [`legacy ${CARD}`]);
    assert.equal(scan(dir).status, 0, "nothing staged");
    git(dir, "rm", "-q", "--", "old.txt");
    assert.equal(scan(dir).status, 0, "a deletion adds nothing");
  });

  test("unusual file names (spaces, Persian letters, brackets, parentheses, leading plus signs) are scanned, not skipped", () => {
    const dir = makeRepo();
    const names = ["app (x)/[id] پرونده.txt", "++ weird name.txt", "with space.txt"];
    for (const name of names) { write(dir, name, [`value ${CARD}`]); git(dir, "add", "--", name); }
    const { status, out } = scan(dir);
    assert.equal(status, 1);
    assert.equal(findings(out), names.length);
    assert.ok(!out.includes(CARD));
  });

  test("it fails closed when git cannot answer (not a repository): non-zero exit, no 'clean' message", () => {
    const dir = join(sandbox, "not-a-repo");
    mkdirSync(dir);
    const { status, out } = scan(dir, ["--staged"], { GIT_CEILING_DIRECTORIES: sandbox });
    assert.notEqual(status, 0);
    assert.ok(!/no sensitive values found/.test(out));
  });

  test("file mode (explicit paths) still reports findings and clean files", () => {
    const dir = makeRepo();
    write(dir, "f.txt", [`++ ${CARD}`]);
    write(dir, "g.txt", ["nothing here"]);
    assert.equal(scan(dir, ["f.txt"]).status, 1);
    assert.equal(scan(dir, ["g.txt"]).status, 0);
  });
});

describe("parseStagedDiff (pure parser)", () => {
  const DIFF = [
    "diff --git a/one.txt b/one.txt",
    "index 111..222 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1,0 +2,4 @@",
    "+++ looks like a header",
    "++ also",
    "+plain",
    "+diff --git a/x b/x",
    "@@ -9 +11 @@",
    "-old",
    "+new",
    "diff --git a/old.txt b/new.txt",
    "similarity index 90%",
    "rename from old.txt",
    "rename to new.txt",
    "index 333..444 100644",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -5 +5 @@",
    "-x",
    "+y",
    "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed",
    "",
  ].join("\n");

  test("yields only added lines, with file names and line numbers from the real headers", () => {
    assert.deepEqual([...parseStagedDiff(DIFF)], [
      { file: "one.txt", lineNo: 2, text: "++ looks like a header" },
      { file: "one.txt", lineNo: 3, text: "+ also" },
      { file: "one.txt", lineNo: 4, text: "plain" },
      { file: "one.txt", lineNo: 5, text: "diff --git a/x b/x" },
      { file: "one.txt", lineNo: 11, text: "new" },
      { file: "new.txt", lineNo: 5, text: "y" },
    ]);
  });

  test("an empty diff yields nothing", () => {
    assert.deepEqual([...parseStagedDiff("")], []);
  });
});
