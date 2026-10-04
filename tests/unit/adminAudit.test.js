/**
 * Admin audit service — idempotency, sanitization and failure semantics.
 * Uses an in-memory audit model so these tests run without MongoDB.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.ADMINS = "424242";

const { runAuditedAction, listAuditLogs, sanitizeAuditValue } = await import("../../services/admin/audit.js");

function makeFakeModel() {
  const docs = new Map();
  let seq = 0;
  return {
    docs,
    async create(fields) {
      if (docs.has(fields.operationId)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      const doc = { ...fields, _id: `doc_${++seq}`, status: "started", result: null, errorCode: null, completedAt: null };
      doc.save = async () => { doc.saved = true; return doc; };
      docs.set(fields.operationId, doc);
      return doc;
    },
    async findOne(query) { return docs.get(query.operationId) || null; },
    async updateOne(query, update) {
      for (const doc of docs.values()) {
        if (String(doc._id) === String(query._id)) {
          Object.assign(doc, update.$set || {});
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
    },
    find(filter = {}) {
      const matches = () => [...docs.values()].filter((doc) =>
        (!filter.operationId || doc.operationId === filter.operationId)
        && (!filter.action || doc.action === filter.action)
        && (!filter.actorTelegramId || doc.actorTelegramId === filter.actorTelegramId)
        && (filter.targetId == null || doc.targetId === filter.targetId)
      ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const chain = {
        sort: () => chain,
        skip: (count) => { chain._skip = count; return chain; },
        limit: (count) => { chain._limit = count; return chain; },
        select: () => chain,
        lean: async () => {
          let items = matches();
          if (chain._skip) items = items.slice(chain._skip);
          if (chain._limit) items = items.slice(0, chain._limit);
          return items;
        },
      };
      return chain;
    },
    async countDocuments(filter = {}) {
      return [...docs.values()].filter((doc) =>
        (!filter.operationId || doc.operationId === filter.operationId)
        && (!filter.action || doc.action === filter.action)
        && (!filter.actorTelegramId || doc.actorTelegramId === filter.actorTelegramId)
        && (filter.targetId == null || doc.targetId === filter.targetId)
      ).length;
    },
  };
}

const base = {
  actorTelegramId: "424242",
  operationId: "op-abcdefghijklmnop",
  action: "USER_BALANCE_ADDED",
  metadata: { amount: 1000 },
};

describe("sanitizeAuditValue", () => {
  test("redacts secret-ish keys, URLs and long opaque tokens", () => {
    const cleaned = sanitizeAuditValue({
      paymentUrl: "https://hooshpay.xyz/pay/abc",
      botToken: "123:secret",
      trackingCode: "ABC123", // fine
      nested: { authorization: "Bearer x", count: 3 },
      blob: "https://iranisystem.com/bot/sub/?hash=zzz",
      token: "a".repeat(40),
    });
    assert.deepEqual(cleaned, {
      trackingCode: "ABC123",
      nested: { count: 3 },
      blob: "[redacted]",
    });
  });

  test("keeps plain metadata values", () => {
    assert.deepEqual(sanitizeAuditValue({ amount: 500, direction: "add" }), { amount: 500, direction: "add" });
  });
});

describe("runAuditedAction", () => {
  test("records succeeded and returns the result", async () => {
    const model = makeFakeModel();
    const { result } = await runAuditedAction({ ...base, execute: async () => ({ ok: true, auditSummary: { amount: 1000 } }), auditModel: model });
    assert.equal(result.ok, true);
    const doc = model.docs.get(base.operationId);
    assert.equal(doc.status, "succeeded");
    assert.deepEqual(doc.result, { amount: 1000 });
  });

  test("replaying the same operationId does not execute twice", async () => {
    const model = makeFakeModel();
    let executions = 0;
    const options = { ...base, resumeStarted: true, auditModel: model, execute: async () => { executions += 1; return { ok: true, auditSummary: { n: executions } }; } };
    await runAuditedAction(options);
    const replay = await runAuditedAction(options);
    assert.equal(replay.replayed, true);
    assert.equal(executions, 1);
  });

  test("same operationId with a different action is rejected", async () => {
    const model = makeFakeModel();
    await runAuditedAction({ ...base, execute: async () => ({ ok: true }), auditModel: model });
    await assert.rejects(
      () => runAuditedAction({ ...base, action: "USER_BLOCKED", execute: async () => ({ ok: true }), auditModel: model }),
      (error) => error.code === "idempotency_conflict"
    );
  });

  test("a failed execution marks the audit record failed and throws a safe error", async () => {
    const model = makeFakeModel();
    await assert.rejects(
      () => runAuditedAction({ ...base, execute: async () => { throw Object.assign(new Error("boom"), { code: "WIZARD_DOWN" }); }, auditModel: model }),
      (error) => error.code === "WIZARD_DOWN" && /به صورت امن قابل انجام نشد/.test(error.message)
    );
    assert.equal(model.docs.get(base.operationId).status, "failed");
    assert.equal(model.docs.get(base.operationId).errorCode, "WIZARD_DOWN");
  });

  test("non-admin actors are rejected before any execution", async () => {
    const model = makeFakeModel();
    let executed = false;
    await assert.rejects(
      () => runAuditedAction({ ...base, actorTelegramId: "999", execute: async () => { executed = true; }, auditModel: model }),
      (error) => error.status === 403
    );
    assert.equal(executed, false);
    assert.equal(model.docs.size, 0);
  });

  test("an interrupted action resumes when explicitly allowed", async () => {
    const model = makeFakeModel();
    // Simulate a crash: the audit row exists with status "started".
    await model.create({ operationId: base.operationId, actorTelegramId: "424242", action: base.action, status: "started", metadata: {} });
    let executions = 0;
    const { replayed } = await runAuditedAction({
      ...base, resumeStarted: true, auditModel: model,
      execute: async () => { executions += 1; return { ok: true, auditSummary: { resumed: true } }; },
    });
    assert.equal(replayed, true);
    assert.equal(executions, 1);
    assert.equal(model.docs.get(base.operationId).status, "succeeded");
  });
});

describe("listAuditLogs", () => {
  test("filters by actor and validates inputs", async () => {
    const model = makeFakeModel();
    await runAuditedAction({ ...base, operationId: "op-aaaaaaaaaaaaaaaa1", execute: async () => ({ ok: true }), auditModel: model });
    const listed = await listAuditLogs({ actorTelegramId: "424242", model });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].action, "USER_BALANCE_ADDED");
    await assert.rejects(
      () => listAuditLogs({ action: "not-an-action!!", model }),
      (error) => error.code === "invalid_action_filter"
    );
  });
});
