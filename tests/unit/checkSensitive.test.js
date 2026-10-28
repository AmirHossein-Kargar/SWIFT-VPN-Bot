import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { scanLine, luhn } = await import("../../scripts/check-sensitive.mjs");

// Every sensitive-looking value is assembled at runtime so this file contains none.
function luhnCard(prefix, length = 16) {
  let body = prefix;
  while (body.length < length - 1) body += String((body.length * 7 + 3) % 10);
  for (let check = 0; check < 10; check += 1) if (luhn(body + check)) return body + check;
  throw new Error("unreachable");
}
const categories = (line, options) => scanLine(line, options).map((finding) => finding.category);

describe("check-sensitive: what it flags", () => {
  test("a Luhn-valid card number, in any common grouping", () => {
    const card = luhnCard("6219");
    assert.ok(luhn(card));
    for (const text of [card, card.replace(/(.{4})/g, "$1 ").trim(), card.replace(/(.{4})/g, "$1-").replace(/-$/, "")]) {
      assert.deepEqual(categories(`const n = "${text}";`), ["CARD_NUMBER"], text.length + " chars");
    }
  });

  test("but not a Luhn-invalid number, a long id, or a well-known test card number", () => {
    const valid = luhnCard("6219");
    const invalid = valid.slice(0, -1) + String((Number(valid.at(-1)) + 1) % 10);
    assert.deepEqual(categories(`x = ${invalid}`), []);
    assert.deepEqual(categories(`x = ${["4242", "4242", "4242", "4242"].join("")}`), []);
    assert.deepEqual(categories(`order ${Date.now()}`), [], "timestamps are not cards");
  });

  test("an Iranian mobile number, unless it is an obvious placeholder", () => {
    const real = ["09", "137", "482", "965"].join("");
    assert.deepEqual(categories(`phone: "${real}"`), ["PHONE_IR"]);
    assert.deepEqual(categories(`phone: "${["0912", "3456", "789"].join("")}"`), [], "ascending digits");
    assert.deepEqual(categories(`phone: "${["09", "000", "000", "000"].join("")}"`), [], "repeated digits");
  });

  test("email addresses, except placeholder domains and URI userinfo", () => {
    assert.deepEqual(categories(`mail ${["someone", "gmail.com"].join("@")}`), ["EMAIL"]);
    for (const ok of [["user", "example.com"], ["a", "mail.example.test"], ["noreply", "anthropic.com"], ["1+name", "users.noreply.github.com"]]) {
      assert.deepEqual(categories(`mail ${ok.join("@")}`), [], ok[1]);
    }
    assert.deepEqual(categories(`MONGO_URL = "mongodb://${["user:pw", "host.internal"].join("@")}/db"`), [], "userinfo");
  });

  test("tokens, keys and private keys", () => {
    assert.deepEqual(categories(`BOT_TOKEN=${"123456789"}:${"Ab1_".repeat(9).slice(0, 35)}`), ["TELEGRAM_BOT_TOKEN"]);
    assert.deepEqual(categories(`k = "${["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_")}"`), ["API_KEY"]);
    assert.deepEqual(categories(["-----BEGIN", "PRIVATE KEY-----"].join(" RSA ")), ["PRIVATE_KEY"]);
  });

  test("real-looking URI credentials and high-entropy secret assignments, but not placeholders", () => {
    assert.deepEqual(categories(`u = "mongodb+srv://admin:${"Zq8vK2mXr9LpT4wB"}@cluster.db.net/app"`), ["URI_CREDENTIALS"]);
    assert.deepEqual(categories(`u = "redis://default:pass@host:6379"`), []);
    assert.deepEqual(categories(`const SERVICE_SECRET = "${"Qm7#xT2!vR9$kL4@nW8z"}";`), ["SECRET_ASSIGNMENT"]);
    assert.deepEqual(categories(`const TEST_SECRET = "unit-test-secret-value-0001";`), []);
  });

  test("project-specific names via a local blocklist, and the explicit allow marker", () => {
    const blocklist = [/jane\s+doe/gi];
    assert.deepEqual(categories("author: Jane  Doe", { blocklist }), ["BLOCKLIST"]);
    assert.deepEqual(categories("author: Jane Doe // privacy-allow: public attribution", { blocklist }), []);
  });
});

describe("check-sensitive: output never contains the value", () => {
  test("the CLI reports file, line, category and length only, and exits non-zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "sensitive-"));
    try {
      const card = luhnCard("5022");
      const file = join(dir, "sample.txt");
      writeFileSync(file, `line one\nnumber: ${card}\n`);
      const run = spawnSync(process.execPath, [join(process.cwd(), "scripts", "check-sensitive.mjs"), file], { encoding: "utf8" });
      assert.equal(run.status, 1);
      const output = run.stdout + run.stderr;
      assert.match(output, /sample\.txt:2\s+CARD_NUMBER \[16 chars\]/);
      assert.ok(!output.includes(card) && !output.includes(card.slice(0, 8)), "no part of the value is printed");
      const clean = join(dir, "clean.txt");
      writeFileSync(clean, "nothing sensitive here\n");
      assert.equal(spawnSync(process.execPath, [join(process.cwd(), "scripts", "check-sensitive.mjs"), clean], { encoding: "utf8" }).status, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the repository itself passes the checker", () => {
    const run = spawnSync(process.execPath, [join(process.cwd(), "scripts", "check-sensitive.mjs"), "--all"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
