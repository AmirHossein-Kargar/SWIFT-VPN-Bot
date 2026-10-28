#!/usr/bin/env node
/**
 * Runs `node --test` over every tests/**\/*.test.js file.
 *
 * `node --test "tests/**\/*.test.js"` only expands globs on Node >= 21; Node 20 (our declared minimum) treats the quoted
 * pattern as a literal path and fails with "Could not find". Expanding the list here keeps one command for every supported
 * Node version. Extra CLI arguments are passed through to `node --test` (e.g. --test-name-pattern).
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function findTestFiles(root = "tests") {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(full.replaceAll("\\", "/"));
    }
  };
  walk(root);
  return files.sort();
}

export function runTests(extraArgs = [], env = process.env) {
  const files = findTestFiles();
  if (!files.length) throw new Error("no tests/**/*.test.js files found");
  return spawn(process.execPath, ["--test", ...extraArgs, ...files], { stdio: ["ignore", "pipe", "inherit"], env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const child = runTests(process.argv.slice(2));
  child.stdout.pipe(process.stdout);
  child.on("close", (code) => process.exit(code ?? 1));
}
