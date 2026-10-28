/**
 * Tracked-VPN active/expired counts against a REAL MongoDB.
 *
 * knownVpnCounts() used to run two aggregations over the same completed orders;
 * it now splits them in one pass. The expected values here come from the
 * definition (expiry = expiresAt, else completion/creation time + days), not
 * from the pipeline, so a boundary or exclusion slip fails the test.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let WalletPurchase, knownVpnCounts, revenueForPeriod;
if (dbAvailable) {
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  ({ knownVpnCounts, revenueForPeriod } = await import("../../services/admin/dashboard.js"));
}

const DAY = 86_400_000;
const NOW = new Date("2026-06-15T12:00:00.000Z");
let sequence = 0;
const order = (fields) => ({
  purchaseId: `pu-${sequence++}`, telegramId: "9001", planId: "p1", planName: "Plan", gig: 10, days: 30, amount: 100_000,
  status: "completed", revokedAt: null, expiresAt: null, completedAt: null, createdAt: new Date(NOW.getTime() - 100 * DAY), ...fields,
});

describe("dashboard tracked VPN counts", () => {
  before(async () => {
    if (!dbAvailable) return;
    await WalletPurchase.collection.insertMany([
      order({ expiresAt: new Date(NOW.getTime() + DAY) }),                          // active: explicit expiry
      order({ expiresAt: new Date(NOW.getTime() + 1) }),                            // active: one millisecond left
      order({ expiresAt: new Date(NOW.getTime() - DAY) }),                          // expired: explicit expiry
      order({ expiresAt: NOW }),                                                    // expired: exactly now is not "after now"
      order({ completedAt: new Date(NOW.getTime() - 10 * DAY), days: 30 }),         // active: completion + 30 days
      order({ completedAt: new Date(NOW.getTime() - 40 * DAY), days: 30 }),         // expired: completion + 30 days
      order({ createdAt: new Date(NOW.getTime() - 5 * DAY), days: 30 }),            // active: no completedAt, falls back to creation
      order({ createdAt: new Date(NOW.getTime() - 50 * DAY), days: 30 }),           // expired: falls back to creation
      order({ completedAt: new Date(NOW.getTime() - 5 * DAY), days: null }),        // expired: missing days count as 0
      order({ expiresAt: new Date(NOW.getTime() + DAY), revokedAt: new Date() }),   // excluded: revoked
      order({ expiresAt: new Date(NOW.getTime() - DAY), revokedAt: new Date() }),   // excluded: revoked
      order({ status: "failed", expiresAt: new Date(NOW.getTime() + DAY) }),        // excluded: not completed
      order({ status: "refunded", expiresAt: new Date(NOW.getTime() - DAY) }),      // excluded: not completed
    ]);
  });
  after(async () => { if (dbAvailable) await disconnectTestDB(); });

  skip("splits completed, non-revoked orders into active and expired", async () => {
    assert.deepEqual(await knownVpnCounts(NOW), { active: 4, expired: 5 });
  });

  skip("every counted order lands in exactly one bucket", async () => {
    const counted = await WalletPurchase.countDocuments({ status: "completed", revokedAt: null });
    const { active, expired } = await knownVpnCounts(NOW);
    assert.equal(active + expired, counted);
  });

  skip("moving the clock moves orders from active to expired", async () => {
    assert.deepEqual(await knownVpnCounts(new Date(NOW.getTime() + 2 * DAY)), { active: 2, expired: 7 });
    assert.deepEqual(await knownVpnCounts(new Date(NOW.getTime() - 500 * DAY)), { active: 9, expired: 0 });
  });

  // Intended: an order whose expiry cannot be computed (no expiresAt, and neither completedAt nor createdAt to
  // count days from) is reported in neither bucket, exactly as the original two-query version did. Counting it
  // as expired would inflate the "expired VPNs" figure with orders that have no expiry at all.
  skip("an order with no computable expiry is neither active nor expired", async () => {
    const before = await knownVpnCounts(NOW);
    await WalletPurchase.collection.insertMany([
      order({ createdAt: null, completedAt: null, expiresAt: null }),
      order({ createdAt: null, completedAt: null, expiresAt: null, days: 365 }),
    ]);
    try {
      assert.deepEqual(await knownVpnCounts(NOW), before);
      const counted = await WalletPurchase.countDocuments({ status: "completed", revokedAt: null });
      const { active, expired } = await knownVpnCounts(NOW);
      assert.equal(counted - (active + expired), 2, "exactly the two uncomputable orders fall outside both buckets");
    } finally {
      await WalletPurchase.deleteMany({ createdAt: null });
    }
  });

  skip("an empty collection yields zero counts", async () => {
    await WalletPurchase.deleteMany({});
    assert.deepEqual(await knownVpnCounts(NOW), { active: 0, expired: 0 });
    assert.equal(typeof revenueForPeriod, "function");
  });
});
