/**
 * The two admin forms that use zod (broadcast composer, plan dialog) validate in
 * the browser with these exact schemas (admin-panel/lib/form-schemas.ts).
 * Accept/reject decisions, the messages the forms define themselves and the
 * coerced values are the contract; zod's own wording for e.g. an empty number
 * field is deliberately not asserted. The browser-level behaviour is covered by
 * tests/e2e/nextPanel.e2e.mjs.
 *
 * The schema file is TypeScript and package.json allows Node >= 20, which cannot
 * import .ts (native type stripping only exists in recent Node releases). So the
 * file is transpiled in memory with the project's own `typescript` package and
 * evaluated with a `require` rooted at that file (it only imports `zod`): the
 * test runs the real shared schemas on every supported Node, with no extra loader.
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

const { broadcastSchema, productSchema } = loadTypeScriptModule("../../admin-panel/lib/form-schemas.ts");

const issuesOf = (result) => result.error.issues.map((issue) => `${issue.path.join(".")}|${issue.message}`).sort();
const button = (text, url) => ({ text, url });
const validBroadcast = { message: "Hello", audience: "all", customTelegramIds: "", buttons: [] };
const validProduct = { name: "Plan", durationDays: 30, trafficGb: 50, priceToman: 100_000, costToman: 0, enabled: true, published: true };

describe("broadcast form schema", () => {
  test("accepts a plain message and trims it", () => {
    const result = broadcastSchema.safeParse({ ...validBroadcast, message: "  Hello  " });
    assert.equal(result.success, true);
    assert.equal(result.data.message, "Hello");
  });

  test("message must be non-blank and at most 4096 characters", () => {
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, message: "   " })), ["message|Message is required"]);
    assert.equal(broadcastSchema.safeParse({ ...validBroadcast, message: "x".repeat(4096) }).success, true);
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, message: "x".repeat(4097) })), ["message|Message must be at most 4096 characters"]);
  });

  test("audience is one of the five known values", () => {
    for (const audience of ["all", "active", "expired", "paying", "custom"]) assert.equal(broadcastSchema.safeParse({ ...validBroadcast, audience }).success, true, audience);
    assert.equal(broadcastSchema.safeParse({ ...validBroadcast, audience: "everyone" }).success, false);
    assert.equal(broadcastSchema.safeParse({ message: "Hello", buttons: [] }).success, false, "audience is required");
  });

  test("customTelegramIds is optional", () => {
    assert.equal(broadcastSchema.safeParse({ ...validBroadcast, audience: "custom", customTelegramIds: undefined }).success, true);
  });

  test("buttons are required as an array (the form always supplies one)", () => {
    assert.equal(broadcastSchema.safeParse({ message: "Hello", audience: "all" }).success, false);
    assert.equal(broadcastSchema.safeParse({ ...validBroadcast, buttons: null }).success, false);
  });

  test("buttons accept only https t.me / telegram.me / telegram.dog links", () => {
    for (const url of ["https://t.me/swift_shield", "https://telegram.me/x", "https://telegram.dog/x", "  https://t.me/x  "]) {
      assert.equal(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("Go", url)] }).success, true, url);
    }
    for (const url of ["http://t.me/x", "https://t.me.evil.example/x", "https://evil.example/t.me/x", "https://t.me", "javascript:alert(1)", "nope"]) {
      assert.equal(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("Go", url)] }).success, false, url);
    }
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("Go", "https://t.me.evil.example/x")] })), ["buttons.0.url|Must be a t.me link"]);
    // A non-URL always gets the "valid URL" message (whether the t.me rule also reports on it depends on the zod version).
    assert.ok(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("Go", "nope")] })).includes("buttons.0.url|Must be a valid URL"));
  });

  test("button text is trimmed, required and at most 64 characters", () => {
    const parsed = broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("  Go  ", "https://t.me/x")] });
    assert.equal(parsed.data.buttons[0].text, "Go");
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("  ", "https://t.me/x")] })), ["buttons.0.text|Button text is required"]);
    assert.equal(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("x".repeat(64), "https://t.me/x")] }).success, true);
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, buttons: [button("x".repeat(65), "https://t.me/x")] })), ["buttons.0.text|At most 64 characters"]);
  });

  test("at most 4 buttons; an over-limit array is rejected on its size alone, before any button is examined", () => {
    const valid = (n) => Array.from({ length: n }, (_, i) => button(`b${i}`, `https://t.me/x${i}`));
    assert.equal(broadcastSchema.safeParse({ ...validBroadcast, buttons: valid(4) }).success, true);
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, buttons: valid(5) })), ["buttons|At most 4 buttons"]);
    // Five *invalid* buttons: with a patched zod (>= 4.6.6) the size check runs first and is the only issue.
    // (zod 3 parses every element first and reports each button's errors as well.)
    const invalid = Array.from({ length: 5 }, () => button("", "nope"));
    assert.deepEqual(issuesOf(broadcastSchema.safeParse({ ...validBroadcast, buttons: invalid })), ["buttons|At most 4 buttons"]);
  });
});

describe("plan form schema", () => {
  test("accepts a valid plan and returns numbers, with the name trimmed", () => {
    const result = productSchema.safeParse({ ...validProduct, name: "  Plan  " });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { ...validProduct, name: "Plan" });
  });

  test("number inputs arrive as strings from the form and are coerced to numbers", () => {
    const result = productSchema.safeParse({ ...validProduct, durationDays: "30", trafficGb: "10", priceToman: "150000", costToman: "90000" });
    assert.equal(result.success, true);
    assert.deepEqual([result.data.durationDays, result.data.trafficGb, result.data.priceToman, result.data.costToman], [30, 10, 150000, 90000]);
    for (const value of [result.data.durationDays, result.data.priceToman]) assert.equal(typeof value, "number");
  });

  test("name is required (after trimming) and at most 120 characters", () => {
    assert.deepEqual(issuesOf(productSchema.safeParse({ ...validProduct, name: "  " })), ["name|Name is required"]);
    assert.equal(productSchema.safeParse({ ...validProduct, name: "x".repeat(120) }).success, true);
    assert.deepEqual(issuesOf(productSchema.safeParse({ ...validProduct, name: "x".repeat(121) })), ["name|Name must be at most 120 characters"]);
  });

  test("each numeric field enforces its own bounds, inclusive at both ends", () => {
    const bounds = [
      ["durationDays", 1, 3650, "Must be at least 1 day", "Must be at most 3650 days"],
      ["trafficGb", 1, 100_000, "Must be at least 1 GB", "Must be at most 100,000 GB"],
      ["priceToman", 1, 2_000_000_000, "Price must be positive", "Price is too large"],
      ["costToman", 0, 2_000_000_000, "Cost cannot be negative", "Cost is too large"],
    ];
    for (const [field, min, max, tooSmall, tooBig] of bounds) {
      assert.equal(productSchema.safeParse({ ...validProduct, [field]: min }).success, true, `${field} min`);
      assert.equal(productSchema.safeParse({ ...validProduct, [field]: max }).success, true, `${field} max`);
      assert.deepEqual(issuesOf(productSchema.safeParse({ ...validProduct, [field]: min - 1 })), [`${field}|${tooSmall}`], `${field} below min`);
      assert.deepEqual(issuesOf(productSchema.safeParse({ ...validProduct, [field]: max + 1 })), [`${field}|${tooBig}`], `${field} above max`);
    }
  });

  test("fractions, text and a cleared field are rejected", () => {
    for (const bad of [12.5, "12.5", "abc", "", undefined, NaN, Infinity]) {
      const result = productSchema.safeParse({ ...validProduct, durationDays: bad });
      assert.equal(result.success, false, String(bad));
      assert.ok(result.error.issues.every((issue) => issue.path[0] === "durationDays"), `${String(bad)} only flags the duration`);
    }
  });

  test("enabled must be a real boolean", () => {
    assert.equal(productSchema.safeParse({ ...validProduct, enabled: false }).success, true);
    assert.equal(productSchema.safeParse({ ...validProduct, enabled: "true" }).success, false);
    assert.equal(productSchema.safeParse({ ...validProduct, enabled: undefined }).success, false);
  });

  test("an empty submission reports every required field", () => {
    const flagged = new Set(productSchema.safeParse({}).error.issues.map((issue) => issue.path[0]));
    assert.deepEqual([...flagged].sort(), ["costToman", "durationDays", "enabled", "name", "priceToman", "published", "trafficGb"]);
  });

  test("the optional custom id accepts a blank or a lowercase slug and rejects anything else", () => {
    for (const ok of [undefined, "", "promo_20gb", "abc"]) assert.equal(productSchema.safeParse({ ...validProduct, productId: ok }).success, true, String(ok));
    for (const bad of ["Bad", "1abc", "ab", "a b", "../x", "x".repeat(33)]) assert.equal(productSchema.safeParse({ ...validProduct, productId: bad }).success, false, bad);
  });
});
