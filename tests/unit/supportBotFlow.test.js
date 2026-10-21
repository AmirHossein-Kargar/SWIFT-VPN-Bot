/**
 * Telegram support flow: no stale "loading" message, one standing menu message,
 * callback acknowledgement, ticket routing to the admin group, admin replies
 * back to the right customer, isolation between customers, and error paths.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeSupportDeps, makeFakeBot, makeSessionClient } from "../helpers/fakeSupport.js";

process.env.ADMINS = "9001";
process.env.GROUP_ID = "-100777";
delete process.env.SUPPORT_CONTACT;
delete process.env.WEBHOOK_BASE_URL;

const { setSessionClientForTests, clearSessionClientForTests, getSession } = await import("../../config/sessionStore.js");
const tickets = await import("../../services/support/tickets.js");
const { default: handleSupport } = await import("../../handlers/message/handleSupport.js");
const { default: supportMessageHandler } = await import("../../handlers/supportMessageHandler.js");
const { handleSupportCallback } = await import("../../handlers/support/supportFlow.js");
const { handleSupportGroupReply } = await import("../../handlers/support/groupReply.js");

let deps;
let sessions;
let bot;
let nextMessageId;

beforeEach(() => {
  deps = makeSupportDeps();
  tickets.setSupportModelsForTests(deps);
  sessions = makeSessionClient();
  setSessionClientForTests(sessions);
  bot = makeFakeBot();
  nextMessageId = 500;
});

afterEach(() => {
  tickets.clearSupportModelsForTests();
  clearSessionClientForTests();
});

const customer = (id = 1001) => ({ id, first_name: "Ali", username: "ali_user" });
const privateChat = (id = 1001) => ({ id, type: "private" });
const text = (value, id = 1001) => ({ message_id: ++nextMessageId, chat: privateChat(id), from: customer(id), text: value });
const photo = (caption, id = 1001) => ({ message_id: ++nextMessageId, chat: privateChat(id), from: customer(id), photo: [{ file_id: "small" }, { file_id: "BIG", file_size: 99 }], caption });
const callback = (data, messageId = 42, id = 1001) => ({ id: `cb-${Math.random()}`, from: customer(id), data, message: { message_id: messageId, chat: privateChat(id) } });
const groupReply = (repliedTo, extra = {}, from = 9001) => ({
  message_id: ++nextMessageId, chat: { id: -100777, type: "supergroup" }, from: { id: from }, reply_to_message: { message_id: repliedTo }, ...extra,
});

async function startTicket(userId = 1001, body = "سرویس من وصل نمی‌شود") {
  await handleSupport(bot, userId, userId);
  await handleSupportCallback(bot, callback("sup_new", bot.of("sendMessage").at(-1) ? 42 : 42, userId));
  await supportMessageHandler(bot, text(body, userId));
  return deps.Ticket.docs.at(-1);
}

describe("support entry (loading-state root cause)", () => {
  test("sends exactly one menu message and never a placeholder or timer-driven follow-up", async () => {
    await handleSupport(bot, 1001, 1001);
    const sent = bot.of("sendMessage").map((call) => call.args[1]);
    assert.ok(sent.some((body) => body.includes("تیکت جدید")), "menu is sent immediately");
    assert.ok(sent.every((body) => !/بارگذاری|⌛/.test(body)), "no loading placeholder is ever sent");
    // Everything sent was sent synchronously: waiting past the old 1s timer changes nothing.
    const before = bot.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(bot.calls.length, before, "no delayed edit/delete/send after the handler returns");
  });

  test("the keyboard-hiding spinner is always removed again (send + delete pair)", async () => {
    await handleSupport(bot, 1001, 1001);
    const spinners = bot.of("sendMessage").filter((call) => call.args[1] === "⏳");
    assert.equal(spinners.length, 1);
    assert.deepEqual(spinners[0].args[2].reply_markup, { remove_keyboard: true });
    assert.ok(bot.of("deleteMessage").some((call) => call.args[1] === spinners[0].result.message_id), "spinner deleted");
  });

  test("repeated taps keep one standing menu: the previous one is deleted, one session results", async () => {
    await handleSupport(bot, 1001, 1001);
    const firstMenuId = (await getSession(1001)).supportMessageId;
    await handleSupport(bot, 1001, 1001);
    const second = await getSession(1001);
    assert.notEqual(second.supportMessageId, firstMenuId);
    assert.ok(bot.of("deleteMessage").some((call) => call.args[1] === firstMenuId), "old menu deleted");
    assert.equal(deps.Ticket.docs.length, 0, "tapping the button never creates a ticket");
    assert.equal(second.support, false, "entering the menu is not compose mode");
  });

  test("concurrent taps are serialized and still leave a single live menu", async () => {
    await Promise.all([handleSupport(bot, 1001, 1001), handleSupport(bot, 1001, 1001), handleSupport(bot, 1001, 1001)]);
    const menuIds = bot.of("sendMessage").filter((call) => call.args[1].includes("تیکت جدید")).map((call) => call.result.message_id);
    const deleted = new Set(bot.of("deleteMessage").map((call) => call.args[1]));
    const live = menuIds.filter((id) => !deleted.has(id));
    assert.equal(live.length, 1);
    assert.equal((await getSession(1001)).supportMessageId, live[0]);
  });

  test("a Telegram failure while showing the menu is reported to the user, not thrown", async () => {
    const broken = makeFakeBot({ failOn: ["sendMessage"] });
    await assert.doesNotReject(handleSupport(broken, 1001, 1001));
  });
});

describe("callback queries", () => {
  test("every sup_* callback is answered exactly once, including failures", async () => {
    for (const data of ["sup_menu", "sup_new", "sup_list", "sup_open:T-AAAAAA", "sup_close:T-AAAAAA"]) {
      const query = callback(data);
      assert.equal(await handleSupportCallback(bot, query), true);
      assert.equal(bot.of("answerCallbackQuery").filter((call) => call.args[0] === query.id).length, 1, data);
    }
  });

  test("unknown ticket / stale message produce an alert instead of a silent spinner", async () => {
    const query = callback("sup_open:T-AAAAAA");
    await handleSupportCallback(bot, query);
    const [answer] = bot.of("answerCallbackQuery").filter((call) => call.args[0] === query.id);
    assert.equal(answer.args[1].show_alert, true);

    const stale = { id: "stale", from: customer(), data: "sup_new" };
    await handleSupportCallback(bot, stale);
    assert.equal(bot.of("answerCallbackQuery").filter((call) => call.args[0] === "stale").length, 1);
  });

  test("non-support callbacks are left for other handlers", async () => {
    assert.equal(await handleSupportCallback(bot, callback("back_to_home")), false);
    assert.equal(await handleSupportCallback(bot, callback("sup_evil:../x")), false);
    assert.equal(bot.of("answerCallbackQuery").length, 0);
  });

  test("cancel (sup_menu) leaves compose mode so later text is not captured", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    assert.equal((await getSession(1001)).support, true);
    await handleSupportCallback(bot, callback("sup_menu"));
    assert.equal((await getSession(1001)).support, false);
    await supportMessageHandler(bot, text("hello"));
    assert.equal(deps.Ticket.docs.length, 0);
  });

  test("a Telegram edit failure falls back to a new message instead of leaving the old text", async () => {
    const flaky = makeFakeBot({ failOn: ["editMessageText"] });
    await handleSupportCallback(flaky, callback("sup_list"));
    assert.ok(flaky.of("sendMessage").some((call) => call.args[1].includes("تیکت")));
  });
});

describe("customer → admin group routing", () => {
  test("the first message creates a ticket and is posted to the admin group with the ticket id", async () => {
    const ticket = await startTicket();
    assert.equal(ticket.userTelegramId, "1001");
    const groupPosts = bot.of("sendMessage").filter((call) => String(call.args[0]) === "-100777");
    assert.equal(groupPosts.length, 1);
    assert.ok(groupPosts[0].args[1].includes(ticket.ticketId));
    assert.ok(groupPosts[0].args[1].includes("سرویس من وصل نمی‌شود"));
    assert.equal(groupPosts[0].args[2].parse_mode, "HTML");
    assert.equal(deps.Message.docs[0].groupMessageIds.length, 1, "group message id stored for reply routing");
  });

  test("HTML in user text is escaped in the group copy", async () => {
    await startTicket(1001, "<b>x</b> & <script>");
    const post = bot.of("sendMessage").find((call) => String(call.args[0]) === "-100777").args[1];
    assert.ok(!post.includes("<script>"));
    assert.ok(post.includes("&lt;script&gt;"));
  });

  test("follow-up messages join the same ticket; a redelivered update is not duplicated", async () => {
    const ticket = await startTicket();
    const followUp = text("و یک چیز دیگر");
    await supportMessageHandler(bot, followUp);
    await supportMessageHandler(bot, followUp);
    assert.equal(deps.Ticket.docs.length, 1);
    assert.equal(deps.Message.docs.length, 2);
    assert.equal(bot.of("sendMessage").filter((call) => String(call.args[0]) === "-100777").length, 2);
    assert.equal(ticket.ticketId, deps.Message.docs[1].ticketId);
  });

  test("photos are forwarded as photos with the ticket caption; text caption goes along", async () => {
    await handleSupport(bot, 1001, 1001);
    await handleSupportCallback(bot, callback("sup_new"));
    await supportMessageHandler(bot, photo("اینجا خطا می‌دهد"));
    const [sent] = bot.of("sendPhoto");
    assert.equal(sent.args[1], "BIG", "the largest size is used");
    assert.match(sent.args[2].caption, /T-[A-Z0-9]{6}/);
    assert.equal(deps.Message.docs[0].attachment.kind, "photo");
    assert.ok(bot.of("sendMessage").some((call) => String(call.args[0]) === "-100777" && call.args[1].includes("اینجا خطا می‌دهد")));
  });

  test("unsupported media is deleted and the user is shown the allowed types", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    await supportMessageHandler(bot, { message_id: 900, chat: privateChat(), from: customer(), voice: { file_id: "v" } });
    assert.equal(deps.Message.docs.length, 0);
    assert.ok(bot.of("deleteMessage").some((call) => call.args[1] === 900));
    assert.ok(bot.of("editMessageText").some((call) => call.args[0].includes("فایل‌های مجاز")));
  });

  test("text sent outside compose mode is ignored by the support handler", async () => {
    await supportMessageHandler(bot, text("random chatter"));
    assert.equal(deps.Message.docs.length, 0);
    assert.equal(bot.calls.length, 0);
  });

  test("compose mode expires after inactivity", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    const session = await getSession(1001);
    sessions.map.set("session:1001", JSON.stringify({ ...session, supportAt: Date.now() - 31 * 60 * 1000 }));
    await supportMessageHandler(bot, text("late message"));
    assert.equal(deps.Message.docs.length, 0);
  });

  test("when the admin group is unreachable the message is still saved and the user is told", async () => {
    const flaky = makeFakeBot({ failOn: ["sendMessage"] });
    // sendMessage fails for the group post; confirmation falls back to editMessageText.
    await handleSupportCallback(makeFakeBot(), callback("sup_new"));
    await supportMessageHandler(flaky, text("ببخشید"));
    assert.equal(deps.Message.docs.length, 1);
    assert.equal(deps.Message.docs[0].delivery, "failed");
    assert.ok(flaky.of("editMessageText").some((call) => call.args[0].includes("تأخیر")));
  });

  test("a ticket closed in the meantime tells the customer and leaves compose mode", async () => {
    const ticket = await startTicket();
    await tickets.changeStatus({ ticketId: ticket.ticketId, status: "closed", actor: { role: "admin" } });
    await supportMessageHandler(bot, text("هنوز اینجایید؟"));
    assert.equal((await getSession(1001)).support, false);
    assert.ok(bot.of("sendMessage").some((call) => String(call.args[0]) === "1001" && call.args[1].includes("بسته")));
    assert.equal(deps.Message.docs.length, 1);
  });
});

describe("admin group → customer", () => {
  async function ticketWithGroupMessage(userId = 1001) {
    const ticket = await startTicket(userId);
    const groupMessageId = deps.Message.docs.find((m) => m.ticketId === ticket.ticketId).groupMessageIds[0];
    return { ticket, groupMessageId };
  }

  test("an admin's reply is delivered to the ticket owner only, with ticket buttons", async () => {
    const mine = await ticketWithGroupMessage(1001);
    const other = await ticketWithGroupMessage(2002);
    bot.calls.length = 0;
    const handled = await handleSupportGroupReply(bot, groupReply(mine.groupMessageId, { text: "مشکل برطرف شد" }));
    assert.equal(handled, true);
    const toCustomer = bot.of("sendMessage").filter((call) => String(call.args[0]) !== "-100777");
    assert.equal(toCustomer.length, 1);
    assert.equal(String(toCustomer[0].args[0]), "1001", "delivered to ticket 1 owner");
    assert.ok(toCustomer[0].args[1].includes(mine.ticket.ticketId));
    assert.ok(!toCustomer[0].args[1].includes(other.ticket.ticketId), "no cross-ticket leakage");
    const keys = JSON.stringify(toCustomer[0].args[2].reply_markup);
    assert.ok(keys.includes(`sup_close:${mine.ticket.ticketId}`) && keys.includes("back_to_home"));
    assert.equal(deps.Ticket.docs.find((t) => t.ticketId === mine.ticket.ticketId).status, "pending");
    assert.equal(deps.Ticket.docs.find((t) => t.ticketId === other.ticket.ticketId).status, "open");
  });

  test("the same Telegram reply processed twice is delivered once", async () => {
    const { groupMessageId } = await ticketWithGroupMessage();
    const reply = groupReply(groupMessageId, { text: "یک بار" });
    await handleSupportGroupReply(bot, reply);
    await handleSupportGroupReply(bot, reply);
    assert.equal(bot.of("sendMessage").filter((call) => String(call.args[0]) === "1001" && call.args[1].includes("یک بار")).length, 1);
  });

  test("replies from non-admins and from other chats are ignored (not delivered)", async () => {
    const { groupMessageId } = await ticketWithGroupMessage();
    bot.calls.length = 0;
    assert.equal(await handleSupportGroupReply(bot, groupReply(groupMessageId, { text: "hack" }, 5555)), false);
    const elsewhere = groupReply(groupMessageId, { text: "hack" });
    elsewhere.chat = { id: -100999, type: "supergroup" };
    assert.equal(await handleSupportGroupReply(bot, elsewhere), false);
    assert.equal(bot.calls.length, 0);
  });

  test("replies to unrelated group messages fall through to normal group handling", async () => {
    assert.equal(await handleSupportGroupReply(bot, groupReply(31337, { text: "hi" })), false);
  });

  test("admin photo/video replies are delivered as media", async () => {
    const { groupMessageId } = await ticketWithGroupMessage();
    await handleSupportGroupReply(bot, groupReply(groupMessageId, { photo: [{ file_id: "ADMINPIC" }], caption: "اسکرین‌شات" }));
    const [sent] = bot.of("sendPhoto").filter((call) => String(call.args[0]) === "1001");
    assert.equal(sent.args[1], "ADMINPIC");
  });

  test("status commands (/resolve, /close) change the ticket and notify the customer", async () => {
    const { ticket, groupMessageId } = await ticketWithGroupMessage();
    await handleSupportGroupReply(bot, groupReply(groupMessageId, { text: "/resolve" }));
    assert.equal(deps.Ticket.docs[0].status, "resolved");
    await handleSupportGroupReply(bot, groupReply(groupMessageId, { text: "/close" }));
    assert.equal(deps.Ticket.docs[0].status, "closed");
    assert.ok(bot.of("sendMessage").some((call) => String(call.args[0]) === "1001" && call.args[1].includes(ticket.ticketId) && call.args[1].includes("بسته")));
  });

  test("replying to a closed ticket is refused with a clear message and nothing reaches the customer", async () => {
    const { groupMessageId } = await ticketWithGroupMessage();
    await tickets.changeStatus({ ticketId: deps.Ticket.docs[0].ticketId, status: "closed", actor: { role: "admin" } });
    bot.calls.length = 0;
    await handleSupportGroupReply(bot, groupReply(groupMessageId, { text: "late" }));
    assert.ok(bot.of("sendMessage").every((call) => String(call.args[0]) === "-100777"));
    assert.ok(bot.of("sendMessage").some((call) => call.args[1].includes("بسته")));
  });

  test("when the customer blocked the bot, the reply is saved, flagged failed, and the admin is told", async () => {
    const { groupMessageId } = await ticketWithGroupMessage();
    const blocked = makeFakeBot();
    const original = blocked.sendMessage;
    blocked.sendMessage = async (chatId, ...rest) => {
      if (String(chatId) === "1001") { blocked.calls.push({ method: "sendMessage", args: [chatId, ...rest] }); throw Object.assign(new Error("Forbidden"), { response: { statusCode: 403 } }); }
      return original(chatId, ...rest);
    };
    await handleSupportGroupReply(blocked, groupReply(groupMessageId, { text: "سلام" }));
    const adminMessage = deps.Message.docs.find((m) => m.author === "admin");
    assert.equal(adminMessage.delivery, "failed");
    assert.ok(blocked.of("sendMessage").some((call) => String(call.args[0]) === "-100777" && call.args[1].includes("ناموفق")));
  });
});

describe("customer ticket actions", () => {
  test("a customer closes their ticket from the bot and support is notified; reopen works", async () => {
    const ticket = await startTicket();
    await handleSupportCallback(bot, callback(`sup_close:${ticket.ticketId}`));
    assert.equal(deps.Ticket.docs[0].status, "closed");
    assert.ok(bot.of("sendMessage").some((call) => String(call.args[0]) === "-100777" && call.args[1].includes(ticket.ticketId)));
    await handleSupportCallback(bot, callback(`sup_reopen:${ticket.ticketId}`));
    assert.equal(deps.Ticket.docs[0].status, "open");
  });

  test("a customer cannot open, close or post to another customer's ticket via crafted callbacks", async () => {
    const theirs = await startTicket(2002);
    const query = callback(`sup_close:${theirs.ticketId}`, 42, 1001);
    await handleSupportCallback(bot, query);
    assert.equal(deps.Ticket.docs.find((t) => t.ticketId === theirs.ticketId).status, "open");
    const [answer] = bot.of("answerCallbackQuery").filter((call) => call.args[0] === query.id);
    assert.equal(answer.args[1].show_alert, true);

    const open = callback(`sup_open:${theirs.ticketId}`, 42, 1001);
    await handleSupportCallback(bot, open);
    assert.ok(!bot.of("editMessageText").some((call) => String(call.args[0]).includes(theirs.ticketId) && call.args[1].chat_id === 1001));
    assert.equal((await getSession(1001)).supportTicketId ?? null, null);
  });

  test("the ticket list shows only the caller's tickets", async () => {
    const mine = await startTicket(1001);
    const theirs = await startTicket(2002);
    bot.calls.length = 0;
    await handleSupportCallback(bot, callback("sup_list", 42, 1001));
    const edited = bot.of("editMessageText").at(-1);
    const buttons = JSON.stringify(edited.args[1].reply_markup);
    assert.ok(buttons.includes(mine.ticketId));
    assert.ok(!buttons.includes(theirs.ticketId));
  });

  test("the bot offers a web sign-in link only when a public HTTPS base URL is configured", async () => {
    await handleSupport(bot, 1001, 1001);
    assert.ok(!JSON.stringify(bot.of("sendMessage").at(-1).args[2].reply_markup).includes("sup_web"));
    process.env.WEBHOOK_BASE_URL = "https://example.test";
    try {
      bot = makeFakeBot();
      await handleSupport(bot, 1001, 1001);
      assert.ok(JSON.stringify(bot.of("sendMessage").at(-1).args[2].reply_markup).includes("sup_web"));
    } finally {
      delete process.env.WEBHOOK_BASE_URL;
    }
  });
});
