/**
 * Telegram checkout driven by the admin catalog, end to end against a REAL test MongoDB and a LOCAL stub of the
 * WizardXray provider (fake key, loopback only, no real payments): menu -> plan -> confirm -> wallet debit ->
 * provider call -> service recorded, then catalog edits and their effect on the next purchase.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

process.env.NODE_ENV = "test";
process.env.ADMINS = "424242";
process.env.GROUP_ID = "";

const wizardCalls = [];
let wizard;
wizard = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    wizardCalls.push({ url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { username: `stub_${wizardCalls.length}_${Math.random().toString(36).slice(2, 7)}`, hash: "abc123hash", sub_link: "https://panel.example.test/sub/abc123hash", tak_links: ["vless://stub@example.com:443"] } }));
  });
});
await new Promise((resolve) => wizard.listen(0, "127.0.0.1", resolve));
process.env.WIZARD_API_URL = `http://127.0.0.1:${wizard.address().port}`;
process.env.VPN_API_KEY = "fake-test-key-never-a-real-credential";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = "424242";

let User, WalletPurchase, products, plans, handleCallbackQuery;
if (dbAvailable) {
  ({ default: User } = await import("../../models/User.js"));
  ({ default: WalletPurchase } = await import("../../models/WalletPurchase.js"));
  products = await import("../../services/admin/products.js");
  plans = await import("../../services/plans.js");
  ({ default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js"));
}

before(async () => { if (dbAvailable) await plans.seedDefaultProducts(); });
after(async () => {
  await new Promise((resolve) => wizard.close(resolve));
  await disconnectTestDB();
});

const opId = () => `op-${Math.random().toString(36).slice(2, 14)}${Date.now().toString(36)}`;
const CHAT = 880001;
const press = (bot, data, messageId = 10) => handleCallbackQuery(bot, {
  id: `q_${Math.random().toString(36).slice(2)}`,
  message: { chat: { id: CHAT, type: "private" }, message_id: messageId },
  from: { id: CHAT },
  data,
});
const texts = (bot) => bot.sent.map((entry) => String(entry.text || entry.opts?.text || "")).join("\n");

describe("Telegram checkout from the admin catalog (stub provider)", () => {
  skip("an admin-created plan is listed, confirmed, charged at its catalog price and provisioned with its terms", async () => {
    const plan = (await products.createProduct({ actorId: ADMIN, operationId: opId(), input: { name: "E2E 77GB", durationDays: 30, trafficGb: 77, priceToman: 33_000, costToman: 20_000, enabled: true } })).product;
    await User.create({ telegramId: String(CHAT), balance: 100_000 });

    const menu = makeBotStub();
    await press(menu, "duration_30");
    assert.match(JSON.stringify([...menu.sent].reverse().find((e) => e.opts?.reply_markup)?.opts.reply_markup), new RegExp(`plan_${plan.id}`));

    const confirm = makeBotStub();
    await press(confirm, `plan_${plan.id}`);
    assert.match(texts(confirm), /33,000 تومان/);
    assert.match(texts(confirm), /77 گیگ/);

    wizardCalls.length = 0;
    const order = makeBotStub();
    await press(order, `confirm_order_${plan.id}`, 11);
    const params = new URLSearchParams(wizardCalls[0].body);
    assert.equal(params.get("gig"), "77");
    assert.equal(params.get("day"), "30");
    const user = await User.findOne({ telegramId: String(CHAT) });
    assert.equal(user.balance, 67_000, "debited exactly the catalog price");
    assert.equal(user.services.length, 1);
    const purchase = await WalletPurchase.findOne({ telegramId: String(CHAT), planId: plan.id });
    assert.equal(purchase.status, "completed");
    assert.equal(purchase.amount, 33_000);
    assert.equal(purchase.planName, "E2E 77GB");

    // Price edit applies to new purchases only; the finished order keeps its snapshot.
    await products.updateProduct({ actorId: ADMIN, operationId: opId(), productId: plan.id, input: { priceToman: 50_000, name: "Renamed" } });
    const repriced = makeBotStub();
    await press(repriced, `plan_${plan.id}`);
    assert.match(texts(repriced), /50,000 تومان/);
    const kept = await WalletPurchase.findOne({ purchaseId: purchase.purchaseId });
    assert.equal(kept.amount, 33_000);
    assert.equal(kept.planName, "E2E 77GB");

    // Disabling stops new purchases through a stale confirm button; the provider is not called and nothing is debited.
    await products.setProductEnabled({ actorId: ADMIN, operationId: opId(), productId: plan.id, enabled: false });
    wizardCalls.length = 0;
    const stale = makeBotStub();
    await press(stale, `confirm_order_${plan.id}`, 12);
    assert.match(texts(stale), /این پلن در حال حاضر فعال نیست یا حذف شده است/);
    assert.equal(wizardCalls.length, 0);
    assert.equal((await User.findOne({ telegramId: String(CHAT) })).balance, 67_000);
    assert.equal((await User.findOne({ telegramId: String(CHAT) })).services.length, 1, "existing service untouched");
  });
});
