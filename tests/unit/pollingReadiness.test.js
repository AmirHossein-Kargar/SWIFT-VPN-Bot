/**
 * Long-polling failure/recovery evidence shared by System Health and /ready.
 *
 * Contract: after a polling error the bot stays "failing" until a poll that SUCCEEDED after that error is observed
 * (node-telegram-bot-api stamps `_polling._lastUpdate` on every successful getUpdates response). Silence alone, however
 * long, is never treated as recovery. No Telegram call is made here: the evidence comes from the running poller.
 */
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setBotInstance } from "../../config/botInstance.js";
import {
  HEALTH_CHECKERS,
  getPollingEvidence,
  recordPollingError,
  resetHealthCacheForTests,
} from "../../services/admin/monitoring.js";

process.env.HOOSHPAY_WEBHOOK_SECRET = "readiness-test-secret-0123456789-abcdefghijklmnop";
const serverModule = await import("../../server.js");
const { default: app, setRuntimeReadiness, setTelegramReadinessProbe } = serverModule;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const realNow = Date.now;
let clock;
function setClock(ms) { clock = ms; Date.now = () => clock; }

/** Bot whose poller reports success at `lastUpdate` (0 = no poll has completed yet). */
function pollingBot({ lastUpdate = 0, polling = true } = {}) {
  const bot = {
    _polling: { _lastUpdate: lastUpdate },
    isPolling: () => polling,
    getMe: async () => ({ id: 1 }),
    getWebHookInfo: async () => ({ url: "", pending_update_count: 0 }),
    getUpdates: async () => { throw new Error("health/readiness must never call getUpdates"); },
  };
  return bot;
}

async function readyTelegram() {
  const response = await fetch(`${baseUrl}/ready`);
  return (await response.json()).dependencies.telegram;
}

beforeEach(() => {
  Date.now = realNow;
  resetHealthCacheForTests();
  setBotInstance(null);
  setTelegramReadinessProbe(null);
  setRuntimeReadiness({ http: true, telegram: true });
});
after(async () => {
  Date.now = realNow;
  setBotInstance(null);
  setTelegramReadinessProbe(null);
  setRuntimeReadiness({ http: false, telegram: false });
  await new Promise((resolve) => server.close(resolve));
});

describe("getPollingEvidence", () => {
  test("no error: not failing, even before the first poll completes", () => {
    const evidence = getPollingEvidence(pollingBot({ lastUpdate: 0 }), 1_000_000);
    assert.equal(evidence.failing, false);
    assert.equal(evidence.stalled, false);
    assert.equal(evidence.source, "poller");
  });

  test("failure: an error after the last successful poll means failing", () => {
    setClock(1_000_000);
    const bot = pollingBot({ lastUpdate: 990_000 });
    recordPollingError({ status: 502 });
    const evidence = getPollingEvidence(bot, clock);
    assert.equal(evidence.failing, true);
    assert.equal(evidence.lastErrorStatus, 502);
  });

  test("sustained failure: stays failing however long no poll succeeds, and never recovers by age alone", () => {
    setClock(1_000_000);
    const bot = pollingBot({ lastUpdate: 990_000 });
    recordPollingError({ status: 409 });
    for (const later of [30_000, 3 * 60_000, 60 * 60_000, 24 * 3_600_000]) {
      const evidence = getPollingEvidence(bot, clock + later);
      assert.equal(evidence.failing, true, `still failing after ${later} ms without a success`);
    }
  });

  test("a stale error followed by a newer successful poll is recovery, immediately", () => {
    setClock(1_000_000);
    const bot = pollingBot({ lastUpdate: 990_000 });
    recordPollingError({ status: 502 });
    assert.equal(getPollingEvidence(bot, clock).failing, true);
    bot._polling._lastUpdate = clock + 1; // the next getUpdates round succeeded
    const recovered = getPollingEvidence(bot, clock + 5_000);
    assert.equal(recovered.failing, false);
    assert.equal(recovered.lastSuccessAgeSec, 5);
  });

  test("an old success does not hide a newer error (error ordering, not age)", () => {
    setClock(1_000_000);
    const bot = pollingBot({ lastUpdate: 1_000_000 - 3_600_000 });
    recordPollingError({ status: 502 });
    assert.equal(getPollingEvidence(bot, clock + 1).failing, true);
  });

  test("a dead poll loop is not mistaken for health: no errors but no success for > 90 s is stalled", () => {
    const bot = pollingBot({ lastUpdate: 1_000_000 });
    assert.equal(getPollingEvidence(bot, 1_000_000 + 60_000).stalled, false);
    assert.equal(getPollingEvidence(bot, 1_000_000 + 95_000).stalled, true);
    assert.equal(getPollingEvidence(pollingBot({ lastUpdate: 1_000_000, polling: false }), 1_000_000 + 95_000).stalled, false, "intentionally stopped polling is not 'stalled'");
  });

  test("without a success signal (unknown library) it falls back to a 2-minute error window", () => {
    setClock(1_000_000);
    const bot = { getMe: async () => ({ id: 1 }) };
    recordPollingError({ status: 502 });
    assert.equal(getPollingEvidence(bot, clock + 60_000).source, "error-window");
    assert.equal(getPollingEvidence(bot, clock + 60_000).failing, true);
    assert.equal(getPollingEvidence(bot, clock + 3 * 60_000).failing, false);
  });
});

describe("System Health uses the same evidence", () => {
  test("failing then recovered by a newer successful poll", async () => {
    setClock(realNow());
    const bot = pollingBot({ lastUpdate: clock - 20_000 });
    setBotInstance(bot);
    recordPollingError({ status: 502 });
    const failing = await HEALTH_CHECKERS.telegram();
    assert.equal(failing.status, "degraded");
    assert.equal(failing.details.polling.failing, true);

    clock += 1_000;
    bot._polling._lastUpdate = clock; // poll succeeded after the error
    const recovered = await HEALTH_CHECKERS.telegram();
    assert.equal(recovered.status, "healthy");
    assert.equal(recovered.details.polling.failing, false);
  });

  test("a 409 stays down for as long as no poll has succeeded since", async () => {
    setClock(realNow());
    setBotInstance(pollingBot({ lastUpdate: clock - 20_000 }));
    recordPollingError({ status: 409 });
    clock += 10 * 60_000;
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "down");
    assert.match(result.error, /409 Conflict/);
  });

  test("a stalled poller is degraded with the elapsed time", async () => {
    setClock(realNow());
    setBotInstance(pollingBot({ lastUpdate: clock - 200_000 }));
    const result = await HEALTH_CHECKERS.telegram();
    assert.equal(result.status, "degraded");
    assert.match(result.error, /No successful long-poll for 200 s/);
  });
});

describe("/ready telegram readiness", () => {
  const probeFor = (bot) => () => {
    const evidence = getPollingEvidence(bot);
    return !evidence.failing && !evidence.stalled;
  };

  test("startup: false until startBot marks Telegram ready, regardless of the probe", async () => {
    setRuntimeReadiness({ telegram: false });
    setTelegramReadinessProbe(() => true);
    assert.equal(await readyTelegram(), false);
  });

  test("failure, sustained failure, then genuine recovery", async () => {
    setClock(realNow());
    const bot = pollingBot({ lastUpdate: clock - 5_000 });
    setBotInstance(bot);
    setTelegramReadinessProbe(probeFor(bot));
    assert.equal(await readyTelegram(), true, "healthy before any error");

    recordPollingError({ status: 502 });
    assert.equal(await readyTelegram(), false, "an error after the last success makes it not ready");

    clock += 30 * 60_000; // sustained failure: nothing succeeds for 30 minutes
    assert.equal(await readyTelegram(), false, "silence is not recovery");

    bot._polling._lastUpdate = clock; // a getUpdates round finally succeeds
    assert.equal(await readyTelegram(), true, "recovers on the first successful poll after the error");
  });

  test("a throwing probe fails closed; clearing the probe restores the old behaviour", async () => {
    setTelegramReadinessProbe(() => { throw new Error("boom"); });
    assert.equal(await readyTelegram(), false);
    setTelegramReadinessProbe(null);
    assert.equal(await readyTelegram(), true);
    setRuntimeReadiness({ telegram: false });
    assert.equal(await readyTelegram(), false, "shutdown/startup flag still wins");
  });
});
