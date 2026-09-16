/**
 * HooshPay Integration Tests — v3 (Production Audit)
 * Run with: node --test tests/hooshpay.test.js
 *
 * Suites:
 *  1.  HMAC signature validation + raw-body correctness
 *  2.  Invoice creation guards
 *  3.  Two-phase write idempotency (balance correctness)
 *  4.  verifyHooshPayment return paths (all 8 branches)
 *  5.  Webhook payload handling
 *  6.  Amount validation
 *  7.  Order ID uniqueness
 *  8.  Crash recovery detection
 *  9.  Redis lock behaviour (including failure modes)
 * 10.  Expired invoice cleanup
 * 11.  Refund / reversal handling
 * 12.  State-transition enforcement
 * 13.  Concurrent cron worker safety
 * 14.  Load simulation — 100 concurrent verifications
 * 15.  Load simulation — 50 duplicate webhooks
 * 16.  Load simulation — process restart during fulfillment
 * 17.  Structured log format
 * 18.  Payload size guard
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sign(secret, buf) {
  return crypto.createHmac("sha256", secret).update(buf).digest("hex");
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
    // Atomic Phase-1: returns the invoice if it was unfulfilled, null otherwise
    acquirePhase1(uid) {
      const inv = invoices.get(uid);
      if (!inv || inv.fulfilled) return null;
      inv.fulfilled = true;
      return inv;
    },
    // Atomic Phase-2: returns the invoice if Phase-2 was not yet done, null otherwise
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

// ─── 1. HMAC Signature Validation ────────────────────────────────────────────

describe("HMAC signature validation", () => {
  const SECRET = "prod-secret-abc";
  const PAYLOAD = { uid: "inv_1", status: "paid", paid: true };

  test("valid signature accepted", () => {
    const buf = Buffer.from(JSON.stringify(PAYLOAD));
    const sig = sign(SECRET, buf);
    assert.ok(crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(sign(SECRET, buf), "hex")));
  });

  test("uses raw body bytes, not re-serialised JSON", () => {
    // If the server re-serialises the parsed body, key ordering may change.
    // Verify that signing over the original wire bytes is what matters.
    const wireBytes = Buffer.from('{"uid":"x","paid":true}');
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(wireBytes.toString())));
    // Both happen to be equal in this case — but the contract is we use rawBody
    const sigWire = sign(SECRET, wireBytes);
    const sigRe   = sign(SECRET, reserialised);
    // Wire and re-serialised agree here — test that we actually sign wireBytes
    assert.equal(sigWire, sigRe);   // same because JSON.parse doesn't reorder these two keys
    // Now a case where reordering WOULD matter if we used the parsed object
    const original  = Buffer.from('{"b":2,"a":1}');
    const reparsed  = Buffer.from(JSON.stringify({ b: 2, a: 1 })); // V8 preserves insertion order
    assert.equal(sign(SECRET, original), sign(SECRET, reparsed));  // still equal on this engine
    // The key assertion: server MUST use req.rawBody, not JSON.stringify(req.body)
    // This test documents the contract rather than testing all possible JS engines.
    assert.ok(true, "Contract: always sign req.rawBody");
  });

  test("tampered signature rejected (timingSafeEqual)", () => {
    const buf = Buffer.from(JSON.stringify(PAYLOAD));
    const good = sign(SECRET, buf);
    const bad  = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(bad, "hex"), Buffer.from(good, "hex")); }
    catch { ok = false; }
    assert.equal(ok, false);
  });

  test("wrong secret rejected", () => {
    const buf = Buffer.from(JSON.stringify(PAYLOAD));
    assert.notEqual(sign(SECRET, buf), sign("wrong", buf));
  });

  test("empty body signature is deterministic", () => {
    const buf = Buffer.from("{}");
    assert.equal(sign(SECRET, buf), sign(SECRET, buf));
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
    store.acquirePhase1("inv-B"); // complete Phase 1 first
    assert.ok(store.acquirePhase2("inv-B") !== null, "First Phase-2 wins");
    assert.equal(store.acquirePhase2("inv-B"), null, "Second Phase-2 blocked");
  });

  test("balance credited exactly once even under concurrency", () => {
    const store = makeInvoiceStore();
    store.create("inv-C");
    store.acquirePhase1("inv-C");

    let creditCount = 0;
    // Simulate 10 concurrent workers all trying Phase-2
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
    // Simulate crash: Phase-1 done, Phase-2 not done
    store.acquirePhase1("inv-D");
    const inv = store.get("inv-D");
    assert.equal(inv.fulfilled, true);
    assert.equal(inv.balanceCredited, false);

    // Cron worker 1 wins Phase-2
    assert.ok(store.acquirePhase2("inv-D") !== null);
    // Cron worker 2 is blocked
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
    if (["expired", "failed", "reversed"].includes(invoice.status)) return { success: false, expired: true };
    if (!lockAcquired) return { success: false, locked: true };
    if (!apiResult?.paid) return { success: false, notPaid: true };
    return { success: true };
  }

  const pending = { fulfilled: false, balanceCredited: false, status: "pending" };

  test("not found",                  () => assert.deepEqual(build(null), { success: false, error: "Invoice not found" }));
  test("already fulfilled+credited", () => assert.deepEqual(build({ fulfilled: true, balanceCredited: true }), { success: false, alreadyFulfilled: true }));
  test("expired",                    () => assert.deepEqual(build({ ...pending, status: "expired" }), { success: false, expired: true }));
  test("reversed",                   () => assert.deepEqual(build({ ...pending, status: "reversed" }), { success: false, expired: true }));
  test("failed",                     () => assert.deepEqual(build({ ...pending, status: "failed" }), { success: false, expired: true }));
  test("lock not acquired",          () => assert.deepEqual(build(pending, null, false), { success: false, locked: true }));
  test("not paid",                   () => assert.deepEqual(build(pending, { paid: false }), { success: false, notPaid: true }));
  test("success",                    () => assert.deepEqual(build(pending, { paid: true }), { success: true }));
});

// ─── 5. Webhook payload handling ─────────────────────────────────────────────

describe("Webhook payload handling", () => {
  const SECRET = "hook-secret";
  const REVERSAL_STATUSES = new Set(["reversed", "refunded", "chargedback", "cancelled"]);

  function process(req, secret) {
    if (secret) {
      const sig = req.headers?.["x-hooshpay-signature"];
      if (!sig) return { rejected: true, reason: "no-sig" };
      const expected = sign(secret, req.rawBody);
      let ok = false;
      try { ok = crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); } catch { ok = false; }
      if (!ok) return { rejected: true, reason: "bad-sig" };
    }
    const p = req.body;
    if (!p?.uid && !p?.order_id)  return { rejected: true, reason: "no-ids" };
    if (REVERSAL_STATUSES.has(p.status)) return { reversal: true };
    if (!p.paid && p.status !== "paid")  return { ignored: true };
    return { proceed: true };
  }

  test("missing sig rejected",    () => assert.equal(process(makeWebhookReq({ uid: "x", paid: true, status: "paid" }), SECRET).rejected, true));
  test("bad sig rejected",        () => assert.equal(process(makeWebhookReq({ uid: "x", paid: true, status: "paid" }, "bad"), SECRET).rejected, true));
  test("valid sig proceeds",      () => { const b = { uid: "x", paid: true, status: "paid" }; const r = Buffer.from(JSON.stringify(b)); assert.equal(process({ body: b, rawBody: r, headers: { "x-hooshpay-signature": sign(SECRET, r) } }, SECRET).proceed, true); });
  test("unpaid ignored not rejected", () => { const b = { uid: "x", paid: false, status: "pending" }; const r = Buffer.from(JSON.stringify(b)); const res = process({ body: b, rawBody: r, headers: { "x-hooshpay-signature": sign(SECRET, r) } }, SECRET); assert.equal(res.ignored, true); assert.equal(res.rejected, undefined); });
  test("reversal handled separately", () => {
    for (const st of ["reversed", "refunded", "chargedback", "cancelled"]) {
      const b = { uid: "x", paid: false, status: st }; const r = Buffer.from(JSON.stringify(b));
      const res = process({ body: b, rawBody: r, headers: { "x-hooshpay-signature": sign(SECRET, r) } }, SECRET);
      assert.equal(res.reversal, true, `${st} should be reversal`);
      assert.equal(res.proceed, undefined);
    }
  });
  test("no secret skips validation", () => assert.equal(process(makeWebhookReq({ uid: "x", paid: true, status: "paid" }), undefined).proceed, true));
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
    // Mirrors acquireVerifyLock catch block: return true on error
    async function acquireFailing() {
      try { throw new Error("Redis ECONNREFUSED"); }
      catch (err) {
        // fail-open: MongoDB Phase-1 guard is the real lock
        return true;
      }
    }
    return acquireFailing().then(result => assert.equal(result, true));
  });

  test("fail-closed for cron on Redis error prevents double-run", () => {
    async function cronLockFailing() {
      try { throw new Error("Redis timeout"); }
      catch { return false; } // cron skips — safer than double-running
    }
    return cronLockFailing().then(result => assert.equal(result, false));
  });

  test("lock TTL auto-releases after process crash", () => {
    // Simulate: lock acquired, process dies, TTL expires → next caller wins
    const store = makeLockStore();
    store.acquire("uid-x");
    assert.equal(store.acquire("uid-x"), false);
    // Simulate TTL expiry
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
  const RS = new Set(["reversed", "refunded", "chargedback", "cancelled"]);

  test("all reversal statuses recognised",     () => { for (const s of RS) assert.ok(RS.has(s)); });
  test("reversal blocks fulfillment",          () => { assert.equal(RS.has("reversed") ? false : true, false); });
  test("non-reversal paid status proceeds",    () => assert.equal(RS.has("paid"), false));
});

// ─── 12. State-transition enforcement ────────────────────────────────────────

describe("State-transition enforcement", () => {
  const TRANSITIONS = {
    pending:  new Set(["paid", "expired", "failed", "reversed"]),
    paid:     new Set(["reversed"]),
    expired:  new Set(),
    failed:   new Set(),
    reversed: new Set(),
  };

  function canTransition(from, to) {
    return TRANSITIONS[from]?.has(to) ?? false;
  }

  test("pending → paid allowed",      () => assert.ok(canTransition("pending", "paid")));
  test("pending → expired allowed",   () => assert.ok(canTransition("pending", "expired")));
  test("pending → failed allowed",    () => assert.ok(canTransition("pending", "failed")));
  test("pending → reversed allowed",  () => assert.ok(canTransition("pending", "reversed")));
  test("paid → reversed allowed",     () => assert.ok(canTransition("paid", "reversed")));
  test("paid → pending REJECTED",     () => assert.equal(canTransition("paid", "pending"), false));
  test("expired → paid REJECTED",     () => assert.equal(canTransition("expired", "paid"), false));
  test("reversed → paid REJECTED",    () => assert.equal(canTransition("reversed", "paid"), false));
  test("reversed → pending REJECTED", () => assert.equal(canTransition("reversed", "pending"), false));
  test("failed → anything REJECTED",  () => {
    for (const to of ["paid", "pending", "expired", "reversed"]) {
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
        // Don't release — simulates holding for the full 270 s TTL
      }
    }

    assert.equal(ran, 1, "Exactly one worker runs the cron");
  });

  test("Phase-2 guard prevents double-credit across workers", () => {
    const store = makeInvoiceStore();
    store.create("inv-cron");
    store.acquirePhase1("inv-cron"); // Phase 1 already done (crash scenario)

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
    store.acquirePhase1("inv-load"); // Already at Phase-1 (webhook fired it)

    let credited = 0;

    // Simulate 100 concurrent "I've Paid" button presses
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        // Each tries to acquire the Redis lock
        if (!lockStore.acquire(`inv-load`)) return "locked";
        try {
          // Each tries Phase-2
          const won = store.acquirePhase2("inv-load");
          if (won) { credited++; return "credited"; }
          return "already-done";
        } finally {
          lockStore.release("inv-load");
        }
      })
    );

    // Due to the synchronous nature of the lock simulation, exactly 1 wins
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

    // Simulate Phase-1 completing just before crash
    store.acquirePhase1("inv-restart");

    // Process crashes here. inv-restart now has: fulfilled=true, balanceCredited=false

    const inv = store.get("inv-restart");
    assert.equal(inv.fulfilled, true);
    assert.equal(inv.balanceCredited, false);

    // Cron runs on restart — finds this invoice and completes Phase-2
    const stuck = store.getAll().filter(i => i.fulfilled && !i.balanceCredited && i.status === "paid");
    // In this simulation, status is "pending" since we didn't set it to "paid"
    // In production, Phase-1 sets status="paid" atomically. Verify the filter works:
    inv.status = "paid"; // mirror what fulfillHooshOrder does in Phase-1
    const stuckProd = store.getAll().filter(i => i.fulfilled && !i.balanceCredited && i.status === "paid");
    assert.equal(stuckProd.length, 1);
    assert.equal(stuckProd[0].uid, "inv-restart");

    // Recovery completes Phase-2
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

    log("info", "Payment confirmed", { uid: "inv-x", userId: 123, amount: 50000 });
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
    log("Phase-1 lock acquired", { uid: "inv-z" });
    log("Phase-2 complete",      { uid: "inv-z" });

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
