/**
 * Telegram support flow: no stale "loading" message, one standing menu message,
 * callback acknowledgement, routing of customer messages into the admin inbox
 * (never the group), the retired group-reply flow, the closed-ticket policy
 * (final, no reopen), isolation between customers, and error paths.
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
const { SUPPORT_COPY, ticketCreated, messageRecorded } = await import("../../messages/supportCopy.js");

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
    assert.ok(bot.of("sendMessage").some((call) => JSON.stringify(call.args[2]?.reply_markup).includes("sup_new")), "menu is sent immediately");
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
    const menuIds = bot.of("sendMessage").filter((call) => JSON.stringify(call.args[2]?.reply_markup).includes("sup_new")).map((call) => call.result.message_id);
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

describe("customer → admin inbox routing", () => {
  const groupSends = () => bot.calls.filter((call) => ["sendMessage", "sendPhoto", "sendVideo"].includes(call.method) && String(call.args[0]) === "-100777");

  test("the first message creates a ticket for the sender and nothing is posted to the admin group", async () => {
    const ticket = await startTicket();
    assert.equal(ticket.userTelegramId, "1001");
    assert.equal(ticket.status, "open");
    assert.equal(deps.Message.docs.length, 1);
    assert.deepEqual(groupSends(), [], "conversations are handled in the panel, not the group");
    assert.deepEqual(deps.Message.docs[0].groupMessageIds, []);
  });

  test("the confirmation uses the approved Persian copy: ticket number, then where replies appear", async () => {
    const ticket = await startTicket();
    const shown = bot.of("editMessageText").at(-1).args[0];
    assert.ok(shown.includes(ticketCreated(ticket.ticketId)));
    assert.ok(shown.includes(SUPPORT_COPY.ticketCreatedHint));
  });

  test("the new-ticket prompt shows the terms notice, the instructions and only the really supported file types", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    const shown = bot.of("editMessageText").at(-1).args[0];
    for (const line of [SUPPORT_COPY.termsNotice, SUPPORT_COPY.newTicketPrompt, SUPPORT_COPY.allowedFiles]) assert.ok(shown.includes(line), line);
    assert.equal(SUPPORT_COPY.allowedFiles, "فایل‌های مجاز: متن، تصویر و ویدیو");
  });

  test("the terms button appears only when an https SUPPORT_TERMS_URL is configured", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    assert.ok(!JSON.stringify(bot.of("editMessageText").at(-1).args[1].reply_markup).includes("http"));
    for (const bad of ["http://insecure.example/terms", "javascript:alert(1)", "not a url"]) {
      process.env.SUPPORT_TERMS_URL = bad;
      await handleSupportCallback(bot, callback("sup_new"));
      assert.ok(!JSON.stringify(bot.of("editMessageText").at(-1).args[1].reply_markup).includes("http"), bad);
    }
    process.env.SUPPORT_TERMS_URL = "https://example.test/terms";
    try {
      await handleSupportCallback(bot, callback("sup_new"));
      const rows = bot.of("editMessageText").at(-1).args[1].reply_markup.inline_keyboard.flat();
      assert.ok(rows.some((button) => button.url === "https://example.test/terms" && button.text === SUPPORT_COPY.terms));
    } finally {
      delete process.env.SUPPORT_TERMS_URL;
    }
  });

  test("HTML in user text never reaches Telegram unescaped (confirmation, ticket view)", async () => {
    const ticket = await startTicket(1001, "<b>x</b> & <script>");
    await handleSupportCallback(bot, callback(`sup_open:${ticket.ticketId}`));
    for (const call of bot.of("editMessageText")) assert.ok(!call.args[0].includes("<script>"));
    assert.ok(bot.of("editMessageText").at(-1).args[0].includes("&lt;script&gt;"));
  });

  test("follow-up messages join the same ticket; a redelivered update is not duplicated", async () => {
    const ticket = await startTicket();
    const followUp = text("و یک چیز دیگر");
    await supportMessageHandler(bot, followUp);
    await supportMessageHandler(bot, followUp);
    assert.equal(deps.Ticket.docs.length, 1);
    assert.equal(deps.Message.docs.length, 2);
    assert.equal(ticket.ticketId, deps.Message.docs[1].ticketId);
    assert.ok(bot.of("editMessageText").at(-1).args[0].includes(messageRecorded(ticket.ticketId)));
  });

  test("photos are stored with the largest size and caption; nothing is forwarded anywhere", async () => {
    await handleSupport(bot, 1001, 1001);
    await handleSupportCallback(bot, callback("sup_new"));
    await supportMessageHandler(bot, photo("اینجا خطا می‌دهد"));
    assert.equal(deps.Message.docs[0].attachment.kind, "photo");
    assert.equal(deps.Message.docs[0].attachment.fileId, "BIG");
    assert.equal(deps.Message.docs[0].text, "اینجا خطا می‌دهد");
    assert.equal(bot.of("sendPhoto").length, 0);
  });

  test("an oversized file is refused with a clear message and creates no ticket", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    const huge = { message_id: 901, chat: privateChat(), from: customer(), video: { file_id: "HUGE", file_size: 50 * 1024 * 1024 }, caption: "" };
    await supportMessageHandler(bot, huge);
    assert.equal(deps.Ticket.docs.length, 0);
    assert.ok(bot.of("sendMessage").some((call) => String(call.args[0]) === "1001" && call.args[1].includes("حجم")));
  });

  test("unsupported media is deleted and the user is shown the allowed types", async () => {
    await handleSupportCallback(bot, callback("sup_new"));
    await supportMessageHandler(bot, { message_id: 900, chat: privateChat(), from: customer(), voice: { file_id: "v" } });
    assert.equal(deps.Message.docs.length, 0);
    assert.ok(bot.of("deleteMessage").some((call) => call.args[1] === 900));
    assert.ok(bot.of("editMessageText").some((call) => call.args[0].includes(SUPPORT_COPY.allowedFiles)));
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

  test("a Telegram outage while confirming does not lose the saved message", async () => {
    const flaky = makeFakeBot({ failOn: ["sendMessage", "editMessageText"] });
    await handleSupportCallback(makeFakeBot(), callback("sup_new"));
    await supportMessageHandler(flaky, text("ببخشید"));
    assert.equal(deps.Message.docs.length, 1, "persisted before any Telegram call");
  });

  test("a ticket closed in the meantime tells the customer, offers a new ticket and leaves compose mode", async () => {
    const ticket = await startTicket();
    await tickets.changeStatus({ ticketId: ticket.ticketId, status: "closed", actor: { role: "admin", id: "9001" } });
    await supportMessageHandler(bot, text("هنوز اینجایید؟"));
    assert.equal((await getSession(1001)).support, false);
    const notice = bot.of("sendMessage").filter((call) => String(call.args[0]) === "1001").at(-1);
    assert.equal(notice.args[1], SUPPORT_COPY.closed);
    assert.ok(JSON.stringify(notice.args[2].reply_markup).includes("sup_new"));
    assert.equal(deps.Message.docs.length, 1);
  });

  test("an edited Telegram message cannot add to a ticket: the bot never subscribes to edits", async () => {
    const source = (await import("node:fs")).readFileSync(new URL("../../bot.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /edited_message|edited_channel_post/);
  });
});

describe("the admin group no longer drives support", () => {
  test("an old group copy is recognised, answered with a pointer to the panel, and nothing is delivered", async () => {
    const ticket = await startTicket();
    deps.Message.docs[0].groupMessageIds = [4242];
    bot.calls.length = 0;
    for (const body of [{ text: "مشکل برطرف شد" }, { text: "/close" }, { text: "/resolve" }, { photo: [{ file_id: "ADMINPIC" }], caption: "x" }]) {
      assert.equal(await handleSupportGroupReply(bot, groupReply(4242, body)), true);
    }
    assert.equal(deps.Ticket.docs[0].status, "open");
    assert.equal(deps.Message.docs.length, 1, "no admin message was created");
    assert.ok(bot.calls.every((call) => call.method === "sendMessage" && String(call.args[0]) === "-100777"), "only the group is addressed");
    assert.ok(bot.of("sendMessage")[0].args[1].includes(ticket.ticketId));
  });

  test("replies from non-admins, from other chats and to unrelated messages are left to normal group handling", async () => {
    await startTicket();
    deps.Message.docs[0].groupMessageIds = [4242];
    bot.calls.length = 0;
    assert.equal(await handleSupportGroupReply(bot, groupReply(4242, { text: "hack" }, 5555)), false);
    const elsewhere = groupReply(4242, { text: "hack" });
    elsewhere.chat = { id: -100999, type: "supergroup" };
    assert.equal(await handleSupportGroupReply(bot, elsewhere), false);
    assert.equal(await handleSupportGroupReply(bot, groupReply(31337, { text: "hi" })), false);
    assert.equal(bot.calls.length, 0);
  });
});

describe("customer ticket actions", () => {
  test("closing takes a confirmation tap, then closes for good: no group notice, no reopen offered", async () => {
    const ticket = await startTicket();
    await handleSupportCallback(bot, callback(`sup_closeq:${ticket.ticketId}`));
    assert.equal(deps.Ticket.docs[0].status, "open", "asking changes nothing");
    const ask = bot.of("editMessageText").at(-1);
    assert.equal(ask.args[0], SUPPORT_COPY.confirmCloseQuestion);
    const choices = ask.args[1].reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.deepEqual(choices, [`sup_close:${ticket.ticketId}`, `sup_open:${ticket.ticketId}`]);

    bot.calls.length = 0;
    await handleSupportCallback(bot, callback(`sup_close:${ticket.ticketId}`));
    assert.equal(deps.Ticket.docs[0].status, "closed");
    assert.equal(deps.Ticket.docs[0].closedBy, "customer");
    assert.equal(bot.of("sendMessage").filter((call) => String(call.args[0]) === "-100777").length, 0);
    const done = bot.of("editMessageText").at(-1);
    assert.equal(done.args[0], SUPPORT_COPY.closedByYou);
    assert.ok(!JSON.stringify(done.args[1].reply_markup).includes("reopen"));
    assert.ok(JSON.stringify(done.args[1].reply_markup).includes("sup_new"));
  });

  test("double-tapping close is harmless", async () => {
    const ticket = await startTicket();
    await Promise.all([handleSupportCallback(bot, callback(`sup_close:${ticket.ticketId}`)), handleSupportCallback(bot, callback(`sup_close:${ticket.ticketId}`))]);
    assert.equal(deps.Ticket.docs[0].status, "closed");
    assert.ok(bot.of("answerCallbackQuery").every((call) => !call.args[1]?.show_alert));
  });

  test("a closed ticket opens read-only with the approved copy and offers a new ticket, not a reply or reopen", async () => {
    const ticket = await startTicket();
    await tickets.changeStatus({ ticketId: ticket.ticketId, status: "closed", actor: { role: "admin", id: "9001" } });
    await handleSupportCallback(bot, callback(`sup_open:${ticket.ticketId}`));
    const view = bot.of("editMessageText").at(-1);
    assert.ok(view.args[0].includes(SUPPORT_COPY.closed));
    const callbacks = view.args[1].reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
    assert.ok(callbacks.includes("sup_new"));
    assert.ok(!callbacks.some((data) => /reopen|close/.test(data)));
    assert.equal((await getSession(1001)).support, false, "not in compose mode");
  });

  test("an open ticket view shows the message prompt and the latest messages only", async () => {
    const ticket = await startTicket();
    for (let i = 0; i < 6; i += 1) await supportMessageHandler(bot, text(`پیام ${i}`));
    await handleSupportCallback(bot, callback(`sup_open:${ticket.ticketId}`));
    const view = bot.of("editMessageText").at(-1).args[0];
    assert.ok(view.includes(SUPPORT_COPY.messagePrompt));
    assert.ok(view.includes("پیام 5") && view.includes("پیام 3") && !view.includes("پیام 2"), "only the last three messages");
  });

  test("a stale 'reopen' button on a closed ticket is refused with the closed copy", async () => {
    const ticket = await startTicket();
    await handleSupportCallback(bot, callback(`sup_close:${ticket.ticketId}`));
    const stale = callback(`sup_reopen:${ticket.ticketId}`);
    await handleSupportCallback(bot, stale);
    assert.equal(deps.Ticket.docs[0].status, "closed");
    const [answer] = bot.of("answerCallbackQuery").filter((call) => call.args[0] === stale.id);
    assert.equal(answer.args[1].text, SUPPORT_COPY.closed);
    assert.equal(answer.args[1].show_alert, true);
  });

  test("a customer cannot open, close or post to another customer's ticket via crafted callbacks", async () => {
    const theirs = await startTicket(2002);
    for (const action of ["sup_closeq", "sup_close", "sup_reopen"]) {
      const query = callback(`${action}:${theirs.ticketId}`, 42, 1001);
      await handleSupportCallback(bot, query);
      const [answer] = bot.of("answerCallbackQuery").filter((call) => call.args[0] === query.id);
      assert.equal(answer.args[1].show_alert, true, action);
    }
    assert.equal(deps.Ticket.docs.find((t) => t.ticketId === theirs.ticketId).status, "open");

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

  test("the empty list uses the approved empty-state copy", async () => {
    await handleSupportCallback(bot, callback("sup_list"));
    assert.equal(bot.of("editMessageText").at(-1).args[0], SUPPORT_COPY.noTickets);
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
