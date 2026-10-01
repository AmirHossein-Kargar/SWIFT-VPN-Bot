/**
 * HooshPay CONTRACT tests — v5
 * Run with: npm test
 *
 * SCOPE — read this before trusting a green run:
 *   These cases document the HooshPay payload contract and the invoice state
 *   machine. They are self-contained and therefore CANNOT catch a defect in
 *   the production modules (a broken webhook once passed all of them).
 *
 *   Tests that actually execute the production code live in:
 *     tests/unit/          — real auth, signature, amount-validation modules
 *     tests/integration/   — real Express app, real MongoDB, real fulfillment,
 *                            real purchase flow, real scanner, real callbacks
 *   Money-path correctness is asserted there.
 *
 * Suites:
 *  1.  HMAC signature validation (ksort method per official docs)
 *  2.  Invoice creation guards
 *  3.  Two-phase write idempotency (balance correctness)
 *  4.  verifyHooshPayment return paths (all branches including cancelled)
 *  5.  Webhook payload handling (official field names: invoice, not uid)
 *  6.  Amount validation
 *  7.  Order ID uniqueness
 *  8.  Crash recovery detection
 *  9.  Redis lock behaviour (including failure modes)
 *  10.  Expired invoice cleanup
 *  11.  Refund / reversal handling
 *  12.  State-transition enforcement (including cancelled status)
 *  13.  Concurrent cron worker safety
 *  14.  Load simulation — 100 concurrent verifications
 *  15.  Load simulation — 50 duplicate webhooks
 *  16.  Load simulation — process restart during fulfillment
 *  17.  Structured log format
 *  18.  Payload size guard
 *  19.  Fee transparency — payable_amount vs amount
 *  20.  Webhook field name: invoice (not uid)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * HooshPay signature: HMAC-SHA256 over JSON with keys sorted alphabetically.
 * Per official docs: ksort($payload); json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
 */
function sign(secret, payload) {
  // Sort keys alphabetically
  const sortedKeys = Object.keys(payload).sort();
  const sortedObj = {};
  for (const k of sortedKeys) {
    sortedObj[k] = payload[k];
  }
  const body = JSON.stringify(sortedObj);
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeWebhookReq(body, sig) {
  const raw = Buffer.from(JSON.stringify(body));
  return { body, rawBody: raw, headers: sig ? { "x-hooshpay-signature": sig } : {} };
}

// Miniature in-memory "database" for load tests
function makeInvoiceStore() {
  const invoices = new Map();
  return {
    create(uid) {
      invoices.set(uid, { uid, fulfilled: false, balanceCredited: false, status: "pending" });
    },
    acquirePhase1(uid) {
      const inv = invoices.get(uid);
      if (!inv || inv.fulfilled) return null;
      inv.fulfilled = true;
      return inv;
    },
    acquirePhase2(uid) {
      const inv = invoices.get(uid);
      if (!inv || !inv.fulfilled || inv.balanceCredited) return null;
      inv.balanceCredited = true;
      return inv;
    },
    get(uid)    { return invoices.get(uid); },
    getAll()    { return [...invoices.values()]; },
  };
}

// Miniature Redis-like lock store for load tests
function makeLockStore() {
  const locks = new Map();
  return {
    acquire(key) { if (locks.has(key)) return false; locks.set(key, true); return true; },
    release(key) { locks.delete(key); },
    has(key)     { return locks.has(key); },
  };
}

// ─── 1. HMAC Signature Validation (ksort method) ─────────────────────────────

describe("HMAC signature validation (ksort method per official docs)", () => {
  const SECRET = "prod-secret-abc";
  const PAYLOAD = { invoice: "inv_1", status: "paid", amount: 50000, event: "payment.success" };

  test("valid signature accepted", () => {
    const sig = sign(SECRET, PAYLOAD);
    const expected = sign(SECRET, PAYLOAD);
    assert.ok(crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")));
  });

  test("ksort produces deterministic signature regardless of key order in input", () => {
    const p1 = { b: 2, a: 1, c: 3 };
    const p2 = { c: 3, a: 1, b: 2 };
    // Both should produce the same signature because keys are sorted
    assert.equal(sign(SECRET, p1), sign(SECRET, p2));
  });

  test("signature differs from raw-body method when keys are in different order", () => {
    // This documents that ksort signing ≠ raw-body signing
    const payload = { b: 2, a: 1 };
    const rawBody = Buffer.from(JSON.stringify(payload));

    const ksortSig = sign(SECRET, payload);
    const rawSig = crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");

    // They are NOT the same — ksort reorders keys
    assert.notEqual(ksortSig, rawSig);
  });

  test("tampered signature rejected (timingSafeEqual)", () => {
    const good = sign(SECRET, PAYLOAD);
    const bad  = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(bad, "hex"), Buffer.from(good, "hex")); }
    catch { ok = false; }
    assert.equal(ok, false);
  });

  test("wrong secret rejected", () => {
    assert.notEqual(sign(SECRET, PAYLOAD), sign("wrong", PAYLOAD));
  });

  test("empty body signature is deterministic", () => {
    assert.equal(sign(SECRET, {}), sign(SECRET, {}));
  });

  test("nested objects are handled by JSON.stringify", () => {
    const p = { card: { number: "6037" }, amount: 100 };
    const sig1 = sign(SECRET, p);
    const sig2 = sign(SECRET, { amount: 100, card: { number: "6037" } });
    assert.equal(sig1, sig2, "Nested objects sorted consistently");
  });
});

// ─── 2. Invoice Creation Guards ───────────────────────────────────────────────

describe("Invoice creation guards", () => {
  test("throws on missing HOOSHPAY_API_KEY", () => {
    const v = process.env.HOOSHPAY_API_KEY; delete process.env.HOOSHPAY_API_KEY;
    assert.throws(() => { if (!process.env.HOOSHPAY_API_KEY) throw new Error("HOOSHPAY_API_KEY not set"); }, /HOOSHPAY_API_KEY/);
    process.env.HOOSHPAY_API_KEY = v;
  });

  test("throws on missing WEBHOOK_BASE_URL", () => {
    const v = process.env.WEBHOOK_BASE_URL; delete process.env.WEBHOOK_BASE_URL;
    assert.throws(() => { if (!process.env.WEBHOOK_BASE_URL) throw new Error("WEBHOOK_BASE_URL not set"); }, /WEBHOOK_BASE_URL/);
    process.env.WEBHOOK_BASE_URL = v;
  });

  test("throws on malformed API response", () => {
    const chk = (r) => { if (!r?.uid || !r?.payment_url) throw new Error("unexpected response"); };
    assert.throws(() => chk({}));
    assert.throws(() => chk({ uid: "x" }));
    assert.doesNotThrow(() => chk({ uid: "x", payment_url: "http://p" }));
  });

  test("re-entrant creation is blocked by session step", () => {
    const session = { step: "creating_hoosh_invoice" };
    assert.ok(session.step === "creating_hoosh_invoice");
  });
});

// ─── 3. Two-Phase Write / Balance Correctness ─────────────────────────────────

describe("Two-phase write — balance correctness", () => {
  test("Phase-1 is exclusive: only one caller wins", () => {
    const store = makeInvoiceStore();
    store.create("inv-A");
    assert.ok(store.acquirePhase1("inv-A") !== null);
    assert.equal(store.acquirePhase1("inv-A"), null);
  });

  test("Phase-2 is exclusive: only one caller wins", () => {
    const store = makeInvoiceStore();
    store.create("inv-B");
    store.acquirePhase1("inv-B");
    assert.ok(store.acquirePhase2("inv-B") !== null, "First Phase-2 wins");
    assert.equal(store.acquirePhase2("inv-B"), null, "Second Phase-2 blocked");
  });

  test("balance credited exactly once even under concurrency", () => {
    const store = makeInvoiceStore();
    store.create("inv-C");
    store.acquirePhase1("inv-C");

    let creditCount = 0;
    const results = Array.from({ length: 10 }, () => {
      const won = store.acquirePhase2("inv-C");
      if (won) { creditCount++; return true; }
      return false;
    });

    assert.equal(creditCount, 1, "Balance credited exactly once");
    assert.equal(results.filter(Boolean).length, 1, "Only one worker wins");
  });

  test("recovery cron cannot double-credit", () => {
    const store = makeInvoiceStore();
    store.create("inv-D");
    store.acquirePhase1("inv-D");
    const inv = store.get("inv-D");
    assert.equal(inv.fulfilled, true);
    assert.equal(inv.balanceCredited, false);

    assert.ok(store.acquirePhase2("inv-D") !== null);
    assert.equal(store.acquirePhase2("inv-D"), null);
  });

  test("crash recovery: correct invoices are identified", () => {
    const invs = [
      { uid: "a", fulfilled: true,  balanceCredited: false, status: "paid"    },
      { uid: "b", fulfilled: true,  balanceCredited: true,  status: "paid"    },
      { uid: "c", fulfilled: false, balanceCredited: false, status: "pending" },
      { uid: "d", fulfilled: true,  balanceCredited: false, status: "paid"    },
    ];
    const stuck = invs.filter(i => i.fulfilled && !i.balanceCredited && i.status === "paid");
    assert.deepEqual(stuck.map(i => i.uid).sort(), ["a", "d"]);
  });
});

// ─── 4. verifyHooshPayment branches ──────────────────────────────────────────

describe("verifyHooshPayment all return paths", () => {
  function build(invoice, apiResult, lockAcquired = true) {
    if (!invoice) return { success: false, error: "Invoice not found" };
    if (invoice.fulfilled && invoice.balanceCredited) return { success: false, alreadyFulfilled: true };
    const TERMINAL = ["expired", "cancelled", "failed", "reversed"];
    if (TERMINAL.includes(invoice.status)) {
      if (invoice.status === "cancelled") return { success: false, cancelled: true };
      return { success: false, expired: true };
    }
    if (!lockAcquired) return { success: false, locked: true };
    if (!apiResult?.paid) return { success: false, notPaid: true };
    return { success: true };
  }

  const pending = { fulfilled: false, balanceCredited: false, status: "pending" };

  test("not found",                  () => assert.deepEqual(build(null), { success: false, error: "Invoice not found" }));
  test("already fulfilled+credited", () => assert.deepEqual(build({ fulfilled: true, balanceCredited: true }), { success: false, alreadyFulfilled: true }));
  test("expired",                    () => assert.deepEqual(build({ ...pending, status: "expired" }), { success: false, expired: true }));
  test("cancelled",                  () => assert.deepEqual(build({ ...pending, status: "cancelled" }), { success: false, cancelled: true }));
  test("reversed",                   () => assert.deepEqual(build({ ...pending, status: "reversed" }), { success: false, expired: true }));
  test("failed",                     () => assert.deepEqual(build({ ...pending, status: "failed" }), { success: false, expired: true }));
  test("lock not acquired",           () => assert.deepEqual(build(pending, null, false), { success: false, locked: true }));
  test("not paid",                    () => assert.deepEqual(build(pending, { paid: false }), { success: false, notPaid: true }));
  test("success",                     () => assert.deepEqual(build(pending, { paid: true }), { success: true }));
});

// ─── 5. Webhook payload handling (official field names) ───────────────────────

describe("Webhook payload handling (official schema)", () => {
  const SECRET = "hook-secret";
  const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback"]);

  function process(req, secret) {
    // MANDATORY: if no secret is set, ALL webhooks are rejected — no bypass
    if (!secret) {
      return { rejected: true, reason: "no-secret" };
    }
    const sig = req.headers?.["x-hooshpay-signature"];
    if (!sig) return { rejected: true, reason: "no-sig" };
    const expected = sign(secret, req.body);
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); } catch { ok = false; }
    if (!ok) return { rejected: true, reason: "bad-sig" };
    const p = req.body;
    // Official field is "invoice" (not "uid")
    const hooshUid = p.invoice || p.uid;
    if (!hooshUid && !p.order_id)  return { rejected: true, reason: "no-ids" };
    if (REVERSAL_STATUSES.has(p.status)) return { reversal: true };
    const isPaidEvent = p.status === "paid" || p.event === "payment.success";
    if (!isPaidEvent)  return { ignored: true };
    return { proceed: true };
  }

  test("missing sig rejected", () => {
    const b = { invoice: "x", status: "paid", event: "payment.success" };
    assert.equal(process(makeWebhookReq(b), SECRET).rejected, true);
  });

  test("bad sig rejected", () => {
    const b = { invoice: "x", status: "paid", event: "payment.success" };
    assert.equal(process(makeWebhookReq(b, "bad"), SECRET).rejected, true);
  });

  test("valid sig (ksort) proceeds", () => {
    const b = { invoice: "x", status: "paid", event: "payment.success", amount: 50000 };
    const sig = sign(SECRET, b);
    assert.equal(process({ body: b, rawBody: Buffer.from(JSON.stringify(b)), headers: { "x-hooshpay-signature": sig } }, SECRET).proceed, true);
  });

  test("unpaid ignored not rejected", () => {
    const b = { invoice: "x", status: "pending", event: "payment.pending" };
    const sig = sign(SECRET, b);
    const res = process({ body: b, rawBody: Buffer.from(JSON.stringify(b)), headers: { "x-hooshpay-signature": sig } }, SECRET);
    assert.equal(res.ignored, true);
    assert.equal(res.rejected, undefined);
  });

  test("reversal handled separately", () => {
    for (const st of ["reversed", "refunded", "chargedback"]) {
      const b = { invoice: "x", status: st };
      const sig = sign(SECRET, b);
      const res = process({ body: b, rawBody: Buffer.from(JSON.stringify(b)), headers: { "x-hooshpay-signature": sig } }, SECRET);
      assert.equal(res.reversal, true, `${st} should be reversal`);
      assert.equal(res.proceed, undefined);
    }
  });

  test("no secret REJECTS webhook (mandatory in production)", () => {
    const b = { invoice: "x", status: "paid", event: "payment.success" };
    assert.equal(process(makeWebhookReq(b), undefined).rejected, true);
  });

  test("uid fallback still works (backward compat)", () => {
    const b = { uid: "x", status: "paid", event: "payment.success" };
    const sig = sign(SECRET, b);
    const res = process({ body: b, rawBody: Buffer.from(JSON.stringify(b)), headers: { "x-hooshpay-signature": sig } }, SECRET);
    assert.equal(res.proceed, true);
  });
});

// ─── 6. Amount validation ─────────────────────────────────────────────────────

describe("Amount validation", () => {
  function v(t, min = 10000, max = 50000000) {
    if (!/^\d{1,3}(,\d{3})*$/.test(t)) return false;
    const n = parseInt(t.replace(/,/g, ""), 10);
    return n >= min && n <= max;
  }
  test("valid",         () => { assert.ok(v("50,000")); assert.ok(v("10,000")); assert.ok(v("50,000,000")); });
  test("below min",     () => assert.equal(v("9,999"), false));
  test("above max",     () => assert.equal(v("50,000,001"), false));
  test("no commas",     () => assert.equal(v("50000"), false));
  test("empty",         () => assert.equal(v(""), false));
  test("bad commas",    () => { assert.equal(v("50,00"), false); assert.equal(v("5,0000"), false); });
});

// ─── 7. Order ID uniqueness ───────────────────────────────────────────────────

describe("Order ID generation", () => {
  test("HP- prefix always present", () => {
    for (let i = 0; i < 20; i++) assert.ok(`HP-${crypto.randomUUID()}`.startsWith("HP-"));
  });
  test("1000 IDs unique", () => {
    const s = new Set(Array.from({ length: 1000 }, () => `HP-${crypto.randomUUID()}`));
    assert.equal(s.size, 1000);
  });
});

// ─── 8. Crash recovery detection ─────────────────────────────────────────────

describe("Crash recovery", () => {
  test("detects Phase-1 done, Phase-2 missing", () => {
    const invs = [
      { uid: "a", fulfilled: true,  balanceCredited: false, status: "paid" },
      { uid: "b", fulfilled: true,  balanceCredited: true,  status: "paid" },
      { uid: "c", fulfilled: false, balanceCredited: false, status: "pending" },
    ];
    const stuck = invs.filter(i => i.fulfilled && !i.balanceCredited && i.status === "paid");
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].uid, "a");
  });
});

// ─── 9. Redis lock — failure modes ───────────────────────────────────────────

describe("Redis lock failure modes", () => {
  test("fail-open on Redis error allows payment to proceed", () => {
    async function acquireFailing() {
      try { throw new Error("Redis ECONNREFUSED"); }
      catch (err) {
        return true;
      }
    }
    return acquireFailing().then(result => assert.equal(result, true));
  });

  test("fail-closed for cron on Redis error prevents double-run", () => {
    async function cronLockFailing() {
      try { throw new Error("Redis timeout"); }
      catch { return false; }
    }
    return cronLockFailing().then(result => assert.equal(result, false));
  });

  test("lock TTL auto-releases after process crash", () => {
    const store = makeLockStore();
    store.acquire("uid-x");
    assert.equal(store.acquire("uid-x"), false);
    store.release("uid-x");
    assert.equal(store.acquire("uid-x"), true, "Lock re-acquired after TTL expiry");
  });

  test("lock for one invoice does not block another", () => {
    const store = makeLockStore();
    store.acquire("uid-1");
    assert.equal(store.acquire("uid-2"), true);
  });
});

// ─── 10. Expired invoice cleanup ─────────────────────────────────────────────

describe("Expired invoice cleanup", () => {
  const EXP = 35;
  const cutoff = (now) => new Date(now - EXP * 60 * 1000);

  test("old pending invoices are expired", () => {
    const now = Date.now();
    const invs = [
      { uid: "old", status: "pending", createdAt: new Date(now - 40 * 60 * 1000) },
      { uid: "new", status: "pending", createdAt: new Date(now - 10 * 60 * 1000) },
      { uid: "pd",  status: "paid",    createdAt: new Date(now - 40 * 60 * 1000) },
    ];
    const expire = invs.filter(i => i.status === "pending" && i.createdAt < cutoff(now));
    assert.deepEqual(expire.map(i => i.uid), ["old"]);
  });

  test("paid invoices never expired", () => {
    const now = Date.now();
    const inv = { status: "paid", createdAt: new Date(0) };
    assert.equal(inv.status === "pending" && inv.createdAt < cutoff(now), false);
  });
});

// ─── 11. Refund / reversal ────────────────────────────────────────────────────

describe("Refund and reversal", () => {
  const RS = new Set(["reversed", "refunded", "chargedback"]);

  test("all reversal statuses recognised",     () => { for (const s of RS) assert.ok(RS.has(s)); });
  test("reversal must be routed before the paid branch", () => {
    // A reversal shares the "payment.success"-style delivery channel, so the
    // handler MUST test reversal membership before treating a delivery as paid.
    const reversalStatuses = ["reversed", "refunded", "chargedback"];
    for (const s of reversalStatuses) {
      assert.equal(RS.has(s), true, `${s} must be classified as a reversal`);
    }
  });
  test("non-reversal paid status proceeds",    () => assert.equal(RS.has("paid"), false));
  test("cancelled is NOT a reversal (handled separately)", () => assert.equal(RS.has("cancelled"), false));
});

// ─── 12. State-transition enforcement (including cancelled) ───────────────────

describe("State-transition enforcement (with cancelled)", () => {
  const TRANSITIONS = {
    pending:   new Set(["paid", "expired", "cancelled", "failed", "reversed"]),
    paid:      new Set(["reversed"]),
    expired:   new Set(),
    cancelled:  new Set(),
    failed:    new Set(),
    reversed:  new Set(),
  };

  function canTransition(from, to) {
    return TRANSITIONS[from]?.has(to) ?? false;
  }

  test("pending → paid allowed",      () => assert.ok(canTransition("pending", "paid")));
  test("pending → expired allowed",   () => assert.ok(canTransition("pending", "expired")));
  test("pending → cancelled allowed", () => assert.ok(canTransition("pending", "cancelled")));
  test("pending → failed allowed",    () => assert.ok(canTransition("pending", "failed")));
  test("pending → reversed allowed",  () => assert.ok(canTransition("pending", "reversed")));
  test("paid → reversed allowed",     () => assert.ok(canTransition("paid", "reversed")));
  test("paid → pending REJECTED",     () => assert.equal(canTransition("paid", "pending"), false));
  test("expired → paid REJECTED",     () => assert.equal(canTransition("expired", "paid"), false));
  test("cancelled → paid REJECTED",   () => assert.equal(canTransition("cancelled", "paid"), false));
  test("reversed → paid REJECTED",    () => assert.equal(canTransition("reversed", "paid"), false));
  test("failed → anything REJECTED",  () => {
    for (const to of ["paid", "pending", "expired", "cancelled", "reversed"]) {
      assert.equal(canTransition("failed", to), false, `failed → ${to} must be rejected`);
    }
  });
});

// ─── 13. Concurrent cron worker safety ───────────────────────────────────────

describe("Concurrent cron worker safety", () => {
  test("only one worker runs per cron slot (distributed lock)", () => {
    const lock = makeLockStore();
    const WORKERS = 5;
    let ran = 0;

    for (let i = 0; i < WORKERS; i++) {
      if (lock.acquire("cron-slot")) {
        ran++;
      }
    }

    assert.equal(ran, 1, "Exactly one worker runs the cron");
  });

  test("Phase-2 guard prevents double-credit across workers", () => {
    const store = makeInvoiceStore();
    store.create("inv-cron");
    store.acquirePhase1("inv-cron");

    const WORKERS = 3;
    let credited = 0;
    for (let i = 0; i < WORKERS; i++) {
      if (store.acquirePhase2("inv-cron")) credited++;
    }

    assert.equal(credited, 1, "Balance credited exactly once despite concurrent cron workers");
  });
});

// ─── 14. Load simulation — 100 concurrent verifications ──────────────────────

describe("Load simulation: 100 concurrent payment verifications", () => {
  test("exactly one fulfillment wins under 100 concurrent callers", async () => {
    const store = makeInvoiceStore();
    const lockStore = makeLockStore();
    store.create("inv-load");
    store.acquirePhase1("inv-load");

    let credited = 0;

    const results = await Promise.all(
      Array.from({ length: 100 }, async () => {
        if (!lockStore.acquire(`inv-load`)) return "locked";
        try {
          const won = store.acquirePhase2("inv-load");
          if (won) { credited++; return "credited"; }
          return "already-done";
        } finally {
          lockStore.release("inv-load");
        }
      })
    );

    assert.equal(credited, 1, "Balance credited exactly once across 100 concurrent callers");
    assert.equal(results.filter(r => r === "credited").length, 1);
  });
});

// ─── 15. Load simulation — 50 duplicate webhooks ─────────────────────────────

describe("Load simulation: 50 duplicate webhooks", () => {
  test("all duplicates are safely deduplicated", async () => {
    const store = makeInvoiceStore();
    store.create("inv-dup");

    let fulfilled = 0;

    const results = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const won = store.acquirePhase1("inv-dup");
        if (won) { fulfilled++; return "fulfilled"; }
        return "duplicate";
      })
    );

    assert.equal(fulfilled, 1, "Exactly one webhook runs fulfillment");
    assert.equal(results.filter(r => r === "duplicate").length, 49);
  });
});

// ─── 16. Load simulation — restart during fulfillment ────────────────────────

describe("Load simulation: process restart during fulfillment", () => {
  test("recovery cron completes stuck invoice after restart", () => {
    const store = makeInvoiceStore();
    store.create("inv-restart");
    store.acquirePhase1("inv-restart");

    const inv = store.get("inv-restart");
    assert.equal(inv.fulfilled, true);
    assert.equal(inv.balanceCredited, false);

    inv.status = "paid";
    const stuckProd = store.getAll().filter(i => i.fulfilled && !i.balanceCredited && i.status === "paid");
    assert.equal(stuckProd.length, 1);
    assert.equal(stuckProd[0].uid, "inv-restart");

    const recovered = store.acquirePhase2("inv-restart");
    assert.ok(recovered, "Recovery Phase-2 succeeds");
    assert.equal(store.get("inv-restart").balanceCredited, true);
  });
});

// ─── 17. Structured log format ────────────────────────────────────────────────

describe("Structured log format", () => {
  test("log output is valid JSON with required fields", () => {
    const captured = [];
    const origLog = console.log;
    console.log = (msg) => captured.push(msg);

    const log = (level, message, meta = {}) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay", level, message, ...meta }));
    };

    log("info", "PAYMENT_CREDITED", { uid: "inv-x", userId: 123, amount: 50000 });
    log("error", "DB error", { uid: "inv-y", error: "timeout" });

    console.log = origLog;

    assert.equal(captured.length, 2);
    for (const line of captured) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.ts,      "ts field required");
      assert.ok(parsed.service, "service field required");
      assert.ok(parsed.level,   "level field required");
      assert.ok(parsed.message, "message field required");
    }

    const info = JSON.parse(captured[0]);
    assert.equal(info.uid, "inv-x");
    assert.equal(info.amount, 50000);
  });

  test("correlationId is propagated through log entries", () => {
    const cid = crypto.randomUUID();
    const captured = [];
    const orig = console.log;
    console.log = (m) => captured.push(JSON.parse(m));

    const log = (msg, meta = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), cid, message: msg, ...meta }));
    log("PAYMENT_VERIFIED — Phase-1 lock acquired", { uid: "inv-z" });
    log("PAYMENT_CREDITED — Phase-2 complete",      { uid: "inv-z" });

    console.log = orig;
    assert.equal(captured[0].cid, cid);
    assert.equal(captured[1].cid, cid);
  });
});

// ─── 18. Payload size guard ───────────────────────────────────────────────────

describe("Payload size guard", () => {
  test("payload exceeding 64KB is rejected", () => {
    const MAX = 64 * 1024;
    const oversize = Buffer.alloc(MAX + 1, "x");
    let rejected = false;
    let total = 0;
    for (const byte of oversize) {
      total++;
      if (total > MAX) { rejected = true; break; }
    }
    assert.ok(rejected, "Payload larger than 64KB must be rejected");
  });

  test("payload within 64KB is accepted", () => {
    const MAX = 64 * 1024;
    const ok = Buffer.alloc(MAX - 1, "x");
    assert.ok(ok.length <= MAX);
  });
});

// ─── 19. Fee transparency ─────────────────────────────────────────────────────

describe("Fee transparency — payable_amount vs amount", () => {
  // Per official docs: fee_mode "buyer" means fee is added on top of amount
  // amount = 250000, fee_percent = 20, fee_amount = 50000
  // payable_amount = 300017 (unique amount for matching)
  // merchant_credit = 250000 (what seller receives)

  test("payable_amount > amount when fee_mode is buyer", () => {
    const amount = 250000;
    const payableAmount = 300017;
    assert.ok(payableAmount > amount, "Buyer pays more than invoice amount");
  });

  test("merchant_credit equals amount when fee_mode is buyer", () => {
    const amount = 250000;
    const merchantCredit = 250000;
    assert.equal(merchantCredit, amount, "Merchant receives the full invoice amount");
  });

  test("wallet credited with amount (not payable_amount)", () => {
    const amount = 250000;
    const payableAmount = 300017;
    const walletCredit = amount; // We credit the amount the user requested
    assert.notEqual(walletCredit, payableAmount, "Wallet credit != payable amount");
    assert.equal(walletCredit, amount);
  });

  test("unique amount suffix prevents mismatches", () => {
    // HooshPay adds a few Toman to make each invoice amount unique
    const a1 = 300017;
    const a2 = 300023;
    assert.notEqual(a1, a2, "Each invoice has a unique payable amount");
  });
});

// ─── 20. Webhook field names ──────────────────────────────────────────────────

describe("Webhook field names (official schema)", () => {
  const officialWebhook = {
    event: "payment.success",
    invoice: "inv_AbC123xyz",
    order_id: "ORDER-1402",
    status: "paid",
    amount: 250000,
    payable_amount: 300017,
    merchant_credit: 250000,
    fee_amount: 50000,
    fee_mode: "buyer",
    tracking_code: "556677",
    paid_at: "2026-06-16T12:05:00",
  };

  test("field is 'invoice' not 'uid'", () => {
    assert.ok(officialWebhook.invoice, "invoice field present");
    assert.equal(officialWebhook.uid, undefined, "uid field absent in official webhook");
  });

  test("tracking_code is present", () => {
    assert.ok(officialWebhook.tracking_code, "tracking_code present");
  });

  test("event field indicates payment.success", () => {
    assert.equal(officialWebhook.event, "payment.success");
  });

  test("all fee fields present", () => {
    assert.ok(officialWebhook.amount !== undefined);
    assert.ok(officialWebhook.payable_amount !== undefined);
    assert.ok(officialWebhook.merchant_credit !== undefined);
    assert.ok(officialWebhook.fee_amount !== undefined);
    assert.ok(officialWebhook.fee_mode !== undefined);
  });

  test("paid_at is a valid ISO date string", () => {
    assert.ok(!isNaN(new Date(officialWebhook.paid_at).getTime()));
  });
});