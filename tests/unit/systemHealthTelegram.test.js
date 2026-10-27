import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setBotInstance } from "../../config/botInstance.js";
import {
  HEALTH_CHECKERS,
  getSystemHealth,
  recordPollingError,
  resetHealthCacheForTests,
} from "../../services/admin/monitoring.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// admin-panel/lib is TypeScript and Node 20 cannot import .ts, so transpile in memory (same approach as healthStatus.test.js).
function loadTypeScriptModule(relativePath) {
  const file = fileURLToPath(new URL(relativePath, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const record = { exports: {} };
  new Function("exports", "require", "module", "__filename", outputText)(record.exports, createRequire(file), record, file);
  return record.exports;
}
const { detailRows } = loadTypeScriptModule("../../admin-panel/lib/health-details.ts");

const FAKE_TOKEN = "123456789:AAFakeTokenValueUsedOnlyInThisUnitTest_xyz";
const savedAdmins = process.env.ADMINS;

function fakeBot({ webhook = { url: "", pending_update_count: 0 }, getMe = async () => ({ id: 42 }), webhookError = null } = {}) {
  const calls = [];
  return {
    calls,
    getMe: async () => { calls.push("getMe"); return getMe(); },
    getWebHookInfo: async () => {
      calls.push("getWebHookInfo");
      if (webhookError) throw webhookError;
      return webhook;
    },
    // Anything that could change Telegram state or steal updates must never be called by the health check.
    getUpdates: async () => { throw new Error("getUpdates must never be called by health checks"); },
    sendMessage: async () => { throw new Error("sendMessage must never be called by health checks"); },
    setWebHook: async () => { throw new Error("setWebHook must never be called by health checks"); },
    deleteWebHook: async () => { throw new Error("deleteWebHook must never be called by health checks"); },
  };
}

beforeEach(() => {
  resetHealthCacheForTests();
  setBotInstance(null);
});
after(() => {
  setBotInstance(null);
  if (savedAdmins === undefined) delete process.env.ADMINS; else process.env.ADMINS = savedAdmins;
});

describe("telegram health check", () => {
  test("a quiet, webhook-free bot is healthy and only read-only methods are called", async () => {
    const bot = fakeBot();
    setBotInstance(bot);
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "healthy");
    assert.equal(result.error, null);
    assert.deepEqual(bot.calls, ["getMe", "getWebHookInfo"]);
    assert.equal(result.details.polling.failing, false);
    assert.deepEqual(result.details.webhook, { registered: false, pendingUpdates: 0, lastErrorAgeSec: null, lastErrorMessage: null });
  });

  test("a 409 polling conflict marks the bot down with an actionable message", async () => {
    setBotInstance(fakeBot());
    recordPollingError({ status: 409, code: "ETELEGRAM" });
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "down");
    assert.match(result.error, /409 Conflict/);
    assert.equal(result.details.polling.lastErrorStatus, 409);
  });

  test("other recent polling errors degrade the bot; an old error does not", async () => {
    setBotInstance(fakeBot());
    recordPollingError({ status: 502, code: "EFATAL" });
    const degraded = await HEALTH_CHECKERS.telegram();
    assert.equal(degraded.status, "degraded");
    assert.match(degraded.error, /Long polling is failing/);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 60_000;
      const recovered = await HEALTH_CHECKERS.telegram();
      assert.equal(recovered.status, "healthy");
      assert.equal(recovered.details.polling.failing, false);
    } finally {
      Date.now = realNow;
    }
  });

  test("a registered webhook or a large update backlog is reported, and the webhook URL never leaks", async () => {
    setBotInstance(fakeBot({ webhook: { url: `https://example.test/hook/${FAKE_TOKEN}`, pending_update_count: 250 } }));
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "degraded");
    assert.match(result.error, /webhook is registered/);
    assert.match(result.error, /250 updates/);
    assert.equal(JSON.stringify(result).includes("example.test"), false);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });

  test("Telegram's last error text is scrubbed of tokens and URLs and truncated", async () => {
    setBotInstance(fakeBot({
      webhook: {
        url: "",
        pending_update_count: 1,
        last_error_date: Math.floor(Date.now() / 1000) - 30,
        last_error_message: `Wrong response from https://example.test/${FAKE_TOKEN}/x token ${FAKE_TOKEN} ${"x".repeat(400)}`,
      },
    }));
    const { details } = await HEALTH_CHECKERS.telegram();
    const message = details.webhook.lastErrorMessage;
    assert.ok(message.length <= 120);
    assert.equal(message.includes(FAKE_TOKEN), false);
    assert.equal(message.includes("example.test"), false);
    assert.match(message, /\[url\]|\[token\]/);
    assert.ok(details.webhook.lastErrorAgeSec >= 29 && details.webhook.lastErrorAgeSec <= 40);
  });

  test("getWebhookInfo failing does not turn a working bot red", async () => {
    setBotInstance(fakeBot({ webhookError: Object.assign(new Error(`ETIMEDOUT ${FAKE_TOKEN}`), { code: "ETIMEDOUT" }) }));
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "healthy");
    assert.equal(result.details.webhook.available, false);
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });

  test("getMe failing is still down, with a safe message", async () => {
    setBotInstance(fakeBot({ getMe: async () => { throw Object.assign(new Error(`boom ${FAKE_TOKEN}`), { code: "ECONNREFUSED" }); } }));
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "down");
    assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  });

  test("no bot instance is down, not a crash", async () => {
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "down");
  });
});

describe("system health aggregate", () => {
  test("only administrators may read it, and it keeps every pre-existing service", async () => {
    process.env.ADMINS = "9301";
    setBotInstance(fakeBot());
    await assert.rejects(() => getSystemHealth({ actorId: 1234 }), (error) => error.status === 403 || /admin|forbidden|unauthor/i.test(String(error.message + error.code)));
    await assert.rejects(() => getSystemHealth({ actorId: undefined }));

    const health = await getSystemHealth({ actorId: 9301, fresh: true });
    const names = health.services.map((service) => service.name);
    for (const name of ["mongodb", "redis", "wizardxray", "hooshpay", "nowpayments", "telegram", "webhook", "background-jobs"]) {
      assert.ok(names.includes(name), `${name} is still reported`);
    }
    assert.ok(names.includes("orders"));
    assert.equal(JSON.stringify(health).includes(FAKE_TOKEN), false);
  });

  test("a failing order check is isolated: it cannot take down the overall status by itself", async () => {
    process.env.ADMINS = "9301";
    setBotInstance(fakeBot());
    const health = await getSystemHealth({ actorId: 9301, fresh: true });
    const orders = health.services.find((service) => service.name === "orders");
    assert.ok(["down", "healthy", "degraded"].includes(orders.status));
    // Without MongoDB the critical services decide "down"; "orders" alone is never in the critical set.
    const critical = health.services.filter((service) => ["mongodb", "redis", "telegram"].includes(service.name) && service.status === "down");
    assert.equal(health.overall === "down", critical.length > 0);
  });
});

describe("health card details", () => {
  const service = (name, details) => ({ name, status: "degraded", latencyMs: null, error: null, details, lastCheckedAt: "", lastSuccessAt: null, lastFailureAt: null, lastErrorMessage: null });

  test("orders rows show counts and flag non-zero backlog", () => {
    const rows = detailRows(service("orders", { awaitingProvider: 2, needsReview: 0, deliveryPending: 1, oldestAwaitingMinutes: 90, ignored: "<script>" }));
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    assert.equal(byLabel["Waiting for provider funds"].value, "2");
    assert.equal(byLabel["Waiting for provider funds"].warn, true);
    assert.equal(byLabel["Need manual reconciliation"].warn, false);
    assert.equal(byLabel["Oldest waiting"].value, "90 min");
    assert.equal(rows.some((row) => /script/.test(row.value + row.label)), false, "unknown or non-numeric fields are never rendered");
  });

  test("telegram rows tolerate missing or malformed details", () => {
    assert.deepEqual(detailRows(service("telegram", {})), []);
    assert.deepEqual(detailRows(service("telegram", { polling: "x", webhook: null })), []);
    assert.deepEqual(detailRows(service("redis", { anything: 1 })), []);
    const rows = detailRows(service("telegram", { polling: { failing: true, stalled: false, lastSuccessAgeSec: 5 }, webhook: { registered: true, pendingUpdates: 500 } }));
    assert.deepEqual(rows.map((row) => row.warn), [true, false, true, true]);
  });
});
