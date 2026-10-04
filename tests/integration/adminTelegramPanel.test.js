/**
 * Telegram admin panel — authorization, navigation and safe failures using a
 * bot stub. Dashboard/payment screens need MongoDB and skip when it is down.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectTestDB, disconnectTestDB } from "../helpers/db.js";
import { makeBotStub } from "../helpers/db.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
delete process.env.WIZARD_API_URL;

const dbAvailable = await connectTestDB();
const skip = (name, fn) => test(name, { skip: dbAvailable ? false : "MongoDB unavailable" }, fn);
const ADMIN = 424242;

if (dbAvailable) {
  await Promise.all(Object.values((await import("mongoose")).default.models).map((model) => model.syncIndexes()));
}

after(async () => {
  await disconnectTestDB();
});

const { handleAdminPanelCallbacks, handleAdminPanelCommand, handleAdminPanelStep } = await import("../../handlers/admin/panel.js");

function query(bot, data, { chatId = 555, chatType = "private", userId = ADMIN } = {}) {
  return {
    id: `q_${Math.random().toString(36).slice(2)}`,
    message: { chat: { id: chatId, type: chatType }, message_id: 42 },
    from: { id: userId },
    data,
  };
}

describe("authorization", () => {
  test("non-admins are denied in private chats", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:home", { userId: 111 }));
    const answers = bot.sent.filter((entry) => entry.kind === "answer");
    assert.ok(answers.some((entry) => /دسترسی مدیر تأیید نشد/.test(entry.opts?.text || "")));
    assert.equal(bot.sent.some((entry) => entry.kind === "edit"), false, "no panel rendered");
  });

  test("admins are denied outside the configured admin group", async () => {
    process.env.GROUP_ID = "-100999";
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:home", { chatType: "group", chatId: -100111 }));
    const answers = bot.sent.filter((entry) => entry.kind === "answer");
    assert.ok(answers.some((entry) => /دسترسی مدیر تأیید نشد/.test(entry.opts?.text || "")));
    process.env.GROUP_ID = "";
  });

  test("admin group access requires an allowlisted admin", async () => {
    process.env.GROUP_ID = "-100999";
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:home", { chatType: "supergroup", chatId: -100999, userId: 111 }));
    assert.ok(bot.sent.some((entry) => entry.kind === "answer" && /دسترسی مدیر تأیید نشد/.test(entry.opts?.text || "")));
    process.env.GROUP_ID = "";
  });
});

describe("navigation", () => {
  test("main menu renders with every section", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCommand(bot, { chat: { id: 555 }, from: { id: ADMIN } });
    const message = bot.sent.find((entry) => entry.kind === "message");
    assert.match(message.text, /پنل مدیریت سویفت/);
    const buttons = JSON.stringify(message.opts.reply_markup);
    for (const label of ["داشبورد", "کاربران", "پرداخت‌ها", "سرویس‌های VPN", "محصولات", "ارسال پیام همگانی", "معرفی‌ها", "بازیابی پرداخت‌ها", "گزارش عملیات", "وضعیت سیستم", "مدیریت مدیران"]) {
      assert.ok(buttons.includes(label), `missing button: ${label}`);
    }
  });

  test("adm:home renders the inline menu", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:home"));
    const edit = bot.sent.find((entry) => entry.kind === "edit");
    assert.match(edit.text, /پنل مدیریت سویفت/);
  });

  test("adm:sys renders system health without any dependency", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:sys"));
    const edit = bot.sent.find((entry) => entry.kind === "edit");
    assert.match(edit.text, /وضعیت سیستم/);
    assert.match(edit.text, /mongodb/);
    assert.match(edit.text, /redis/);
    assert.doesNotMatch(edit.text, /BOT_TOKEN|VPN_API_KEY|mongodb:\/\//);
  });

  skip("adm:dash renders live metrics", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:dash"));
    const edit = bot.sent.find((entry) => entry.kind === "edit");
    assert.match(edit.text, /داشبورد مدیریت/);
    assert.match(edit.text, /کاربران/);
  });

  skip("adm:pay renders the recovery tab first", async () => {
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:pay:recovery-required:1"));
    const edit = bot.sent.find((entry) => entry.kind === "edit");
    assert.match(edit.text, /پرداخت‌ها — 🚨 نیاز به بررسی/);
  });

  skip("adm:prod lists the shared product catalog", async () => {
    const { seedDefaultProducts } = await import("../../services/plans.js");
    await seedDefaultProducts();
    const bot = makeBotStub();
    await handleAdminPanelCallbacks(bot, query(bot, "adm:prod"));
    const edit = bot.sent.find((entry) => entry.kind === "edit");
    assert.match(edit.text, /محصولات/);
  });
});

describe("text-input steps", () => {
  test("no session → no admin-panel step is claimed", async () => {
    const bot = makeBotStub();
    const handled = await handleAdminPanelStep(bot, { chat: { id: 555, type: "private" }, from: { id: ADMIN }, text: "424242" });
    assert.equal(handled, false);
  });
});
