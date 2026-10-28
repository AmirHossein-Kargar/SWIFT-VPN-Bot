/**
 * Short-lived in-memory caches/guards must not grow with every distinct input
 * for the life of the process, and bounding them must not change what they
 * guard: the 60-second repeat-tap guard on invoice creation, and the NOWPayments
 * estimate cache (a hit must still avoid a provider call).
 *
 * Time travel replaces Date.now() only (see fakeClock), so these tests do not
 * depend on node:test's Date mocking, which is missing from the oldest Node 20.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeRoom, pruneExpired } from "../../utils/boundedMap.js";
import { quoteTronTopUp, resetTronQuoteCacheForTests, tronQuoteCacheSizeForTests } from "../../services/pricing/tronQuote.js";
import {
  confirmNowPaymentsTopUp,
  recentCreateGuardSizeForTests,
  resetNowPaymentsConfirmLocksForTests,
} from "../../paymentHandlers/payNowPayments.js";

const ENV = {
  NOWPAYMENTS_API_KEY: "np-test-key-0001",
  NOWPAYMENTS_IPN_SECRET: "i".repeat(40),
  NOWPAYMENTS_IPN_CALLBACK_URL: "https://pay.example.test/api/nowpayments/ipn",
};

/** Controls Date.now() (what the caches and the guard read); `new Date()` keeps the real clock. */
function fakeClock(startMs = Date.now()) {
  const real = Date.now;
  let current = startMs;
  Date.now = () => current;
  return { tick(ms) { current += ms; }, restore() { Date.now = real; } };
}

const MODULE_URL = new URL("../../utils/boundedMap.js", import.meta.url).href;
/** makeRoom runs synchronously on the event loop, so a hang is exercised in a child process with a timeout. */
function makeRoomInChild(entries, maxExpression) {
  const script = `import { makeRoom } from ${JSON.stringify(MODULE_URL)};
    const map = new Map(${JSON.stringify(entries)});
    makeRoom(map, ${maxExpression});
    console.log(JSON.stringify([...map.keys()]));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 5_000, encoding: "utf8" });
  assert.equal(run.error, undefined, `makeRoom(…, ${maxExpression}) did not finish: ${run.error?.code}`);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim());
}

describe("boundedMap helpers", () => {
  const entries = [["a", 1], ["b", 2], ["c", 3]];

  test("pruneExpired removes exactly the expired entries", () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
    pruneExpired(map, (value) => value % 2 === 0);
    assert.deepEqual([...map.keys()], ["a", "c"]);
  });

  test("pruneExpired on an empty map is a no-op", () => {
    const map = new Map();
    pruneExpired(map, () => true);
    assert.equal(map.size, 0);
  });

  test("makeRoom evicts the oldest entries until one more fits", () => {
    const map = new Map(entries);
    makeRoom(map, 3);
    assert.deepEqual([...map.keys()], ["b", "c"]);
    makeRoom(map, 5);
    assert.deepEqual([...map.keys()], ["b", "c"], "nothing is evicted below the cap");
    makeRoom(map, 1);
    assert.deepEqual([...map.keys()], [], "a cap of 1 leaves no entries, so the next set fits");
  });

  test("makeRoom with a valid positive cap behaves exactly as before, in a child process too", () => {
    assert.deepEqual(makeRoomInChild(entries, "3"), ["b", "c"]);
    assert.deepEqual(makeRoomInChild(entries, "2"), ["c"]);
    assert.deepEqual(makeRoomInChild(entries, "10"), ["a", "b", "c"]);
    assert.deepEqual(makeRoomInChild(entries, "Infinity"), ["a", "b", "c"]);
  });

  test("a zero or negative cap terminates (it used to spin forever) and empties the map", () => {
    for (const max of ["0", "-1", "-5.5", "-Infinity"]) {
      assert.deepEqual(makeRoomInChild(entries, max), [], `max ${max}, populated map`);
      assert.deepEqual(makeRoomInChild([], max), [], `max ${max}, empty map`);
    }
  });

  test("a NaN or non-numeric cap terminates and evicts nothing", () => {
    for (const max of ["NaN", "undefined", "null", '"3"', "{}"]) {
      assert.deepEqual(makeRoomInChild(entries, max), ["a", "b", "c"], `max ${max}`);
      assert.deepEqual(makeRoomInChild([], max), [], `max ${max}, empty map`);
    }
  });
});

describe("NOWPayments estimate cache", () => {
  beforeEach(() => resetTronQuoteCacheForTests());

  const echoEstimate = (calls) => async ({ path }) => {
    calls.push(path);
    const params = new URL(path, "https://x.invalid").searchParams;
    return { status: 200, data: { currency_from: params.get("currency_from"), currency_to: params.get("currency_to"), amount_from: Number(params.get("amount")), estimated_amount: 1.5 } };
  };
  const quote = (amountToman, request, env = ENV) => quoteTronTopUp({
    amountToman, payCurrency: "trx", env, enforceMinAmount: false, requireEstimate: true, request,
    now: new Date(Date.now()),
    usdtQuote: async () => ({ unit: "toman", tomanPerUsdt: 80_000, createdAt: new Date().toISOString(), source: "gheymat" }),
  });

  test("a repeated quote is served from the cache without another provider call", async () => {
    const calls = [];
    const request = echoEstimate(calls);
    const first = await quote(160_000, request);
    const second = await quote(160_000, request);
    assert.equal(calls.length, 1);
    assert.equal(first.estimatedAmount, second.estimatedAmount);
  });

  test("distinct amounts cannot grow the cache past its cap, and recent ones stay cached", async () => {
    const calls = [];
    const request = echoEstimate(calls);
    for (let i = 0; i < 700; i += 1) await quote(100_000 + i * 1_000, request);
    assert.equal(calls.length, 700);
    assert.ok(tronQuoteCacheSizeForTests() <= 500, `cache holds ${tronQuoteCacheSizeForTests()} entries`);
    await quote(100_000 + 699 * 1_000, request);
    assert.equal(calls.length, 700, "the newest entry is still a cache hit");
  });

  test("expired entries are dropped before live ones are evicted", async () => {
    const clock = fakeClock();
    try {
      const calls = [];
      const request = echoEstimate(calls);
      for (let i = 0; i < 300; i += 1) await quote(100_000 + i * 1_000, request);
      clock.tick(11 * 60_000); // past the default 10-minute quote TTL
      for (let i = 0; i < 200; i += 1) await quote(900_000 + i * 1_000, request);
      for (let i = 0; i < 100; i += 1) await quote(1_300_000 + i * 1_000, request); // reaches the cap: the 300 stale entries go first
      assert.ok(tronQuoteCacheSizeForTests() <= 300, `stale entries were pruned (size ${tronQuoteCacheSizeForTests()})`);
      const before = calls.length;
      await quote(900_000, request);
      assert.equal(calls.length, before, "live entries survived the pruning");
    } finally {
      clock.restore();
    }
  });

  test("eviction follows the last write: a refreshed entry is re-queued, the oldest write goes first", async () => {
    const clock = fakeClock();
    try {
      const calls = [];
      const request = echoEstimate(calls);
      const shortLived = { ...ENV, GHEYMAT_CACHE_TTL_SECONDS: "30" };
      const longLived = { ...ENV, GHEYMAT_CACHE_TTL_SECONDS: "3600" };
      const AMOUNT = 100_000;

      await quote(AMOUNT, request, shortLived);                                        // written first, stale after 30 s
      for (let i = 1; i <= 498; i += 1) await quote(AMOUNT + i * 1_000, request, longLived); // 498 live entries after it
      assert.equal(tronQuoteCacheSizeForTests(), 499);

      clock.tick(60_000);
      await quote(AMOUNT, request, longLived);                                         // stale -> refetched and re-written
      assert.equal(tronQuoteCacheSizeForTests(), 499, "replacing a key adds no entry");
      await quote(AMOUNT + 499_000, request, longLived);
      assert.equal(tronQuoteCacheSizeForTests(), 500);
      await quote(AMOUNT + 500_000, request, longLived);                               // at the cap: one entry must go
      assert.equal(tronQuoteCacheSizeForTests(), 500);

      const afterFill = calls.length;
      await quote(AMOUNT, request, longLived);
      assert.equal(calls.length, afterFill, "the refreshed entry survived (it was re-queued behind the others)");
      await quote(AMOUNT + 1_000, request, longLived);
      assert.equal(calls.length, afterFill + 1, "the entry with the oldest write was the one evicted");
    } finally {
      clock.restore();
    }
  });
});

describe("invoice-creation repeat-tap guard", () => {
  beforeEach(() => resetNowPaymentsConfirmLocksForTests());

  const bot = {
    async editMessageText() {}, async sendMessage() { return { message_id: 1 }; }, async deleteMessage() {}, async answerCallbackQuery() {},
  };
  const asset = { payCurrency: "ltc", ticker: "LTC", network: "LTC", currencyPrecision: 8, minAmount: null };
  const sessionFor = (chatId, amount = 50_000) => {
    const now = new Date().toISOString();
    return {
      step: "nowpayments_confirm", ownerId: chatId, messageId: 5, nowpaymentsAsset: asset, nowpaymentsAmount: amount,
      nowpaymentsQuote: { amountToman: amount, payCurrency: "ltc", ticker: "LTC", network: "LTC", currencyPrecision: 8, estimatedAmount: 0.5, tomanPerCrypto: 4_000_000, tomanPerUsdt: 80_000, quoteAt: now, confirmedAt: now },
    };
  };
  const press = (chatId, session, create) => confirmNowPaymentsTopUp(
    bot,
    { id: `cb-${chatId}`, from: { id: chatId }, message: { chat: { id: chatId }, message_id: 5 } },
    session,
    { createNowPaymentsTopUp: create },
  );
  const invoice = (chatId) => ({ orderId: `NP-aaaaaaaa-bbbb-4ccc-8ddd-${String(chatId).padStart(12, "0")}`, invoiceUrl: "https://nowpayments.io/payment/?iid=1", payAmount: 0.5, ticker: "LTC", network: "LTC" });

  test("a confirmed top-up creates exactly one invoice for a quick double tap", async () => {
    let created = 0;
    const create = async () => { created += 1; return invoice(1); };
    const session = sessionFor(77);
    await press(77, session, create);
    await press(77, session, create);
    assert.equal(created, 1);
  });

  test("finished creations do not accumulate guard entries forever", async () => {
    const clock = fakeClock();
    try {
      let created = 0;
      const create = async () => { created += 1; return invoice(created); };
      for (let chatId = 1; chatId <= 40; chatId += 1) await press(chatId, sessionFor(chatId), create);
      assert.equal(created, 40);
      assert.equal(recentCreateGuardSizeForTests(), 40, "entries inside the 60 s window are all kept");

      clock.tick(61_000);
      await press(9_999, sessionFor(9_999), create);
      assert.equal(created, 41);
      assert.equal(recentCreateGuardSizeForTests(), 1, "entries past the window are dropped on the next creation");
    } finally {
      clock.restore();
    }
  });

  test("an unresolved creation still blocks a repeat for the full window, then allows a retry", async () => {
    const clock = fakeClock();
    try {
      let created = 0;
      const ambiguous = async () => { created += 1; throw Object.assign(new Error("ambiguous"), { code: "ambiguous" }); };
      const session = sessionFor(88);
      await press(88, session, ambiguous);
      assert.equal(created, 1);
      clock.tick(30_000);
      await press(88, session, ambiguous);
      assert.equal(created, 1, "still inside the window: blocked");
      for (let chatId = 1; chatId <= 30; chatId += 1) await press(chatId, sessionFor(chatId), async () => invoice(chatId)); // other traffic prunes, but must not drop the live guard
      await press(88, session, ambiguous);
      assert.equal(created, 1, "the guard survived other creations' pruning");
      clock.tick(31_000);
      await press(88, session, ambiguous);
      assert.equal(created, 2, "after the window a retry is allowed again");
    } finally {
      clock.restore();
    }
  });
});
