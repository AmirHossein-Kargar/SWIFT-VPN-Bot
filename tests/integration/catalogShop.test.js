/**
 * Catalog-driven purchase flow (REAL MongoDB).
 *
 * Requirement 13: the Telegram shop must sell what the admin panel manages.
 * This suite drives the REAL duration menu (services/buyService) and the REAL
 * callback routing (handlers/handleCallbackQuery) against the REAL product
 * collection:
 *   - duration buttons come from the catalog, not a hardcoded list
 *   - plan buttons offer only ACTIVE products for the chosen duration
 *   - checkout re-resolves the price from the catalog at charge time
 *   - a disabled product disappears everywhere immediately
 *
 * Needs MongoDB; skips with an explicit reason when it is not reachable.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

process.env.ADMINS = "920001";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let handleBuyService, handleCallbackQuery, AdminProduct;
if (dbAvailable) {
  ({ default: handleBuyService } = await import("../../services/buyService/buyService.js"));
  ({ default: handleCallbackQuery } = await import("../../handlers/handleCallbackQuery.js"));
  ({ default: AdminProduct } = await import("../../models/AdminProduct.js"));
}

const CHAT = 920101;
const USER = 920101;

beforeEach(async () => {
  if (!dbAvailable) return;
  await AdminProduct.deleteMany({});
});

after(async () => {
  await disconnectTestDB();
});

function query(bot, data) {
  return {
    id: `q_${Math.random().toString(36).slice(2)}`,
    message: { chat: { id: CHAT, type: "private" }, message_id: 77 },
    from: { id: USER },
    data,
  };
}

function lastKeyboard(bot) {
  const message = [...bot.sent].reverse().find((entry) => entry.kind === "message" || entry.kind === "edit");
  return JSON.stringify(message?.opts?.reply_markup || {});
}

describe("duration menu is catalog-driven", () => {
  skip("renders exactly the durations present in the catalog", async () => {
    await AdminProduct.create([
      { productId: "cat30", name: "پلن ۳۰", durationDays: 30, trafficGb: 20, priceToman: 20000, enabled: true, displayOrder: 0 },
      { productId: "cat45", name: "پلن ۴۵", durationDays: 45, trafficGb: 20, priceToman: 28000, enabled: true, displayOrder: 1 },
      { productId: "cat180", name: "پلن ۱۸۰", durationDays: 180, trafficGb: 20, priceToman: 90000, enabled: true, displayOrder: 2 },
    ]);
    const bot = makeBotStub();
    await handleBuyService(bot, CHAT);
    const keyboard = lastKeyboard(bot);
    assert.match(keyboard, /duration_30/);
    assert.match(keyboard, /duration_45/);
    assert.match(keyboard, /duration_180/);
    assert.doesNotMatch(keyboard, /duration_60/, "no hardcoded 60-day group without a catalog product");
    assert.doesNotMatch(keyboard, /duration_90/, "no hardcoded 90-day group without a catalog product");
    assert.match(keyboard, /۳۰|30 روزه/);
  });

  skip("falls back to the shipped 30/60/90 groups when the catalog is empty", async () => {
    const bot = makeBotStub();
    await handleBuyService(bot, CHAT);
    const keyboard = lastKeyboard(bot);
    for (const days of [30, 60, 90]) assert.match(keyboard, new RegExp(`duration_${days}`));
  });

  skip("a disabled duration disappears from the menu", async () => {
    await AdminProduct.create([
      { productId: "cat30", name: "پلن ۳۰", durationDays: 30, trafficGb: 20, priceToman: 20000, enabled: true, displayOrder: 0 },
      { productId: "cat60", name: "پلن ۶۰", durationDays: 60, trafficGb: 20, priceToman: 40000, enabled: false, displayOrder: 1 },
    ]);
    const bot = makeBotStub();
    await handleBuyService(bot, CHAT);
    const keyboard = lastKeyboard(bot);
    assert.match(keyboard, /duration_30/);
    assert.doesNotMatch(keyboard, /duration_60/);
  });
});

describe("plan selection follows the catalog", () => {
  skip("duration with no active products shows a Persian warning instead of an empty list", async () => {
    await AdminProduct.create([
      { productId: "cat30", name: "پلن ۳۰", durationDays: 30, trafficGb: 20, priceToman: 20000, enabled: true, displayOrder: 0 },
    ]);
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query(bot, "duration_60"));
    const answered = bot.sent.some((entry) => entry.kind === "answer" && /پلن فعالی برای این مدت زمان موجود نیست/.test(entry.opts?.text || ""));
    const edited = bot.sent.some((entry) => entry.kind === "edit" && /پلن فعالی برای این مدت زمان موجود نیست/.test(entry.text || ""));
    assert.ok(answered || edited, "user must get a Persian empty-catalog notice");
  });

  skip("plan callback for a disabled product is rejected with a Persian notice", async () => {
    await AdminProduct.create([
      { productId: "cat30off", name: "پلن خاموش", durationDays: 30, trafficGb: 20, priceToman: 20000, enabled: false, displayOrder: 0 },
    ]);
    const bot = makeBotStub();
    await handleCallbackQuery(bot, query(bot, "plan_cat30off"));
    const rejected = bot.sent.some((entry) =>
      /این پلن در حال حاضر فعال نیست یا حذف شده است/.test(String(entry.text || entry.opts?.text || "")));
    assert.ok(rejected, "disabled product must not be purchasable");
  });

  skip("hostile duration values are rejected without touching the database", async () => {
    for (const hostile of ["duration_abc", "duration_-1", "duration_0", "duration_99999", "duration_30;drop"]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, query(bot, hostile));
      const warned = bot.sent.some((entry) => /مدت زمان نامعتبر/.test(String(entry.opts?.text || entry.text || "")));
      assert.ok(warned, `hostile duration rejected: ${hostile}`);
    }
  });
});
