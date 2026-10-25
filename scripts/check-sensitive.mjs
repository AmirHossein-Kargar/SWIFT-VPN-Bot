#!/usr/bin/env node
/**
 * Redacting scanner for personal and financial data that must not be committed.
 * It never prints a matched value: findings are shown as `[CATEGORY:length]`.
 *
 *   node scripts/check-sensitive.mjs --staged     scan the lines added to the index (pre-commit; renamed files included)
 *   node scripts/check-sensitive.mjs --all        scan every tracked file
 *   node scripts/check-sensitive.mjs <file...>    scan specific files
 *
 * Detects: payment-card numbers (Luhn-valid), Iranian IBANs, Telegram bot tokens, common API
 * key/token formats, private keys, URIs with real-looking credentials, secret-like assignments,
 * email addresses that are not placeholders, and Iranian mobile numbers that are not obvious
 * placeholders. Personal names and handles are project-specific, so put them (one regular
 * expression per line) in the untracked file `.git/info/privacy-blocklist`.
 *
 * Intentional fixtures: use clearly fake values (see docs/privacy.md). As a last resort add
 * `privacy-allow` and a reason in a comment on the same line.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CARD_ALLOWLIST = new Set(["4242424242424242", "4111111111111111", "5555555555554444", "378282246310005", "6011111111111117"]);
const PLACEHOLDER_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|[a-z0-9-]*\.?test|invalid|localhost|users\.noreply\.github\.com|github\.com|anthropic\.com)$/i;
const PLACEHOLDER_PASSWORD = /^(\*+|<[^>]+>|x{3,}|.*(pass|word|secret|pw|example|test|fake|placeholder|dummy|changeme|your|user|mongo|redis).*)$/i;
const FAKE_WORDS = /(test|fake|dummy|example|sample|placeholder|secret|mock|demo|xxxx|your|redacted|unit|key|token|abc|changeme)/i;
const SKIP_FILE = /(\.(png|jpe?g|gif|webp|ico|woff2?|br|gz|zip|pdf|mp4)$|(^|\/)package-lock\.json$)/i;

export function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function entropy(value) {
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  return -[...counts.values()].reduce((s, n) => s + (n / value.length) * Math.log2(n / value.length), 0);
}

const obviousPlaceholderDigits = (digits) =>
  /(\d)\1{3,}/.test(digits) || [...digits].some((_, i) => i <= digits.length - 5 && [0, 1, 2, 3].every((j) => Number(digits[i + j + 1]) - Number(digits[i + j]) === 1));

/** Returns [{ category, length, index }] for one line. */
export function scanLine(line, { blocklist = [] } = {}) {
  if (/privacy-allow/.test(line)) return [];
  const findings = [];
  const add = (category, match) => findings.push({ category, length: match[0].length, index: match.index });

  for (const m of line.matchAll(/(?<![\d.-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits) && !CARD_ALLOWLIST.has(digits)) add("CARD_NUMBER", m);
  }
  for (const m of line.matchAll(/\bIR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}\b|\bIR\d{24}\b/g)) add("IBAN_IR", m);
  for (const m of line.matchAll(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g)) add("TELEGRAM_BOT_TOKEN", m);
  for (const m of line.matchAll(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{30,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}/g)) add("API_KEY", m);
  for (const m of line.matchAll(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)) add("JWT", m);
  for (const m of line.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) add("PRIVATE_KEY", m);
  for (const m of line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@'"<>]+):([^\s/@'"<>]+)@[^\s'"<>]+/gi)) {
    let password = m[2];
    try { password = decodeURIComponent(password); } catch { /* keep the raw value */ }
    if (!PLACEHOLDER_PASSWORD.test(password)) add("URI_CREDENTIALS", m);
  }
  for (const m of line.matchAll(/\b([A-Za-z_]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)[A-Za-z_]*)\s*[:=]\s*(['"])([^'"\s]{20,})\2/gi)) {
    const value = m[3];
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((rx) => rx.test(value)).length;
    if (!FAKE_WORDS.test(value) && entropy(value) >= 3.6 && classes >= 3) add("SECRET_ASSIGNMENT", m);
  }
  for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
    if (/:\/\/[^\s/]*$/.test(line.slice(0, m.index))) continue; // user:pass@host userinfo is handled by the URI rule
    if (!PLACEHOLDER_EMAIL_DOMAIN.test(m[1]) && !/^\d+\.\d+/.test(m[1])) add("EMAIL", m);
  }
  for (const m of line.matchAll(/(?<![\d.])(?:\+98|0098|0)9\d{9}(?!\d)/g)) {
    if (!obviousPlaceholderDigits(m[0].replace(/\D/g, ""))) add("PHONE_IR", m);
  }
  for (const rx of blocklist) for (const m of line.matchAll(rx)) add("BLOCKLIST", m);
  return findings;
}

export function loadBlocklist(root = process.cwd()) {
  const file = join(root, ".git", "info", "privacy-blocklist");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new RegExp(l, "gi"));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Yields { file, lineNo, text } for every line ADDED by a unified diff made with -U0.
 *
 * The parser is positional, not guesswork: file headers (`--- `, `+++ `) are only
 * recognised between a `diff --git` line and the first `@@` hunk header of that
 * file. Inside a hunk every line starting with `+` is content, so an added line
 * whose text begins with `++` (shown as `+++ ...`) can neither be mistaken for a
 * header nor be skipped, and it cannot change the file name used in findings.
 * A content line can never start with `diff --git ` or `@@ ` unprefixed (content
 * is always prefixed with `+`, `-` or a space), so those markers are unambiguous.
 */
export function* parseStagedDiff(diffText) {
  let file = "";
  let lineNo = 0;
  let inHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; file = ""; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { lineNo = Number(hunk[1]) - 1; inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith("+++ ")) file = line.slice(4).replace(/^"?b\//, "").replace(/"$/, "");
      continue;
    }
    if (line.startsWith("+")) { lineNo += 1; yield { file, lineNo, text: line.slice(1) }; }
  }
}

function* stagedLines() {
  // A, C, M and R: a renamed-and-edited file is reported as R and its added lines must be scanned too.
  // No external diff driver or textconv, and fixed prefixes, so user diff configuration cannot change what is read or how it is parsed.
  const diff = git(["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--diff-filter=ACMR"]);
  for (const entry of parseStagedDiff(diff)) if (!SKIP_FILE.test(entry.file)) yield entry;
}

function* fileLines(files) {
  for (const file of files) {
    if (SKIP_FILE.test(file) || !existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) yield { file, lineNo: i + 1, text: lines[i] };
  }
}

function main(argv) {
  const blocklist = loadBlocklist();
  const mode = argv[0];
  const source = mode === "--staged" ? stagedLines()
    : mode === "--all" ? fileLines(git(["ls-files"]).split("\n").filter(Boolean))
    : fileLines(argv);
  const counts = new Map();
  let total = 0;
  for (const { file, lineNo, text } of source) {
    for (const f of scanLine(text, { blocklist })) {
      total += 1;
      counts.set(f.category, (counts.get(f.category) || 0) + 1);
      console.error(`${file}:${lineNo}  ${f.category} [${f.length} chars]  (value not shown)`);
    }
  }
  if (total) {
    console.error(`\n${total} possible sensitive value(s): ${[...counts].map(([c, n]) => `${c}×${n}`).join(", ")}.`);
    console.error("Remove or replace them with clearly fake values (docs/privacy.md). For a deliberate fixture, add `privacy-allow: <reason>` in a comment on that line.");
    return 1;
  }
  console.log("check-sensitive: no sensitive values found");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
