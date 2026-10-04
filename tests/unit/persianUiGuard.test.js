/**
 * Static Persian-UI guard.
 *
 * Requirement 1: the entire customer-facing bot UI is Persian-only. This test
 * scans the user-facing handler files for inline button labels and callback
 * alerts written as plain double-quoted strings and fails when one contains
 * no Persian characters. Dynamic labels (template literals) and developer
 * logs are out of scope; brand names are allowlisted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const USER_FACING_DIRS = [
  "handlers/message",
  "handlers/admin",
  "services/buyService",
  "services/manageServices",
  "messages",
];
const USER_FACING_FILES = [
  "handlers/handleCallbackQuery.js",
  "handlers/supportMessageHandler.js",
  "handlers/admin/panel.js",
];

// Brand/product names may stay Latin inside a Persian label.
const ALLOWED_SUBSTRINGS = ["HooshPay", "TRX", "VPN", "WizardXray", "QRCode"];

function listJsFiles(dir) {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(root, dir, entry.name));
  } catch {
    return [];
  }
}

function collectFiles() {
  const files = USER_FACING_FILES.map((relative) => join(root, relative));
  for (const dir of USER_FACING_DIRS) {
    if (dir === "handlers/admin") continue; // only panel.js from admin dir
    files.push(...listJsFiles(dir));
  }
  return files;
}

const PERSIAN = /[\u0600-\u06FF]/;

/** Extract `text: "…"` literals from a source file. */
function extractLabels(source) {
  const labels = [];
  const pattern = /\btext:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(source))) labels.push(match[1]);
  return labels;
}

function isPersianOrAllowlisted(label) {
  if (PERSIAN.test(label)) return true;
  // Symbol-only labels (arrows, emoji pagination controls, digits) carry no
  // language and are fine.
  if (!/[A-Za-z]/.test(label)) return true;
  return ALLOWED_SUBSTRINGS.some((brand) => label.includes(brand));
}

describe("Persian-only UI (static guard)", () => {
  test("every inline button/alert label in user-facing handlers contains Persian", () => {
    const files = collectFiles();
    assert.ok(files.length >= 8, `expected to scan the handler tree, found ${files.length} files`);
    const offenders = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const label of extractLabels(source)) {
        // Empty/whitespace-only labels (e.g. disabled buttons) are fine.
        if (!label.trim()) continue;
        checked++;
        if (!isPersianOrAllowlisted(label)) {
          offenders.push(`${file.split("SWIFT-VPN-Bot")[1] || file}: ${JSON.stringify(label)}`);
        }
      }
    }
    assert.ok(checked >= 60, `expected a meaningful number of labels, checked ${checked}`);
    assert.deepEqual(offenders, [], `non-Persian UI labels found:\n${offenders.join("\n")}`);
  });

  test("support/contact copy is Persian in messages/", () => {
    const support = readFileSync(join(root, "messages/supportContact.js"), "utf8");
    assert.match(support, /گفتگو با پشتیبانی/);
    assert.match(support, /قوانین و مقررات/);
    // The support handle must come from the environment, never be hardcoded:
    // strip comments, then require that the ONLY string feeding the contact
    // lookup is the env read.
    const code = support.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.match(code, /process\.env\.SUPPORT_CONTACT/);
    const getContactBody = code.slice(code.indexOf("function getSupportContact"), code.indexOf("function getSupportContact") + 400);
    assert.doesNotMatch(getContactBody, /@[A-Za-z][A-Za-z0-9_]{3,}/, "no hardcoded @handle in the lookup");
  });
});
