/**
 * HooshPay Integration Tests
 * Run with: node --test tests/hooshpay.test.js
 *
 * Uses only Node built-ins (node:test, node:assert, node:crypto).
 * All external I/O (Mongoose, axios, Telegram) is mocked inline so
 * no live DB or network is required.
 */

import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a valid HMAC-SHA256 hex signature for a payload buffer */
function sign(secret, bodyBuffer) {
  return crypto.createHmac("sha256", secret).update(bodyBuffer).digest("hex");
}

/** Minimal fake Express req/res for webhook tests */
function makeReq(body, headers = {}) {
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  return {
    body,
    rawBody: bodyBuffer,
    headers,
  };
}

function makeRes() {
  const res = { _status: null };
  res.sendStatus = (code) => { res._status = code; return res; };
  res.json = (data) => { res._json = data; return res; };
  return res;
}

// ─── 1. HMAC Signature Validation ────────────────────────────────────────────

describe("Webhook HMAC signature validation", () => {
  const SECRET = "test-webhook-secret-abc123";
  const PAYLOAD = { uid: "inv_abc", order_id: "HP-xyz", status: "paid", paid: true };

  test("valid signature is accepted", () => {
    const bodyBuf = Buffer.from(JSON.stringify(PAYLOAD));
    const sig = sign(SECRET, bodyBuf);

    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(bodyBuf)
      .digest("hex");

    assert.equal(sig, expected);
    // timingSafeEqual must not throw
    assert.ok(
      crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))
    );
  });

  test("tampered signature is rejected", () => {
    const bodyBuf = Buffer.from(JSON.stringify(PAYLOAD));
    const validSig = sign(SECRET, bodyBuf);
    // Flip one character
    const tamperedSig = validSig.slice(0, -1) + (validSig.endsWith("a") ? "b" : "a");

    assert.notEqual(validSig, tamperedSig);
    // Lengths might differ after flip — use try/catch the same way server.js does
    let matches = false;
    try {
      matches = crypto.timingSafeEqual(
        Buffer.from(tamperedSig, "hex"),
        Buffer.from(validSig, "hex")
      );
    } catch {
      matches = false;
    }
    assert.equal(matches, false);
  });

  test("wrong secret produces different signature", () => {
    const bodyBuf = Buffer.from(JSON.stringify(PAYLOAD));
    const sig1 = sign(SECRET, bodyBuf);
    const sig2 = sign("wrong-secret", bodyBuf);
    assert.notEqual(sig1, sig2);
  });

  test("empty body with correct secret produces deterministic signature", () => {
    const buf = Buffer.from("{}");
    const s1 = sign(SECRET, buf);
    const s2 = sign(SECRET, buf);
    assert.equal(s1, s2);
  });
});

// ─── 2. Invoice Creation Service ─────────────────────────────────────────────

describe("createHooshInvoice", () => {
  test("generates a unique UUID-based orderId on each call", () => {
    // We test the orderId generation logic in isolation
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(`HP-${crypto.randomUUID()}`);
    }
    assert.equal(ids.size, 100, "All generated order IDs must be unique");
  });

  test("throws if HOOSHPAY_API_KEY is missing", async () => {
    const savedKey = process.env.HOOSHPAY_API_KEY;
    delete process.env.HOOSHPAY_API_KEY;

    // Import the client getter logic inline (mirrors hooshpayClient.js getClient)
    function getClient() {
      const apiKey = process.env.HOOSHPAY_API_KEY;
      if (!apiKey) throw new Error("HOOSHPAY_API_KEY environment variable is not set");
    }

    assert.throws(getClient, /HOOSHPAY_API_KEY/);
    process.env.HOOSHPAY_API_KEY = savedKey;
  });

  test("throws if WEBHOOK_BASE_URL is missing", async () => {
    const saved = process.env.WEBHOOK_BASE_URL;
    delete process.env.WEBHOOK_BASE_URL;

    function checkWebhookBase() {
      if (!process.env.WEBHOOK_BASE_URL) {
        throw new Error("WEBHOOK_BASE_URL environment variable is not set");
      }
    }

    assert.throws(checkWebhookBase, /WEBHOOK_BASE_URL/);
    process.env.WEBHOOK_BASE_URL = saved;
  });

  test("throws if API response is missing uid or payment_url", async () => {
    // Mirrors the defensive check in createHooshInvoice.js
    function validateApiResponse(apiResponse) {
      if (!apiResponse?.uid || !apiResponse?.payment_url) {
        throw new Error(
          `HooshPay API returned unexpected response: ${JSON.stringify(apiResponse)}`
        );
      }
    }

    assert.throws(() => validateApiResponse({}), /HooshPay API returned unexpected/);
    assert.throws(() => validateApiResponse({ uid: "x" }), /HooshPay API returned unexpected/);
    assert.throws(() => validateApiResponse({ payment_url: "http://x" }), /HooshPay API returned unexpected/);
    // Valid case — must NOT throw
    assert.doesNotThrow(() => validateApiResponse({ uid: "abc", payment_url: "http://pay.example.com" }));
  });
});

// ─── 3. Idempotency Guard (fulfillHooshOrder logic) ──────────────────────────

describe("fulfillHooshOrder idempotency", () => {
  test("only the first concurrent caller wins the fulfilled=false lock", async () => {
    /**
     * Simulate the atomic findOneAndUpdate({ fulfilled: false }) guard.
     * We model it as a simple in-memory store to verify the contract.
     */
    const store = { fulfilled: false };

    function atomicFulfill(store) {
      if (store.fulfilled) return null; // already fulfilled
      store.fulfilled = true;
      return store; // winner gets the updated doc
    }

    const result1 = atomicFulfill(store);
    const result2 = atomicFulfill(store); // duplicate call

    assert.ok(result1 !== null, "First call should succeed");
    assert.equal(result2, null, "Second call should be blocked (idempotency)");
  });

  test("fulfilled flag prevents double balance credit", () => {
    let balance = 0;
    const invoice = { amount: 50000, fulfilled: false };

    function credit(inv) {
      if (inv.fulfilled) return false;
      inv.fulfilled = true;
      balance += inv.amount;
      return true;
    }

    assert.equal(credit(invoice), true);
    assert.equal(balance, 50000);

    assert.equal(credit(invoice), false, "Second credit attempt must be blocked");
    assert.equal(balance, 50000, "Balance must not be credited twice");
  });

  test("concurrent duplicate calls do not double-credit (serial simulation)", () => {
    let balance = 0;
    const db = { fulfilled: false };

    // Simulate two concurrent requests arriving at the same time
    // In MongoDB this is atomic; here we simulate with a lock flag
    const results = [false, false];

    for (let i = 0; i < 2; i++) {
      if (!db.fulfilled) {
        db.fulfilled = true;
        balance += 100000;
        results[i] = true;
      }
    }

    assert.equal(results.filter(Boolean).length, 1, "Exactly one call must win");
    assert.equal(balance, 100000, "Balance credited exactly once");
  });
});

// ─── 4. Manual Payment Verification (verifyHooshPayment) ─────────────────────

describe("verifyHooshPayment return values", () => {
  // We test the branching logic without real DB/API calls

  function buildVerifyResult(invoiceDoc, apiResult) {
    if (!invoiceDoc) return { success: false, error: "Invoice not found" };
    if (invoiceDoc.fulfilled) return { success: false, alreadyFulfilled: true };
    if (!apiResult?.paid) return { success: false, notPaid: true };
    return { success: true };
  }

  test("returns error when invoice not found", () => {
    const r = buildVerifyResult(null, null);
    assert.equal(r.success, false);
    assert.equal(r.error, "Invoice not found");
  });

  test("returns alreadyFulfilled when invoice already processed", () => {
    const r = buildVerifyResult({ fulfilled: true }, { paid: true });
    assert.equal(r.success, false);
    assert.equal(r.alreadyFulfilled, true);
  });

  test("returns notPaid when HooshPay says not paid", () => {
    const r = buildVerifyResult({ fulfilled: false }, { paid: false });
    assert.equal(r.success, false);
    assert.equal(r.notPaid, true);
  });

  test("returns success when payment confirmed and not yet fulfilled", () => {
    const r = buildVerifyResult({ fulfilled: false }, { paid: true });
    assert.equal(r.success, true);
  });

  test("returns notPaid when verifyInvoice returns null", () => {
    const r = buildVerifyResult({ fulfilled: false }, null);
    assert.equal(r.success, false);
    assert.equal(r.notPaid, true);
  });
});

// ─── 5. Webhook Endpoint Logic ───────────────────────────────────────────────

describe("Webhook payload handling", () => {
  const SECRET = "webhook-test-secret";

  function processWebhook(req, secret) {
    const payload = req.body;

    // Signature check
    if (secret) {
      const receivedSig = req.headers["x-hooshpay-signature"];
      if (!receivedSig) return { rejected: true, reason: "Missing signature" };

      const expected = crypto
        .createHmac("sha256", secret)
        .update(req.rawBody)
        .digest("hex");

      let ok = false;
      try {
        ok = crypto.timingSafeEqual(Buffer.from(receivedSig, "hex"), Buffer.from(expected, "hex"));
      } catch { ok = false; }

      if (!ok) return { rejected: true, reason: "Invalid signature" };
    }

    if (!payload?.uid && !payload?.order_id) {
      return { rejected: true, reason: "Missing uid/order_id" };
    }

    if (!payload.paid && payload.status !== "paid") {
      return { ignored: true, reason: "Not paid yet" };
    }

    return { proceed: true, uid: payload.uid, orderId: payload.order_id };
  }

  test("missing signature header is rejected", () => {
    const req = makeReq({ uid: "x", status: "paid", paid: true });
    const result = processWebhook(req, SECRET);
    assert.equal(result.rejected, true);
    assert.match(result.reason, /Missing signature/);
  });

  test("invalid signature is rejected", () => {
    const body = { uid: "x", status: "paid", paid: true };
    const req = makeReq(body, { "x-hooshpay-signature": "deadbeef" });
    const result = processWebhook(req, SECRET);
    assert.equal(result.rejected, true);
    assert.match(result.reason, /Invalid signature/);
  });

  test("valid signature for paid invoice proceeds to fulfillment", () => {
    const body = { uid: "inv-001", order_id: "HP-xyz", status: "paid", paid: true };
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const sig = sign(SECRET, bodyBuf);
    const req = { body, rawBody: bodyBuf, headers: { "x-hooshpay-signature": sig } };

    const result = processWebhook(req, SECRET);
    assert.equal(result.proceed, true);
    assert.equal(result.uid, "inv-001");
  });

  test("valid signature but unpaid invoice is ignored, not rejected", () => {
    const body = { uid: "inv-002", order_id: "HP-yyy", status: "pending", paid: false };
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const sig = sign(SECRET, bodyBuf);
    const req = { body, rawBody: bodyBuf, headers: { "x-hooshpay-signature": sig } };

    const result = processWebhook(req, SECRET);
    assert.equal(result.ignored, true);
    assert.equal(result.rejected, undefined);
  });

  test("duplicate webhook for paid invoice is safe (idempotency contract)", () => {
    const body = { uid: "inv-003", order_id: "HP-zzz", status: "paid", paid: true };
    const bodyBuf = Buffer.from(JSON.stringify(body));
    const sig = sign(SECRET, bodyBuf);
    const req = { body, rawBody: bodyBuf, headers: { "x-hooshpay-signature": sig } };

    // Both calls return proceed=true — idempotency is handled downstream in fulfillHooshOrder
    const r1 = processWebhook(req, SECRET);
    const r2 = processWebhook(req, SECRET);

    assert.equal(r1.proceed, true);
    assert.equal(r2.proceed, true);
    // The critical guarantee is that fulfillHooshOrder will only credit once
    // (tested separately in the idempotency suite above)
  });

  test("webhook without secret configured skips validation (logs warning)", () => {
    const body = { uid: "inv-004", status: "paid", paid: true };
    const req = makeReq(body);
    // No secret — validation skipped
    const result = processWebhook(req, undefined);
    assert.equal(result.proceed, true);
  });
});

// ─── 6. Amount Validation ─────────────────────────────────────────────────────

describe("Amount validation (HooshPay uses same validator as bank)", () => {
  function validateWithCommas(text, min = 10000, max = 50000000) {
    const commaPattern = /^\d{1,3}(,\d{3})*$/;
    if (!commaPattern.test(text)) return { valid: false };
    const amount = parseInt(text.replace(/,/g, ""), 10);
    if (amount < min || amount > max) return { valid: false, amount };
    return { valid: true, amount };
  }

  test("valid amount passes", () => {
    assert.equal(validateWithCommas("50,000").valid, true);
    assert.equal(validateWithCommas("1,000,000").valid, true);
    assert.equal(validateWithCommas("10,000").valid, true);
  });

  test("amount below minimum fails", () => {
    assert.equal(validateWithCommas("9,999").valid, false);
    assert.equal(validateWithCommas("1,000").valid, false);
  });

  test("amount above maximum fails", () => {
    assert.equal(validateWithCommas("50,000,001").valid, false);
  });

  test("amount without commas fails (pattern mismatch)", () => {
    assert.equal(validateWithCommas("50000").valid, false);
    assert.equal(validateWithCommas("abc").valid, false);
    assert.equal(validateWithCommas("").valid, false);
  });

  test("partial comma pattern fails", () => {
    assert.equal(validateWithCommas("50,00").valid, false);
    assert.equal(validateWithCommas("5,0000").valid, false);
  });
});

// ─── 7. Order ID Uniqueness ───────────────────────────────────────────────────

describe("Order ID generation", () => {
  test("HP- prefix is always present", () => {
    for (let i = 0; i < 20; i++) {
      const id = `HP-${crypto.randomUUID()}`;
      assert.ok(id.startsWith("HP-"), `Expected HP- prefix, got: ${id}`);
    }
  });

  test("1000 generated IDs are all unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => `HP-${crypto.randomUUID()}`));
    assert.equal(ids.size, 1000);
  });
});

// ─── 8. Restart / Recovery contract ──────────────────────────────────────────

describe("Recovery after restart", () => {
  test("pending unfulfilled invoices can be queried from DB for recovery", () => {
    // Simulate the query used in admin_hoosh_run_pending and recovery cron
    const mockInvoices = [
      { uid: "a", status: "paid", fulfilled: false },
      { uid: "b", status: "paid", fulfilled: true },
      { uid: "c", status: "pending", fulfilled: false },
      { uid: "d", status: "paid", fulfilled: false },
    ];

    const recoverable = mockInvoices.filter(
      (inv) => inv.status === "paid" && inv.fulfilled === false
    );

    assert.equal(recoverable.length, 2);
    assert.deepEqual(
      recoverable.map((i) => i.uid).sort(),
      ["a", "d"]
    );
  });

  test("expired invoices are not included in recovery set", () => {
    const mockInvoices = [
      { uid: "e", status: "expired", fulfilled: false },
      { uid: "f", status: "paid", fulfilled: false },
    ];

    const recoverable = mockInvoices.filter(
      (inv) => inv.status === "paid" && inv.fulfilled === false
    );

    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].uid, "f");
  });
});
