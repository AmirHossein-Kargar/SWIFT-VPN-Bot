/**
 * How the admin System Health page presents service status
 * (admin-panel/lib/health-status.ts). The contract: only the three statuses the
 * API reports as "healthy", "degraded" or "down" get a matching treatment;
 * everything else (missing, null, a future status, wrong case) is "unknown" and
 * must never be shown as healthy or animated like a heartbeat. The browser-level
 * rendering is covered by tests/e2e/nextPanel.e2e.mjs.
 *
 * The file is TypeScript and the project supports Node versions that cannot
 * import .ts, so it is transpiled in memory with the project's `typescript`.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function loadTypeScriptModule(relativePath) {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const moduleRecord = { exports: {} };
  new Function("exports", "require", "module", "__filename", outputText)(moduleRecord.exports, createRequire(file), moduleRecord, file);
  return moduleRecord.exports;
}

const { presentHealth, normalizeHealthStatus, ECG_BEAT_PATH, ECG_FLAT_PATH } = loadTypeScriptModule("../../admin-panel/lib/health-status.ts");

describe("system health presentation", () => {
  test("each reported status maps to its own trace and tone", () => {
    assert.deepEqual(
      ["healthy", "degraded", "down", "unknown"].map((status) => { const view = presentHealth(status); return [view.status, view.motion, view.tone]; }),
      [["healthy", "beat", "text-success"], ["degraded", "irregular", "text-warning"], ["down", "flatline", "text-destructive"], ["unknown", "idle", "text-muted-foreground"]],
    );
  });

  test("only healthy and degraded are animated; down and unknown are static", () => {
    const animated = ["healthy", "degraded", "down", "unknown"].filter((status) => ["beat", "irregular"].includes(presentHealth(status).motion));
    assert.deepEqual(animated, ["healthy", "degraded"]);
  });

  test("anything the API did not report as healthy/degraded/down is unknown, never healthy", () => {
    for (const value of [undefined, null, "", "Healthy", "HEALTHY", "ok", "up", "something-new", 1, true, {}, []]) {
      assert.equal(normalizeHealthStatus(value), "unknown", String(JSON.stringify(value)));
      const view = presentHealth(value);
      assert.equal(view.motion, "idle");
      assert.notEqual(view.tone, "text-success");
    }
  });

  test("every state has a text label and a plain-language description, so colour and motion are never the only signal", () => {
    for (const status of ["healthy", "degraded", "down", "unknown"]) {
      const view = presentHealth(status);
      assert.match(view.label, /^[A-Z][a-z]+$/);
      assert.ok(view.description.toLowerCase().startsWith(view.label.toLowerCase()), view.description);
    }
    assert.match(presentHealth("down").description, /failed/);
    assert.match(presentHealth("unknown").description, /no verified result/);
  });

  test("the failure trace is a straight baseline, the beat has a spike", () => {
    assert.match(ECG_FLAT_PATH, /^M0 14 H120$/);
    assert.notEqual(ECG_BEAT_PATH, ECG_FLAT_PATH);
    assert.ok(ECG_BEAT_PATH.includes("L53 2"), "QRS spike present");
  });
});
