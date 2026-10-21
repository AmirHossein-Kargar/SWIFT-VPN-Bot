#!/usr/bin/env node
/**
 * Builds the public storefront (storefront/, a Next.js Pages Router static
 * export) and installs it into web/public, which Express already serves:
 *
 *   storefront/out/index.html  → web/public/storefront.html   (served at "/")
 *   storefront/out/_next/**    → web/public/_next/**           (+ .br/.gz copies)
 *
 * It refuses to install a build that contains executable inline scripts or
 * inline event handlers, because the storefront CSP is `script-src 'self'`
 * (web/spa.js STORE_CSP) and such a page would render blank in the browser.
 * The storefront's own build cache is deleted afterwards so no build output
 * outside web/public ends up in the repository tree.
 *
 * If this build has not run, web/spa.js falls back to the static
 * web/public/store.html, so the site stays up either way.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "storefront");
const outDir = join(appDir, "out");
const publicDir = join(root, "web", "public");
const nextBin = createRequire(join(root, "package.json")).resolve("next/dist/bin/next");

function cleanBuildOutput() {
  rmSync(join(appDir, ".next"), { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  rmSync(join(appDir, "tsconfig.tsbuildinfo"), { force: true });
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** Throws unless the HTML can run under `script-src 'self'`. Exported for tests via the CLI-free helper below. */
export function assertCspCompatible(html, label = "index.html") {
  const problems = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1] ?? "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']?application\/(?:ld\+)?json/i.test(attrs)) continue; // data block, never executed
    problems.push(`executable inline <script>: ${(match[2] ?? "").trim().slice(0, 60)}`);
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, ""))) problems.push("inline event-handler attribute (onclick=…)");
  if (/javascript:/i.test(html)) problems.push("javascript: URL");
  if (!/<html[^>]*\blang="fa"[^>]*\bdir="rtl"/i.test(html)) problems.push('missing <html lang="fa" dir="rtl">');
  if (!/<div id="__next"/.test(html)) problems.push("missing #__next root");
  if (problems.length) throw new Error(`${label} is not CSP-compatible:\n  - ${problems.join("\n  - ")}`);
}

function precompress(dir) {
  let count = 0;
  for (const file of walk(dir)) {
    if (!/\.(?:js|css)$/.test(file)) continue;
    const data = readFileSync(file);
    if (data.length < 1024) continue;
    writeFileSync(`${file}.br`, brotliCompressSync(data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
    writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
    count += 1;
  }
  return count;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cleanBuildOutput();
  const build = spawnSync(process.execPath, [nextBin, "build", appDir], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (build.status !== 0) {
    cleanBuildOutput();
    console.error("Storefront build failed; web/public was left untouched (the static fallback page keeps serving).");
    process.exit(build.status ?? 1);
  }

  try {
    const html = readFileSync(join(outDir, "index.html"), "utf8");
    assertCspCompatible(html);
    const staging = join(publicDir, "_next.staging");
    rmSync(staging, { recursive: true, force: true });
    cpSync(join(outDir, "_next"), staging, { recursive: true });
    const compressed = precompress(staging);
    rmSync(join(publicDir, "_next"), { recursive: true, force: true });
    renameSync(staging, join(publicDir, "_next"));
    writeFileSync(join(publicDir, "storefront.html"), html);
    const files = walk(join(publicDir, "_next")).filter((file) => !/\.(?:br|gz)$/.test(file));
    const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
    console.log(`Storefront installed: storefront.html + ${files.length} assets (${(bytes / 1024).toFixed(0)} kB raw), ${compressed} pre-compressed (.br/.gz).`);
  } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  } finally {
    cleanBuildOutput();
  }
}
