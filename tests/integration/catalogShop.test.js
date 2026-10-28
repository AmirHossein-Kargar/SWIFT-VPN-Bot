/**
 * Customer shop presentation boundary (REAL callbacks, optionally REAL MongoDB).
 * The bot sells from the admin product catalog: the four subscription durations
 * are fixed, plans and prices come from the products collection, and callback
 * data only ever carries a plan id that is re-resolved on the server.
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

const product = (overrides) => ({ name: "plan", durationDays: 30, trafficGb: 10, priceToman: 20_000, costToman: 0, enabled: true, displayOrder: 0, ...overrides });

describe("customer plan menu is catalog-driven", () => {
  skip("renders only the four subscription durations (30, 90, 180, 365 days)", async () => {
    await AdminProduct.create([
      product({ productId: "admin45", durationDays: 45 }),
      product({ productId: "admin60", durationDays: 60, displayOrder: 1 }),
    ]);
    const bot = makeBotStub();
    await handleBuyService(bot, CHAT);
    const keyboard = lastKeyboard(bot);
    for (const days of [30, 90, 180, 365]) assert.match(keyboard, new RegExp(`duration_${days}`));
    assert.doesNotMatch(keyboard, /duration_45|duration_60/);
  });

  skip("admin edits reach the duration list and the order confirmation", async () => {
    await AdminProduct.create([
      product({ productId: "svc_a", name: "A", trafficGb: 25, priceToman: 33_333 }),
      product({ productId: "svc_off", trafficGb: 5, priceToman: 1, enabled: false, displayOrder: 1 }),
      product({ productId: "svc_arch", trafficGb: 6, priceToman: 1, archivedAt: new Date(), displayOrder: 2 }),
    ]);

    const listBot = makeBotStub();
    await handleCallbackQuery(listBot, query("duration_30"));
    const list = lastKeyboard(listBot);
    assert.match(list, /plan_svc_a/);
    assert.match(list, /33,333/);
    assert.doesNotMatch(list, /plan_svc_off|plan_svc_arch/);

    const confirmBot = makeBotStub();
    await handleCallbackQuery(confirmBot, query("plan_svc_a"));
    const confirmation = confirmBot.sent.find((entry) => entry.kind === "edit")?.text || "";
    assert.match(confirmation, /30 روز/);
    assert.match(confirmation, /25 گیگ/);
    assert.match(confirmation, /33,333 تومان/);
  });

  skip("disabled, archived and unknown products are rejected even through stale callbacks", async () => {
    await AdminProduct.create([
      product({ productId: "svc_off", enabled: false }),
      product({ productId: "svc_arch", archivedAt: new Date(), trafficGb: 20, displayOrder: 1 }),
    ]);
    for (const data of ["plan_svc_off", "plan_svc_arch", "plan_svc_missing", "confirm_order_svc_off", "confirm_order_svc_arch"]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, query(data));
      const rejected = bot.sent.some((entry) =>
        /این پلن در حال حاضر فعال نیست یا حذف شده است/.test(String(entry.text || entry.opts?.text || "")));
      assert.ok(rejected, data);
    }

    const durationBot = makeBotStub();
    await handleCallbackQuery(durationBot, query("duration_45"));
    assert.ok(durationBot.sent.some((entry) => /پلن فعالی برای این مدت زمان موجود نیست/.test(String(entry.text || entry.opts?.text || ""))));
  });

  skip("hostile duration values are rejected without touching the catalog", async () => {
    for (const hostile of ["duration_abc", "duration_-1", "duration_0", "duration_99999", "duration_30;drop"]) {
      const bot = makeBotStub();
      await handleCallbackQuery(bot, query(hostile));
      const warned = bot.sent.some((entry) => /مدت زمان نامعتبر/.test(String(entry.opts?.text || entry.text || "")));
      assert.ok(warned, `hostile duration rejected: ${hostile}`);
    }
  });
});
