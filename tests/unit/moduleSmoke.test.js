/**
 * Module smoke test — every production module must load.
 *
 * Import errors (wrong relative paths, missing named exports, circular
 * imports that break) are invisible to `node --check` and to any test suite
 * whose exercising integration tests skip when MongoDB is unavailable. Two
 * such defects (a wrong relative import in the buy-service menu and a named
 * import of a default export in the service-details view) shipped past the
 * full suite exactly that way; this test exists so it cannot happen again.
 *
 * Modules that intentionally start background work at import (the bot entry
 * point, the Express server bootstrap) are excluded; handlers/services are
 * imported with no environment configured, which is itself part of the check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SKIP = new Set([
  "bot.js", // entry point: starts polling/cron
  "scripts/preflight.js",
]);

const SKIP_DIRS = [/^tests\//, /^node_modules\//, /^web\/public\//, /^\.git\//, /^scripts\//];

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".arena") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

test("every production module imports cleanly", async () => {
  const files = walk(root)
    .map((full) => relative(root, full))
    .filter((relPath) => !SKIP.has(relPath) && !SKIP_DIRS.some((pattern) => pattern.test(relPath + "/") || pattern.test(relPath)));
  assert.ok(files.length >= 60, `expected a full module tree, found ${files.length}`);

  const failures = [];
  for (const relPath of files) {
    try {
      await import(pathToFileURL(join(root, relPath)).href);
    } catch (error) {
      failures.push(`${relPath}: ${error?.message || error}`);
    }
  }
  assert.deepEqual(failures, [], `modules failed to load:\n${failures.join("\n")}`);
});
