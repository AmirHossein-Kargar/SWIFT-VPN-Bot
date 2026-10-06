/**
 * Customer shop presentation boundary (REAL callbacks, optionally REAL MongoDB).
 * The customer catalog is the centralized selling-plan configuration and is
 * intentionally independent from the AdminProduct management catalog.
 */
import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB, makeBotStub } from "../helpers/db.js";

process.env.ADMINS = "920001";

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);

let handleBuyService;
let handleCallbackQuery;
let AdminProduct;
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

function query(data) {
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

describe("customer plan menu is server-configured", () => {
  skip("renders only the four durations in the customer selling-plan configuration", async () => {
    await AdminProduct.create([
      { productId: "admin45", name: "Admin 45 day product", durationDays: 45, trafficGb: 20, priceToman: 1, costToman: 0, enabled: true, displayOrder: 0 },
      { productId: "admin180", name: "Admin 180 day product", durationDays: 180, trafficGb: 20, priceToman: 1, costToman: 0, enabled: true, displayOrder: 1 },
    ]);
    const bot = makeBotStub();
    await handleBuyService(bot, CHAT);
    const keyboard = lastKeyboard(bot);
    for (const days of [1, 7, 15, 30]) assert.match(keyboard, new RegExp(`duration_${days}`));
    assert.doesNotMatch(keyboard, /duration_45|duration_180/);
  });

  skip("duration and plan selection ignore AdminProduct changes and show central customer prices", async () => {
    await AdminProduct.create([
      { productId: "mini", name: "Tampered customer plan", durationDays: 7, trafficGb: 500, priceToman: 1, costToman: 0, enabled: true, displayOrder: 0 },
      { productId: "extra", name: "Extra admin plan", durationDays: 7, trafficGb: 5, priceToman: 2, costToman: 0, enabled: true, displayOrder: 1 },
    ]);

    const listBot = makeBotStub();
    await handleCallbackQuery(listBot, query("duration_7"));
    const list = lastKeyboard(listBot);
    assert.match(list, /plan_mini/);
    assert.doesNotMatch(list, /plan_extra/);
    assert.match(list, /25,000/);
    assert.doesNotMatch(list, /Tampered customer plan|500/);

    const confirmBot = makeBotStub();
    await handleCallbackQuery(confirmBot, query("plan_mini"));
    const confirmation = confirmBot.sent.find((entry) => entry.kind === "edit")?.text || "";
    assert.match(confirmation, /7 روز/);
    assert.match(confirmation, /5 گیگ/);
    assert.match(confirmation, /25,000 تومان/);
  });

  skip("unknown admin-only products and unsupported durations are rejected", async () => {
    await AdminProduct.create([
      { productId: "admin45", name: "Admin 45 day product", durationDays: 45, trafficGb: 20, priceToman: 1, costToman: 0, enabled: true, displayOrder: 0 },
    ]);
    const disabledPlanBot = makeBotStub();
    await handleCallbackQuery(disabledPlanBot, query("plan_admin45"));
    const rejected = disabledPlanBot.sent.some((entry) =>
      /این پلن در حال حاضر فعال نیست یا حذف شده است/.test(String(entry.text || entry.opts?.text || "")));
    assert.ok(rejected);

    const durationBot = makeBotStub();
    await handleCallbackQuery(durationBot, query("duration_45"));
    assert.ok(durationBot.sent.some((entry) => /پلن فعالی برای این مدت زمان موجود نیست/.test(String(entry.text || entry.opts?.text || ""))));
  });

  skip("hostile duration values are rejected without touching the plan config", async () => {
    for (const hostile of ["duration_abc", "duration_-1", "duration_0", "duration_99999", "duration_30;drop"]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, query(hostile));
      const warned = bot.sent.some((entry) => /مدت زمان نامعتبر/.test(String(entry.opts?.text || entry.text || "")));
      assert.ok(warned, `hostile duration rejected: ${hostile}`);
    }
  });
});
