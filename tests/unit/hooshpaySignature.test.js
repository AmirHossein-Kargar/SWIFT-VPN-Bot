/**
 * HooshPay webhook signature tests — these import the REAL
 * services/hooshpay/verifySignature.js used by server.js.
 *
 * Covers: valid/invalid/missing/malformed signatures, key-order independence
 * (ksort), nested canonicalisation and unicode/slash handling.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyHooshPaySignature,
  canonicalPayload,
} from "../../services/hooshpay/verifySignature.js";

const SECRET = "s3cret-webhook-key";

/** Independent reference signer (mirrors the documented ksort + json_encode). */
function sign(secret, payload, { json = JSON.stringify } = {}) {
  const sorted = {};
  for (const k of Object.keys(payload).sort()) sorted[k] = payload[k];
  return crypto.createHmac("sha256", secret).update(json(sorted)).digest("hex");
}

describe("HooshPay signature verification (real implementation)", () => {
  const payload = {
    event: "payment.success",
    invoice: "inv_AbC123",
    status: "paid",
    amount: 250000,
    payable_amount: 300017,
    merchant_credit: 250000,
  };

  test("accepts a correctly signed payload", () => {
    assert.equal(verifyHooshPaySignature(payload, sign(SECRET, payload), SECRET), true);
  });

  test("is independent of key order in the received payload", () => {
    const a = { b: 2, a: 1, c: 3 };
    const b = { c: 3, a: 1, b: 2 };
    const sig = sign(SECRET, a);
    assert.equal(verifyHooshPaySignature(a, sig, SECRET), true);
    assert.equal(verifyHooshPaySignature(b, sig, SECRET), true);
  });

  test("rejects a tampered amount", () => {
    const sig = sign(SECRET, payload);
    const tampered = { ...payload, amount: 1 };
    assert.equal(verifyHooshPaySignature(tampered, sig, SECRET), false);
  });

  test("rejects a wrong secret", () => {
    assert.equal(verifyHooshPaySignature(payload, sign("other-secret", payload), SECRET), false);
  });

  test("rejects missing / empty / non-string signatures", () => {
    assert.equal(verifyHooshPaySignature(payload, undefined, SECRET), false);
    assert.equal(verifyHooshPaySignature(payload, null, SECRET), false);
    assert.equal(verifyHooshPaySignature(payload, "", SECRET), false);
    assert.equal(verifyHooshPaySignature(payload, 12345, SECRET), false);
  });

  test("rejects a missing secret (no bypass path)", () => {
    const sig = sign(SECRET, payload);
    assert.equal(verifyHooshPaySignature(payload, sig, ""), false);
    assert.equal(verifyHooshPaySignature(payload, sig, undefined), false);
    assert.equal(verifyHooshPaySignature(payload, sig, null), false);
  });

  test("rejects non-hex signatures instead of silently truncating", () => {
    assert.equal(verifyHooshPaySignature(payload, "zzzzzzzz".repeat(8), SECRET), false);
    assert.equal(verifyHooshPaySignature(payload, "not-hex-at-all", SECRET), false);
  });

  test("rejects signatures of the wrong length", () => {
    const good = sign(SECRET, payload);
    assert.equal(verifyHooshPaySignature(payload, good.slice(0, 32), SECRET), false);
    assert.equal(verifyHooshPaySignature(payload, good + "ab", SECRET), false);
  });

  test("rejects non-object payloads", () => {
    assert.equal(verifyHooshPaySignature(null, "ab", SECRET), false);
    assert.equal(verifyHooshPaySignature([], "ab", SECRET), false);
    assert.equal(verifyHooshPaySignature("string", "ab", SECRET), false);
  });

  test("canonicalPayload sorts nested keys recursively", () => {
    const a = { card: { number: "6037", bank: "x" }, amount: 100 };
    const b = { amount: 100, card: { bank: "x", number: "6037" } };
    assert.equal(canonicalPayload(a), canonicalPayload(b));
    assert.equal(canonicalPayload({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  test("canonicalPayload does not escape unicode or slashes", () => {
    assert.equal(canonicalPayload({ url: "https://x/y", name: "کاربر" }), '{"name":"کاربر","url":"https://x/y"}');
  });

  test("nested payload signed with the same canonical form verifies", () => {
    const nested = { event: "payment.success", data: { uid: "u1", fee_mode: "buyer" }, amount: 10 };
    const sig = crypto
      .createHmac("sha256", SECRET)
      .update(canonicalPayload(nested))
      .digest("hex");
    assert.equal(verifyHooshPaySignature(nested, sig, SECRET), true);
  });

  test("array order is preserved (arrays are not sorted)", () => {
    assert.equal(canonicalPayload({ a: [3, 1, 2] }), '{"a":[3,1,2]}');
  });
});
