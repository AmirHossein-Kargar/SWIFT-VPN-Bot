#!/usr/bin/env node
/**
 * Detects drift between the repository and its Claude Code engineering context (CLAUDE.md, .claude/**).
 *
 *   node scripts/check-context.mjs                 validate references (exit 1 on errors in the Claude context files)
 *   node scripts/check-context.mjs --strict        also fail on broken references in README.md / docs/*.md
 *   node scripts/check-context.mjs --diff [base]   map changed files (vs base, default HEAD, plus untracked) to the
 *                                                  context files that describe them
 *   node scripts/check-context.mjs --hook-stop     Claude Code Stop hook: reads the hook JSON on stdin and asks for an
 *                                                  impact assessment once per new change set (see .claude/settings.json)
 *
 * Deterministic only. It checks that documented file paths, npm scripts, markdown links, skills and the globs in
 * .claude/context-map.json exist, and maps changed files to the documents that should be re-read. It cannot tell
 * whether a sentence is still true; that judgement is made during the work (CLAUDE.md, Engineering context maintenance).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = ".claude/context-map.json";
const STATE_FILE = "claude-context-state.json";
const HASH_LIMIT_BYTES = 2 * 1024 * 1024;
const PATH_EXTENSIONS = /\.(?:m?js|cjs|tsx?|json|md|ya?ml|sh|css|html|txt)$/;
// Variables that the platform or tooling sets, not the operator.
const ENV_IGNORE = new Set(["NODE_ENV", "NODE_OPTIONS", "CI", "HOME", "PATH", "npm_lifecycle_event"]);

// ── Small utilities ──────────────────────────────────────────────────────────

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  return result.stdout;
}

const splitZ = (output) => output.split("\0").filter(Boolean);

/** Minimal glob → RegExp: `**`, `*`, `?` and `{a,b}`; matched against repo-relative POSIX paths. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const end = glob.indexOf("}", i);
      out += `(?:${glob.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
      i = end;
    } else out += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const matchesAny = (file, globs) => globs.some((glob) => globToRegExp(glob).test(file));

export function loadMap(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, MAP_PATH), "utf8"));
}

/** Tracked and untracked (not ignored) files that exist on disk. */
export function listRepoFiles(root = REPO_ROOT) {
  return splitZ(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .filter((file, index, all) => all.indexOf(file) === index && existsSync(join(root, file)));
}

const expand = (globs, files) => files.filter((file) => matchesAny(file, globs));

// ── Reference extraction and validation ─────────────────────────────────────

/** Pull checkable references out of a markdown document. Pure; exported for tests. */
export function extractReferences(text) {
  const refs = { paths: [], scripts: [], links: [] };
  text.split(/\r?\n/).forEach((lineText, index) => {
    const line = index + 1;
    for (const match of lineText.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1].trim().replace(/:\d+(?:-\d+)?$/, "").replace(/\/$/, "");
      if (!/^[\w.-][\w./*{},-]*$/.test(token)) continue; // placeholders, commands, URLs, routes, ~ paths, @scope/pkg
      if (!token.includes("/") && !PATH_EXTENSIONS.test(token)) continue;
      if (/^\d/.test(token) || token.includes("..") || !/[a-z]/.test(token)) continue; // numbers, CONSTANT/NAMES
      if (/^\.[a-z]+$/.test(token) && PATH_EXTENSIONS.test(token)) continue; // a bare extension such as `.js`
      refs.paths.push({ value: token, line });
    }
    for (const match of lineText.matchAll(/\bnpm run ([\w:.-]+)/g)) refs.scripts.push({ value: match[1], line });
    for (const match of lineText.matchAll(/\bnpm (test|start)\b/g)) refs.scripts.push({ value: match[1], line });
    for (const match of lineText.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (target && !/^(?:[a-z]+:|\/\/)/i.test(target)) refs.links.push({ value: target, line });
    }
  });
  return refs;
}

/**
 * A reference resolves when it exists from the repo root, is listed in the map's `mayBeAbsent`, or is a path relative to a
 * sub-project (`pages/index.tsx` inside docs about storefront/). Slash tokens without a file extension whose first
 * segment is not a top-level entry (`text/plain`, `owner/repo`) are not treated as repo paths at all.
 */
function pathExists(root, value, { repoFiles, generated, basenames, topLevel }) {
  const generatedHit = (candidate) => generated.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`) || posix.basename(prefix) === candidate);
  if (generatedHit(value)) return true;
  if (/[*?{]/.test(value)) {
    const direct = globToRegExp(value);
    const nested = globToRegExp(`**/${value}`);
    return repoFiles.some((file) => direct.test(file) || nested.test(file) || file.startsWith(`${value.replace(/\/?\*.*$/, "")}/`));
  }
  if (existsSync(join(root, value))) return true;
  if (!value.includes("/")) return basenames.has(value);
  if (!PATH_EXTENSIONS.test(value) && !topLevel.has(value.split("/")[0])) return true;
  return repoFiles.some((file) => file.endsWith(`/${value}`) || file.startsWith(`${value}/`) || file.includes(`/${value}/`));
}

/**
 * Validate every document in scope. Findings in the Claude context files are errors; findings in human docs are
 * warnings unless `strict`.
 */
export function checkReferences(root = REPO_ROOT, { strict = false, only } = {}) {
  const map = loadMap(root);
  const repoFiles = listRepoFiles(root);
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts || {};
  const ctx = {
    repoFiles,
    generated: map.mayBeAbsent || [],
    basenames: new Set(repoFiles.map((file) => posix.basename(file))),
    topLevel: new Set(repoFiles.map((file) => file.split("/")[0])),
  };
  const contextDocs = expand(map.contextFiles, repoFiles).filter((file) => file.endsWith(".md"));
  const humanDocs = expand(map.humanDocs, repoFiles);
  const findings = [];
  for (const [docs, severity] of [[contextDocs, "error"], [humanDocs, strict ? "error" : "warning"]]) {
    for (const doc of docs) {
      if (only && !only.includes(doc)) continue;
      const refs = extractReferences(readFileSync(join(root, doc), "utf8"));
      const add = (kind, ref, detail) => findings.push({ severity, file: doc, line: ref.line, kind, value: ref.value, detail });
      for (const ref of refs.paths) if (!pathExists(root, ref.value, ctx)) add("path", ref, "does not exist");
      for (const ref of refs.scripts) if (!(ref.value in scripts)) add("npm-script", ref, "is not in package.json scripts");
      for (const ref of refs.links) {
        const target = posix.normalize(posix.join(posix.dirname(doc), decodeURIComponent(ref.value)));
        if (!existsSync(join(root, target))) add("link", ref, `resolves to missing ${target}`);
      }
    }
  }
  return findings;
}

/** Skills must have frontmatter whose name matches the directory, plus a description. */
export function checkSkills(root = REPO_ROOT) {
  const dir = join(root, ".claude/skills");
  if (!existsSync(dir)) return [];
  const findings = [];
  for (const name of readdirSync(dir)) {
    const file = `.claude/skills/${name}/SKILL.md`;
    if (!statSync(join(dir, name)).isDirectory()) continue;
    if (!existsSync(join(root, file))) { findings.push({ severity: "error", file, line: 1, kind: "skill", value: name, detail: "SKILL.md is missing" }); continue; }
    const front = readFileSync(join(root, file), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const field = (key) => front?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
    if (field("name") !== name) findings.push({ severity: "error", file, line: 1, kind: "skill", value: name, detail: `frontmatter name is "${field("name") ?? ""}", expected "${name}"` });
    if (!field("description")) findings.push({ severity: "error", file, line: 1, kind: "skill", value: name, detail: "frontmatter description is missing" });
  }
  return findings;
}

/** Every glob in the impact map must still match a file (unless the area is `optional`) and every review target must exist. */
export function checkMap(root = REPO_ROOT, map = loadMap(root), repoFiles = listRepoFiles(root)) {
  const findings = [];
  for (const area of map.areas) {
    for (const glob of area.optional ? [] : area.globs) {
      if (!repoFiles.some((file) => globToRegExp(glob).test(file))) {
        findings.push({ severity: "error", file: MAP_PATH, line: 1, kind: "map-glob", value: glob, detail: `area "${area.id}" glob matches no file` });
      }
    }
    for (const target of area.review) {
      if (!existsSync(join(root, target))) findings.push({ severity: "error", file: MAP_PATH, line: 1, kind: "map-review", value: target, detail: `area "${area.id}" review target does not exist` });
    }
  }
  return findings;
}

/**
 * Heuristic: `process.env.NAME` read by production code but named nowhere in docs/configuration.md or .env.example.
 * Variables read through helpers in config/env.js are not seen, so a clean result is not proof of complete docs.
 */
export function checkEnvDocs(root = REPO_ROOT, repoFiles = listRepoFiles(root)) {
  const docsPath = ["docs/configuration.md", ".env.example"].filter((file) => existsSync(join(root, file)));
  const documented = docsPath.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
  const sources = repoFiles.filter((file) => /\.(?:m?js|ts)$/.test(file) && !/^(?:tests|scripts|admin-panel|storefront|web\/public|node_modules)\//.test(file));
  const seen = new Map();
  for (const file of sources) {
    readFileSync(join(root, file), "utf8").split(/\r?\n/).forEach((text, index) => {
      // `process.env.X`, an injected `env.X` / `env["X"]`, and names passed to config/env.js's firstSet([...]).
      const names = [
        ...[...text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]),
        ...[...text.matchAll(/\benv\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g)].map((m) => m[1]),
        ...[...text.matchAll(/firstSet\(\s*\[([^\]]+)\]/g)].flatMap((m) => [...m[1].matchAll(/["']([A-Z][A-Z0-9_]{2,})["']/g)].map((q) => q[1])),
      ];
      for (const name of names) if (!seen.has(name)) seen.set(name, { file, line: index + 1 });
    });
  }
  return [...seen].filter(([name]) => !ENV_IGNORE.has(name) && !new RegExp(`\\b${name}\\b`).test(documented))
    .map(([name, at]) => ({ severity: "warning", file: at.file, line: at.line, kind: "env", value: name, detail: "is not named in docs/configuration.md or .env.example" }));
}

// ── Change-impact classification ────────────────────────────────────────────

/** Files changed relative to `base` (working tree + index) plus untracked files. Deleted files are included. */
export function changedFiles(root = REPO_ROOT, base = "HEAD") {
  const diff = splitZ(git(root, ["diff", "--name-only", "-z", base, "--"]));
  const untracked = splitZ(git(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  return [...new Set([...diff, ...untracked])].sort();
}

/** Compare package.json `scripts` and `engines` between two parsed manifests. Pure; exported for tests. */
export function diffManifest(before = {}, after = {}) {
  const changes = [];
  const scriptsBefore = before.scripts || {};
  const scriptsAfter = after.scripts || {};
  for (const name of new Set([...Object.keys(scriptsBefore), ...Object.keys(scriptsAfter)])) {
    if (!(name in scriptsBefore)) changes.push(`script added: ${name}`);
    else if (!(name in scriptsAfter)) changes.push(`script removed: ${name}`);
    else if (scriptsBefore[name] !== scriptsAfter[name]) changes.push(`script changed: ${name}`);
  }
  if (JSON.stringify(before.engines || {}) !== JSON.stringify(after.engines || {})) changes.push("engines changed");
  return changes;
}

function manifestChanges(root, base) {
  try {
    const before = JSON.parse(git(root, ["show", `${base}:package.json`]));
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return diffManifest(before, after);
  } catch {
    return ["package.json could not be compared"];
  }
}

/**
 * Group files by impact area. A file can belong to several areas; files in no area are "unmapped" (no known context
 * impact). `manifest` is the diffManifest() result: an empty list downgrades a package.json edit to low impact.
 */
export function classifyChanges(files, map, { manifest = [] } = {}) {
  const areas = new Map();
  const contextFiles = [];
  const unmapped = [];
  for (const file of files) {
    if (matchesAny(file, map.contextFiles) && file !== ".claude/settings.json") contextFiles.push(file);
    const hits = map.areas.filter((area) => matchesAny(file, area.globs));
    if (!hits.length && !contextFiles.includes(file)) unmapped.push(file);
    for (const area of hits) {
      if (!areas.has(area.id)) {
        const impact = area.id === "package-scripts" && !manifest.length ? "low" : area.impact;
        areas.set(area.id, { ...area, impact, files: [], notes: area.id === "package-scripts" ? (manifest.length ? manifest : ["dependency-only change"]) : [] });
      }
      areas.get(area.id).files.push(file);
    }
  }
  return { areas: [...areas.values()], contextFiles, unmapped };
}

// ── Stop hook ───────────────────────────────────────────────────────────────

function signature(root, file) {
  const full = join(root, file);
  if (!existsSync(full)) return "deleted";
  const stat = statSync(full);
  if (!stat.isFile()) return "dir";
  if (stat.size > HASH_LIMIT_BYTES) return `size:${stat.size}:${stat.mtimeMs}`;
  return createHash("sha1").update(readFileSync(full)).digest("hex");
}

/**
 * Decide whether the Stop hook should ask for an impact assessment. Pure; exported for tests.
 *   previous  {file: signature} from the last run, or null on the first run (baseline, never blocks)
 *   current   {file: signature} for the files that differ from HEAD now
 * Only files whose signature changed since the last run count, so one change set produces at most one reminder.
 */
export function decideStop({ previous, current, map, manifest = [], refErrors = () => [] }) {
  if (!previous) return { block: false, reason: "baseline recorded" };
  const fresh = Object.keys(current).filter((file) => current[file] !== previous[file]).sort();
  if (!fresh.length) return { block: false, reason: "no new changes" };
  const result = classifyChanges(fresh, map, { manifest });
  const high = result.areas.filter((area) => area.impact === "high");
  const docsTouched = fresh.filter((file) => matchesAny(file, [...map.contextFiles, ...map.humanDocs]));
  const errors = docsTouched.length ? refErrors(docsTouched) : [];
  if (!high.length && !errors.length) return { block: false, reason: "only low-impact or unmapped changes", fresh };
  const lines = ["Context maintenance check (scripts/check-context.mjs). Files changed since the last check:"];
  for (const area of high) {
    const shown = area.files.slice(0, 6).join(", ") + (area.files.length > 6 ? `, +${area.files.length - 6} more` : "");
    const notes = area.notes.length ? ` [${area.notes.join("; ")}]` : "";
    lines.push(`- ${area.id}: ${shown}${notes} -> review ${area.review.join(", ") || "(no mapped docs)"}`);
  }
  for (const error of errors.slice(0, 10)) lines.push(`- broken reference ${error.file}:${error.line} \`${error.value}\` ${error.detail}`);
  lines.push(
    "Before finishing: check these docs against your change now (CLAUDE.md, Engineering context maintenance), update only the statements that became false or incomplete, fix any broken reference, and end with the Context maintenance report (say so if no update was needed).",
    "If these files were not changed by this task, say that and do not edit anything. This reminder is shown once per change set."
  );
  return { block: true, reason: lines.join("\n"), fresh };
}

export function runStopHook(root = REPO_ROOT, input = {}) {
  if (input.stop_hook_active) return null; // continuing because of a Stop hook: never re-block (no loops)
  const statePath = resolve(root, git(root, ["rev-parse", "--git-dir"]).trim(), STATE_FILE);
  const current = Object.fromEntries(changedFiles(root).map((file) => [file, signature(root, file)]));
  let previous = null;
  try { previous = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first run: baseline */ }
  const map = loadMap(root);
  const decision = decideStop({
    previous,
    current,
    map,
    manifest: "package.json" in current ? manifestChanges(root, "HEAD") : [],
    refErrors: (docs) => checkReferences(root, { only: docs }).filter((finding) => finding.severity === "error"),
  });
  writeFileSync(statePath, JSON.stringify(current));
  return decision.block ? { decision: "block", reason: decision.reason } : null;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const format = (finding) => `${finding.severity.toUpperCase()} ${finding.file}:${finding.line} ${finding.kind} \`${finding.value}\` ${finding.detail}`;

function cliValidate(strict) {
  const map = loadMap();
  const findings = [...checkReferences(REPO_ROOT, { strict }), ...checkSkills(), ...checkMap(REPO_ROOT, map), ...checkEnvDocs()];
  for (const finding of findings) console.log(format(finding));
  const errors = findings.filter((finding) => finding.severity === "error").length;
  console.log(`check-context: ${errors} error(s), ${findings.length - errors} warning(s)`);
  return errors ? 1 : 0;
}

function cliDiff(base) {
  const map = loadMap();
  const files = changedFiles(REPO_ROOT, base);
  const result = classifyChanges(files, map, { manifest: files.includes("package.json") ? manifestChanges(REPO_ROOT, base) : [] });
  console.log(`check-context --diff ${base}: ${files.length} changed file(s)`);
  for (const area of [...result.areas].sort((a, b) => (a.impact === b.impact ? 0 : a.impact === "high" ? -1 : 1))) {
    console.log(`\n[${area.impact}] ${area.id}: ${area.summary}${area.notes.length ? ` (${area.notes.join("; ")})` : ""}`);
    console.log(`  review: ${area.review.join(", ") || "(none)"}`);
    for (const file of area.files.slice(0, 15)) console.log(`  - ${file}`);
    if (area.files.length > 15) console.log(`  ... +${area.files.length - 15} more`);
  }
  if (result.contextFiles.length) {
    console.log(`\nClaude context files changed (references re-validated below): ${result.contextFiles.join(", ")}`);
  }
  if (result.unmapped.length) console.log(`\nUnmapped (no known context impact): ${result.unmapped.join(", ")}`);
  const errors = checkReferences(REPO_ROOT, { only: files }).filter((finding) => finding.severity === "error");
  for (const error of errors) console.log(format(error));
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--hook-stop")) {
    // A hook must never break the session: any failure is reported on stderr and the stop is allowed.
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const output = runStopHook(REPO_ROOT, raw.trim() ? JSON.parse(raw) : {});
        if (output) process.stdout.write(JSON.stringify(output));
      } catch (error) {
        process.stderr.write(`check-context hook skipped: ${error?.message || error}\n`);
      }
      process.exit(0);
    });
  } else if (args.includes("--diff")) {
    const base = args[args.indexOf("--diff") + 1];
    process.exit(cliDiff(base && !base.startsWith("--") ? base : "HEAD"));
  } else {
    process.exit(cliValidate(args.includes("--strict")));
  }
}
