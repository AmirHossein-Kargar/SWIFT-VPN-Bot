/**
 * Amount validation tests — REAL utils/validationAmount.js and
 * utils/validationAmountTrx.js.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import validateWithCommas from "../../utils/validationAmount.js";
import validateWithCommasTrx from "../../utils/validationAmountTrx.js";

describe("validateWithCommas (real implementation)", () => {
  test("accepts properly formatted amounts inside the default range", () => {
    for (const t of ["10,000", "50,000", "120,000", "500,000"]) {
      const r = validateWithCommas(t);
      assert.equal(r.valid, true, `${t} should be valid`);
      assert.equal(r.amount, parseInt(t.replace(/,/g, ""), 10));
    }
  });

  test("rejects amounts without comma grouping", () => {
    for (const t of ["50000", "5000", "5,0000", "50,00", ",500"]) {
      assert.equal(validateWithCommas(t).valid, false, `${t} should be invalid`);
    }
  });

  test("enforces the default min/max bounds", () => {
    assert.equal(validateWithCommas("9,999").valid, false);
    assert.equal(validateWithCommas("500,001").valid, false);
    assert.equal(validateWithCommas("10,000").valid, true);
    assert.equal(validateWithCommas("500,000").valid, true);
  });

  test("honours custom bounds (HooshPay uses 10,000 – 50,000,000)", () => {
    assert.equal(validateWithCommas("50,000,001", 10000, 50000000).valid, false);
    assert.equal(validateWithCommas("50,000,000", 10000, 50000000).valid, true);
    assert.equal(validateWithCommas("9,999", 10000, 50000000).valid, false);
    assert.equal(validateWithCommas("10,000", 10000, 50000000).valid, true);
  });

  test("rejects empty, whitespace and non-numeric input", () => {
    for (const t of ["", " ", "abc", "1,00a", "-5,000", "١٢٣"]) {
      assert.equal(validateWithCommas(t).valid, false, `${JSON.stringify(t)} should be invalid`);
    }
  });

  test("returns an HTML-formatted message on rejection", () => {
    const r = validateWithCommas("nope");
    assert.equal(r.valid, false);
    assert.equal(r.parse_mode, "HTML");
    assert.ok(r.message.length > 0);
  });

  test("rejects values that are numeric but not integers", () => {
    assert.equal(validateWithCommas("10,000.50").valid, false);
  });
});

describe("validateWithCommasTrx (real implementation)", () => {
  test("accepts valid TRX top-up amounts", () => {
    const r = validateWithCommasTrx("50,000");
    assert.equal(r.valid, true);
    assert.equal(r.amount, 50000);
  });

  test("rejects malformed input", () => {
    for (const t of ["", "abc", "5000", "50,00"]) {
      assert.equal(validateWithCommasTrx(t).valid, false, `${t} should be invalid`);
    }
  });
});
