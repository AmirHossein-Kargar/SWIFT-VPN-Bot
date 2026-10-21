import { describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242";
delete process.env.SUPPORT_CONTACT;

const { sendUserMessage, buildAdminMessage, MAX_ADMIN_MESSAGE_LENGTH } = await import("../../services/admin/userMessaging.js");

function makeUserModel(ids) {
  const known = new Set(ids);
  return {
    findOne({ telegramId }) {
      return { select() { return this; }, async lean() { return known.has(telegramId) ? { telegramId } : null; } };
    },
  };
}

function makeAuditModel() {
  const docs = new Map();
  return {
    docs,
    async create(fields) {
      if (docs.has(fields.operationId)) throw Object.assign(new Error("dup"), { code: 11000 });
      const doc = { ...fields, _id: `id-${fields.operationId}`, status: "started", async save() { docs.set(this.operationId, this); } };
      docs.set(fields.operationId, doc);
      return doc;
    },
    async findOne({ operationId }) { return docs.get(operationId) || null; },
    async updateOne({ _id, status }, { $set }) {
      for (const doc of docs.values()) if (doc._id === _id && doc.status === status) Object.assign(doc, $set);
      return {};
    },
  };
}

function makeBot({ fail } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text, options) {
      if (fail) throw fail;
      sent.push({ chatId, text, options });
      return { message_id: 777 };
    },
  };
}

const OP = (n) => `msg-operation-${String(n).padStart(8, "0")}`;
const base = (overrides = {}) => ({
  actorId: "424242",
  telegramId: "5001",
  message: "Your service was extended by 3 days.",
  userModel: makeUserModel(["5001"]),
  ...overrides,
});

describe("admin → single user Telegram message", () => {
  test("sends through the injected bot and reports delivery only after Telegram accepts it", async () => {
    const bot = makeBot();
    const audit = makeAuditModel();
    const result = await sendUserMessage(base({ operationId: OP(1), bot, auditModel: audit }));
    assert.equal(result.delivered, true);
    assert.equal(result.telegramMessageId, 777);
    assert.equal(bot.sent.length, 1);
    assert.equal(bot.sent[0].chatId, "5001");
    assert.equal(bot.sent[0].options.parse_mode, "HTML");
    assert.equal(audit.docs.get(OP(1)).status, "succeeded");
    assert.equal(audit.docs.get(OP(1)).action, "USER_MESSAGE_SENT");
  });

  test("admin text is HTML-escaped so it cannot inject markup or break Telegram parsing", () => {
    const payload = buildAdminMessage("<b>bold</b> & <a href='x'>link</a>");
    assert.ok(payload.includes("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;a href=&#39;x&#39;&gt;"));
    assert.ok(payload.startsWith("🔔 <b>"), "only the fixed header is markup");
  });

  test("a repeated operationId (double click / retried request) never sends twice", async () => {
    const bot = makeBot();
    const audit = makeAuditModel();
    await sendUserMessage(base({ operationId: OP(2), bot, auditModel: audit }));
    const replay = await sendUserMessage(base({ operationId: OP(2), bot, auditModel: audit }));
    assert.equal(bot.sent.length, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.delivered, true);
  });

  test("a Telegram rejection is an error, never reported as delivered, and is not resent on retry", async () => {
    const blocked = Object.assign(new Error("ETELEGRAM"), { response: { statusCode: 403, body: { description: "Forbidden: bot was blocked by the user" } } });
    const audit = makeAuditModel();
    await assert.rejects(
      () => sendUserMessage(base({ operationId: OP(3), bot: makeBot({ fail: blocked }), auditModel: audit })),
      (error) => error.code === "recipient_unreachable" && error.status === 409,
    );
    assert.equal(audit.docs.get(OP(3)).status, "failed");
    const working = makeBot();
    await assert.rejects(
      () => sendUserMessage(base({ operationId: OP(3), bot: working, auditModel: audit })),
      (error) => error.code === "action_in_progress",
    );
    assert.equal(working.sent.length, 0, "a failed operation is never silently resent");
  });

  test("network failures are reported as an unknown outcome, not as success or a clean failure", async () => {
    const network = Object.assign(new Error("socket hang up"), { code: "EFATAL" });
    await assert.rejects(
      () => sendUserMessage(base({ operationId: OP(4), bot: makeBot({ fail: network }), auditModel: makeAuditModel() })),
      (error) => error.code === "delivery_unknown",
    );
  });

  test("validation: empty, oversized and control-character messages are refused before anything is audited", async () => {
    const audit = makeAuditModel();
    for (const message of ["", "   ", "x".repeat(MAX_ADMIN_MESSAGE_LENGTH + 1), "hi\u0007", 42, null]) {
      await assert.rejects(() => sendUserMessage(base({ operationId: OP(5), message, bot: makeBot(), auditModel: audit })), (error) => error.code === "invalid_message");
    }
    assert.equal(audit.docs.size, 0);
  });

  test("unknown users, a missing bot, and non-admin actors are refused", async () => {
    await assert.rejects(
      () => sendUserMessage(base({ operationId: OP(6), telegramId: "9999", bot: makeBot(), auditModel: makeAuditModel() })),
      (error) => error.code === "user_not_found",
    );
    await assert.rejects(
      () => sendUserMessage(base({ operationId: OP(7), bot: null, auditModel: makeAuditModel() })),
      (error) => error.code === "bot_unavailable",
    );
    await assert.rejects(() => sendUserMessage(base({ actorId: "111", operationId: OP(8), bot: makeBot(), auditModel: makeAuditModel() })));
  });
});
