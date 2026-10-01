/**
 * Purchase flow — REAL services/buyService/orderService.js against a REAL
 * MongoDB, with the WizardXray panel replaced by a local stub HTTP server.
 *
 * Verifies the reserve → provision → commit / rollback contract:
 *   • a successful purchase deducts exactly once and records the service
 *   • a panel failure REFUNDS the reservation (no silent money loss)
 *   • a network failure REFUNDS the reservation
 *   • concurrent purchases can never drive the balance negative
 */
import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

// ── WizardXray stub (must be running before api/wizardApi.js is imported) ────
let wizard;
let wizardMode = "ok";

before(async () => {
  wizard = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/create")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (wizardMode === "destroy") {
        req.socket.destroy();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (wizardMode === "error") {
        res.end(JSON.stringify({ ok: false, error: "panel: insufficient balance" }));
        return;
      }
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            username: `stub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            hash: "abc123hash",
            tak_links: ["vless://stub@example.com:443"],
          },
        })
      );
    });
  });
  await new Promise((r) => wizard.listen(0, "127.0.0.1", r));

  process.env.WIZARD_API_URL = `http://127.0.0.1:${wizard.address().port}`;
  process.env.VPN_API_KEY = "stub-vpn-key";
  process.env.GROUP_ID = ""; // suppress admin notifications
});

after(async () => {
  if (wizard) await new Promise((r) => wizard.close(r));
  await disconnectTestDB();
});

const dbAvailable = await connectTestDB();

let User, orderService;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  orderService = (await import("../../services/buyService/orderService.js")).default;
}

const skip = () => (dbAvailable ? false : "MongoDB not reachable");
const PLAN = { id: "plan30_10", name: "test plan", days: 30, gig: 10, price: 18000 };

async function seedUser(telegramId, balance) {
  await User.updateOne(
    { telegramId: String(telegramId) },
    { $set: { balance }, $setOnInsert: {} },
    { upsert: true }
  );
}

describe("handlePlanOrder — money-safe purchase flow", () => {
  test("successful purchase deducts once and records the service", skip(), async () => {
    wizardMode = "ok";
    await seedUser("4001", 100000);
    const bot = makeBotStub();

    await orderService(bot, 4001, 4001, PLAN);

    const user = await User.findOne({ telegramId: "4001" });
    assert.equal(user.balance, 82000, "18000 deducted from 100000");
    assert.equal(user.services.length, 1, "service recorded exactly once");
    assert.equal(user.totalServices, 1);
    assert.ok(user.services[0].username.startsWith("stub_"));
    assert.ok(bot.sent.some((s) => s.kind === "photo"), "config delivered to the user");
  });

  test("insufficient balance is rejected without calling the panel", skip(), async () => {
    wizardMode = "ok";
    await seedUser("4002", 100);
    const bot = makeBotStub();

    await orderService(bot, 4002, 4002, PLAN);

    const user = await User.findOne({ telegramId: "4002" });
    assert.equal(user.balance, 100, "balance untouched");
    assert.equal(user.services.length, 0, "no service recorded");
    assert.ok(bot.texts().some((t) => t.includes("موجودی شما کافی نیست")));
  });

  test("a panel ERROR refunds the reservation (no money loss)", skip(), async () => {
    wizardMode = "error";
    await seedUser("4003", 100000);
    const bot = makeBotStub();

    await orderService(bot, 4003, 4003, PLAN);

    const user = await User.findOne({ telegramId: "4003" });
    assert.equal(user.balance, 100000, "reservation returned in full");
    assert.equal(user.services.length, 0, "no service recorded");
    wizardMode = "ok";
  });

  test("a panel NETWORK failure refunds the reservation", skip(), async () => {
    wizardMode = "destroy";
    await seedUser("4004", 100000);
    const bot = makeBotStub();

    await orderService(bot, 4004, 4004, PLAN);

    const user = await User.findOne({ telegramId: "4004" });
    assert.equal(user.balance, 100000, "reservation returned in full after a transport error");
    assert.equal(user.services.length, 0);
    wizardMode = "ok";
  });

  test("two CONCURRENT purchases cannot overspend or go negative", skip(), async () => {
    wizardMode = "ok";
    // Balance covers exactly one plan.
    await seedUser("4005", PLAN.price);
    const botA = makeBotStub();
    const botB = makeBotStub();

    await Promise.all([
      orderService(botA, 4005, 4005, PLAN),
      orderService(botB, 4005, 4005, PLAN),
    ]);

    const user = await User.findOne({ telegramId: "4005" });
    assert.equal(user.balance, 0, "balance is exactly 0, never negative");
    assert.ok(user.balance >= 0, "balance can never go negative");
    assert.equal(user.services.length, 1, "exactly one service provisioned");
    assert.equal(user.totalServices, 1);
  });

  test("a purchase does not clobber a concurrent payment credit (no lost update)", skip(), async () => {
    wizardMode = "ok";
    await seedUser("4006", 20000);

    const bot = makeBotStub();
    // Simulate a HooshPay webhook crediting the wallet mid-purchase.
    const credit = User.findOneAndUpdate(
      { telegramId: "4006" },
      { $inc: { balance: 100000 } },
      { new: true }
    );

    await Promise.all([orderService(bot, 4006, 4006, PLAN), credit]);

    const user = await User.findOne({ telegramId: "4006" });
    // 20000 + 100000 - 18000 (order of operations may vary, both must be applied)
    assert.equal(user.balance, 102000, "both the credit and the purchase deduction are preserved");
  });
});
