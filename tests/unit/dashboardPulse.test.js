/** What the dashboard may claim about its own figures. The label is the honest part, so it must not outlive the data. */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function loadTypeScriptModule(relativePath) {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const moduleRecord = { exports: {} };
  new Function("exports", "require", "module", "__filename", outputText)(moduleRecord.exports, createRequire(file), moduleRecord, file);
  return moduleRecord.exports;
}

const { pulseFreshness } = loadTypeScriptModule("../../admin-panel/lib/dashboard-pulse.ts");
const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (seconds) => new Date(NOW - seconds * 1000).toISOString();
const read = (seconds, flags = {}) => pulseFreshness({ generatedAt: at(seconds), now: NOW, failed: false, hidden: false, pollMs: 30_000, ...flags });

describe("pulseFreshness", () => {
  test("recent data with a working connection is live", () => {
    assert.equal(read(2).state, "live");
    assert.match(read(2).label, /just now/);
    assert.match(read(20).label, /20 s ago/);
  });

  test("two missed polls and it stops saying live, whatever the numbers look like", () => {
    assert.equal(read(74).state, "live");
    assert.equal(read(80).state, "stale");
    assert.doesNotMatch(read(80).label, /live/i);
  });

  test("a failed refresh is reported at once, with how old the figures are", () => {
    const failed = read(5, { failed: true });
    assert.equal(failed.state, "failed");
    assert.match(failed.label, /Not updating/);
    assert.match(read(600, { failed: true }).label, /10 min ago/);
  });

  test("a hidden tab says it is paused rather than failing", () => {
    assert.equal(read(600, { hidden: true }).state, "paused");
  });
});
