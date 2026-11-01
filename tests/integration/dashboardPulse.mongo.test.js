/** The dashboard's live feed against a disposable MongoDB: real figures, nothing sensitive, and no check run by a page view. */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";

process.env.ADMINS = "424242";
process.env.USER_SPEND_HOOK = "off";
delete process.env.WIZARD_API_URL;
delete process.env.VPN_API_KEY;
const ADMIN = "424242";

const dbAvailable = await connectTestDB();
after(async () => { await disconnectTestDB(); });

describe("dashboard pulse", { skip: dbAvailable ? false : "MongoDB not reachable" }, () => {
  let dashboard, WalletPurchase;
  const snapshot = (overrides = {}) => ({
    overall: { state: "healthy", reason: "Every component has recent evidence of working." },
    incidents: { openCount: 0 },
    components: [{ id: "mongodb", label: "MongoDB", state: "healthy", reason: "The last check succeeded.", evidence: "probe", details: [{ label: "Ping", value: "2 ms" }] }],
    ...overrides,
  });

  before(async () => {
    dashboard = await import("../../services/admin/dashboard.js");
    ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  });
  beforeEach(async () => {
    dashboard.resetDashboardPulseForTests();
    await WalletPurchase.deleteMany({});
  });

  const order = (id, fields = {}) => WalletPurchase.create({ purchaseId: id, telegramId: "700001", planId: "p1", planName: "Plan one", gig: 10, days: 30, amount: 20_000, status: "completed", serviceUsername: "SECRETSVC", serviceHash: "secrethash", serviceLink: "https://sub.example.test/sub/secrethash", ...fields });

  test("carries real orders, newest first, with no service link or hash", async () => {
    await order("pulse-1", { createdAt: new Date(Date.now() - 60_000) });
    await order("pulse-2", { planName: "Plan two", createdAt: new Date() });
    const pulse = await dashboard.getDashboardPulse({ actorId: ADMIN, readHealth: () => snapshot() });
    assert.deepEqual(pulse.activity.map((item) => item.title), ["Plan two", "Plan one"]);
    assert.equal(pulse.activity[0].amount, 20_000);
    assert.ok(pulse.metrics.orders.total >= 2);
    assert.doesNotMatch(JSON.stringify(pulse), /secrethash|SECRETSVC|sub\.example\.test/);
  });

  test("health is the monitor's own reading, reduced to what the page shows", async () => {
    const pulse = await dashboard.getDashboardPulse({ actorId: ADMIN, readHealth: () => snapshot() });
    assert.equal(pulse.health.state, "healthy");
    assert.deepEqual(pulse.health.components, [{ id: "mongodb", label: "MongoDB", state: "healthy", reason: "The last check succeeded." }]);
  });

  test("a monitor that has not reported is unknown, never healthy", async () => {
    const pulse = await dashboard.getDashboardPulse({ actorId: ADMIN, readHealth: () => null });
    assert.deepEqual([pulse.health.state, pulse.health.components], ["unknown", []]);
  });

  test("the expensive figures are shared for a moment, but health is always current", async () => {
    const first = await dashboard.getDashboardPulse({ actorId: ADMIN, readHealth: () => snapshot() });
    await order("pulse-3");
    const second = await dashboard.getDashboardPulse({ actorId: ADMIN, readHealth: () => snapshot({ overall: { state: "failed", reason: "MongoDB is not working." } }) });
    assert.equal(second.metrics.orders.total, first.metrics.orders.total, "cached");
    assert.equal(second.health.state, "failed", "a failure is never held back by the cache");
  });

  test("with the provider unreachable the page still works and the provider's count is empty, not zero", async () => {
    const pulse = await dashboard.getDashboardPulse({ actorId: ADMIN, readHealth: () => null });
    assert.equal(pulse.metrics.activeVpns, null);
  });

  test("only admins", async () => {
    await assert.rejects(() => dashboard.getDashboardPulse({ actorId: "5" }), { code: "forbidden" });
  });
});
