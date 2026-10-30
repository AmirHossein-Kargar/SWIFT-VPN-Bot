/**
 * Compatibility contract with the installed node-telegram-bot-api.
 *
 * services/admin/monitoring.js getPollingEvidence() (used by /ready and System Health) relies on `bot._polling._lastUpdate`,
 * a private field the library stamps after every SUCCESSFUL getUpdates response. These tests drive the REAL
 * TelegramBotPolling class with a stubbed bot (no network, no real poller, no timers left running) and fail with an
 * explicit message if a dependency update changes or removes what getPollingEvidence expects.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { getPollingEvidence, recordPollingError, resetHealthCacheForTests } from "../../services/admin/monitoring.js";

const require = createRequire(import.meta.url);
const TelegramBot = require("node-telegram-bot-api");
const TelegramBotPolling = require("node-telegram-bot-api/src/telegramPolling.js");
const { version } = require("node-telegram-bot-api/package.json");

const CONTRACT = `node-telegram-bot-api ${version} changed its polling internals; review getPollingEvidence() in services/admin/monitoring.js (and /ready) before upgrading:`;

/** A bot the real polling class can drive entirely offline. */
function stubBot({ getUpdates, processUpdate = () => {}, request = async () => { throw new Error("no network in tests"); } } = {}) {
  const bot = new EventEmitter();
  bot.options = { polling: { interval: 60_000 } }; // far in the future; the timer is cleared by stop()
  bot.getUpdates = getUpdates;
  bot.processUpdate = processUpdate;
  bot._request = request;
  return bot;
}

const realNow = Date.now;
let polling;
beforeEach(() => { Date.now = realNow; resetHealthCacheForTests(); polling = null; });
afterEach(async () => { Date.now = realNow; if (polling) await polling.stop(); });

/** The object shape getPollingEvidence() reads: the bot's `_polling` plus `isPolling()`. */
const evidenceBot = () => ({ _polling: polling, isPolling: () => polling.isPolling() });

describe(`installed node-telegram-bot-api ${version}`, () => {
  test("exposes the success stamp: `_polling._lastUpdate` is a number that starts at 0", () => {
    polling = new TelegramBotPolling(stubBot({ getUpdates: async () => [] }));
    assert.equal(typeof polling._lastUpdate, "number", `${CONTRACT} TelegramBotPolling no longer has a numeric _lastUpdate`);
    assert.equal(polling._lastUpdate, 0, `${CONTRACT} _lastUpdate no longer starts at 0 ("no poll completed yet")`);
    assert.equal(typeof polling.isPolling, "function", `${CONTRACT} TelegramBotPolling#isPolling is gone`);
  });

  test("the public bot API getPollingEvidence and the health check use still exists", () => {
    const bot = new TelegramBot("123456789:AATestTokenNeverUsedForNetworkAccess_0123456", { polling: false });
    assert.equal(bot._polling, null, `${CONTRACT} with polling disabled, bot._polling is no longer null`);
    assert.equal(typeof bot.isPolling, "function", `${CONTRACT} TelegramBot#isPolling is gone`);
    assert.equal(bot.isPolling(), false);
    assert.equal(typeof bot.getWebHookInfo, "function", `${CONTRACT} TelegramBot#getWebHookInfo is gone`);
    assert.equal(typeof bot.getMe, "function");
  });

  test("polling.autoStart:false leaves polling off until startPolling(), so handlers can register first", () => {
    const bot = new TelegramBot("123456789:AATestTokenNeverUsedForNetworkAccess_0123456", { polling: { autoStart: false } });
    assert.equal(bot.isPolling(), false, `${CONTRACT} autoStart:false no longer defers polling; bot.js relies on it`);
    assert.equal(typeof bot.startPolling, "function", `${CONTRACT} TelegramBot#startPolling is gone`);
  });

  test("a SUCCESSFUL getUpdates round (even an empty one) stamps _lastUpdate", async () => {
    polling = new TelegramBotPolling(stubBot({ getUpdates: async () => [] }));
    const before = Date.now();
    await polling.start();
    assert.ok(polling._lastUpdate >= before, `${CONTRACT} an empty successful poll no longer stamps _lastUpdate`);
    assert.ok(polling._lastUpdate <= Date.now());
    const evidence = getPollingEvidence(evidenceBot());
    assert.equal(evidence.source, "poller", "the real library is read through the success signal, not the 2-minute fallback");
    assert.equal(evidence.failing, false);
  });

  test("a FAILED getUpdates round emits polling_error with the HTTP status and does not stamp a success", async () => {
    const errors = [];
    const bot = stubBot({ getUpdates: async () => { throw Object.assign(new Error("Bad Gateway"), { response: { statusCode: 502 } }); } });
    bot.on("polling_error", (error) => { errors.push(error); recordPollingError({ status: error?.response?.statusCode }); });
    polling = new TelegramBotPolling(bot);
    await polling.start();
    assert.equal(polling._lastUpdate, 0, `${CONTRACT} a failed poll must not stamp _lastUpdate`);
    assert.equal(errors.length, 1, `${CONTRACT} polling_error is no longer emitted for a failed round`);
    assert.equal(errors[0].response.statusCode, 502, `${CONTRACT} polling_error no longer carries error.response.statusCode (startBot.js reads it)`);
    const evidence = getPollingEvidence(evidenceBot());
    assert.equal(evidence.failing, true);
    assert.equal(evidence.lastErrorStatus, 502);
  });

  test("a 409 conflict still surfaces as polling_error 409 (the library's webhook-unset retry is stubbed, not sent)", async () => {
    const errors = [];
    const bot = stubBot({
      getUpdates: async () => { throw Object.assign(new Error("Conflict"), { response: { statusCode: 409 } }); },
      request: async () => { throw Object.assign(new Error("Conflict"), { response: { statusCode: 409 } }); },
    });
    bot.on("polling_error", (error) => errors.push(error));
    polling = new TelegramBotPolling(bot);
    await polling.start();
    assert.equal(errors[0]?.response?.statusCode, 409);
  });

  test("tie regression: a handler error in the SAME millisecond as its poll's success stamp is still 'failing'", async () => {
    // The library stamps _lastUpdate when the response arrives and BEFORE it processes the updates, so a throwing handler
    // reports polling_error in the same millisecond. With a frozen clock both timestamps are identical.
    const frozen = realNow();
    Date.now = () => frozen;
    const bot = stubBot({
      getUpdates: async () => [{ update_id: 1 }],
      processUpdate: () => { throw new Error("handler exploded"); },
    });
    bot.on("polling_error", (error) => recordPollingError({ status: error?.response?.statusCode }));
    polling = new TelegramBotPolling(bot);
    await polling.start();

    assert.equal(polling._lastUpdate, frozen, "the success stamp precedes processing and equals the error time");
    const evidence = getPollingEvidence(evidenceBot(), frozen);
    assert.equal(evidence.failing, true, "an error that ties with the last success must not be treated as recovered");
  });

  test("and a genuinely later successful poll does recover it", async () => {
    const frozen = realNow();
    Date.now = () => frozen;
    const bot = stubBot({ getUpdates: async () => [{ update_id: 1 }], processUpdate: () => { throw new Error("handler exploded"); } });
    bot.on("polling_error", () => recordPollingError({}));
    polling = new TelegramBotPolling(bot);
    await polling.start();
    assert.equal(getPollingEvidence(evidenceBot(), frozen).failing, true);

    polling._lastUpdate = frozen + 300; // next round (>= the 300 ms polling interval later) succeeded
    assert.equal(getPollingEvidence(evidenceBot(), frozen + 5_000).failing, false);
  });
});
