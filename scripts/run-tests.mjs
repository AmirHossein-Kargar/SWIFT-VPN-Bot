#!/usr/bin/env node
/**
 * Runs `node --test` over every tests/**\/*.test.js file.
 *
 * `node --test "tests/**\/*.test.js"` only expands globs on Node >= 21; Node 20 (our declared minimum) treats the quoted
 * pattern as a literal path and fails with "Could not find". Expanding the list here keeps one command for every supported
 * Node version. Extra CLI arguments are passed through to `node --test` (e.g. --test-name-pattern).
 *
 * Test files run as separate workers and almost all wall time is spent waiting on I/O (MongoDB/Redis round trips, HTTP
 * servers on loopback, mongoose connect retries), not CPU, so Node's own default concurrency
 * (`os.availableParallelism() - 1`) leaves most of that waiting unoverlapped. Unless the caller already passes
 * --test-concurrency (or --test-only / --test-name-pattern narrow the run to a handful of files), default to a higher
 * value so more files' I/O waits overlap; TEST_CONCURRENCY overrides the computed default.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
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

/** Default --test-concurrency: I/O-bound test files benefit from running well beyond the CPU count. */
export function defaultConcurrency(env = process.env) {
  if (env.TEST_CONCURRENCY) return Number(env.TEST_CONCURRENCY);
  return Math.max(8, availableParallelism() * 4);
}

export function runTests(extraArgs = [], env = process.env) {
  const files = findTestFiles();
  if (!files.length) throw new Error("no tests/**/*.test.js files found");
  const hasConcurrencyArg = extraArgs.some(
    (arg) => arg === "--test-concurrency" || arg.startsWith("--test-concurrency=")
  );
  const concurrencyArgs = hasConcurrencyArg ? [] : [`--test-concurrency=${defaultConcurrency(env)}`];
  return spawn(process.execPath, ["--test", ...concurrencyArgs, ...extraArgs, ...files], {
    stdio: ["ignore", "pipe", "inherit"],
    env,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const child = runTests(process.argv.slice(2));
  child.stdout.pipe(process.stdout);
  child.on("close", (code) => process.exit(code ?? 1));
}
