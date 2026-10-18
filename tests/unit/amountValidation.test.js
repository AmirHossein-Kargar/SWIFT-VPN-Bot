/**
 * Amount validation tests — REAL utils/validationAmount.js and
 * utils/validationAmountTrx.js.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import validateWithCommas, { formatTopUpAmount, parseTopUpAmount } from "../../utils/validationAmount.js";
import validateWithCommasTrx from "../../utils/validationAmountTrx.js";

describe("validateWithCommas (real implementation)", () => {
  test("accepts properly formatted amounts inside the default range", () => {
    for (const t of ["10,000", "50,000", "120,000", "500,000"]) {
      const r = validateWithCommas(t);
      assert.equal(r.valid, true, `${t} should be valid`);
      assert.equal(r.amount, parseInt(t.replace(/,/g, ""), 10));
    }
  });

  test("accepts plain integers and rejects broken separators", () => {
    const parsed = parseTopUpAmount("50000", 10_000, 50_000_000);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.amount, 50000);
    assert.equal(formatTopUpAmount(parsed.amount), "50,000");
    assert.doesNotMatch(parsed.message || "", /با کاما/);
    assert.equal(validateWithCommas("50000").valid, true);
    assert.equal(validateWithCommas("50000").amount, 50000);
    assert.equal(validateWithCommas("5000").valid, false);
    for (const t of ["5,0000", "50,00", ",500", "50.000", "10,00,000"]) {
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
    assert.equal(validateWithCommas("50000001", 10000, 50000000).valid, false);
    assert.equal(validateWithCommas("50,000,000", 10000, 50000000).valid, true);
    assert.equal(validateWithCommas("50000000", 10000, 50000000).amount, 50_000_000);
    assert.equal(validateWithCommas("9,999", 10000, 50000000).valid, false);
    assert.equal(validateWithCommas("10000", 10000, 50000000).valid, true);
    assert.equal(validateWithCommas("500,000", 10000, 50000000).amount, 500_000);
  });

  test("rejects empty, whitespace and non-numeric input", () => {
    for (const t of ["", " ", "abc", "1,00a", "-5,000"]) {
      const rejected = validateWithCommas(t);
      assert.equal(rejected.valid, false, `${JSON.stringify(t)} should be invalid`);
      assert.doesNotMatch(rejected.message, /با کاما/);
    }
  });

  test("accepts Persian and Arabic digits without requiring commas", () => {
    assert.equal(parseTopUpAmount("۵۰۰۰۰", 10_000, 50_000_000).amount, 50_000);
    assert.equal(parseTopUpAmount("۵۰٬۰۰۰", 10_000, 50_000_000).amount, 50_000);
    assert.equal(parseTopUpAmount("٥٠٬٠٠٠", 10_000, 50_000_000).amount, 50_000);
    assert.equal(formatTopUpAmount(50_000), "50,000");
    const below = parseTopUpAmount("١٢٣", 10_000, 50_000_000);
    assert.equal(below.valid, false);
    assert.doesNotMatch(below.message, /با کاما/);
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
      const rejected = validateWithCommasTrx(t);
      assert.equal(rejected.valid, false, `${t} should be invalid`);
      assert.doesNotMatch(rejected.message, /با کاما/);
    }
    assert.equal(validateWithCommasTrx("50000").amount, 50000);
  });
});
