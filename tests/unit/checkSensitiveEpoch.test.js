import { test } from "node:test";
import assert from "node:assert/strict";
import { luhn, scanLine } from "../../scripts/check-sensitive.mjs";

const categories = (line) => scanLine(line).map((finding) => finding.category);

test("Unix-millisecond timestamps are never reported as cards, whatever their Luhn digit", () => {
  const base = 1_790_000_000_000;
  let luhnValid = 0;
  for (let i = 0; i < 500; i += 1) {
    const stamp = String(base + i);
    if (luhn(stamp)) luhnValid += 1;
    assert.deepEqual(categories(`order ${stamp}`), [], stamp);
  }
  assert.ok(luhnValid > 0, "the sample must include Luhn-valid timestamps, or this test proves nothing");
});

test("a Luhn-valid 13-digit Visa-style number is still reported", () => {
  const body = "422222222222";
  let check = 0;
  while (!luhn(body + check)) check += 1;
  assert.deepEqual(categories(`x = ${body}${check}`), ["CARD_NUMBER"]);
});
