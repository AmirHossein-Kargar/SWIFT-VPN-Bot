#!/usr/bin/env node
/**
 * Read-only check of the real dependencies, using the credentials of the environment it runs in. It exists for the checks that
 * cannot be made from a machine without production secrets:
 *
 *   railway run node scripts/verify-production.mjs
 *
 * It changes nothing, by construction: every provider call is a documented read, and there is no create, renew, upgrade, delete,
 * invoice, payment or wallet call anywhere in this file, which tests/unit/verifyProduction.test.js enforces. It does not start the
 * bot and never calls getUpdates, so it cannot compete with the running poller. Redis gets PING and DBSIZE only.
 *
 * Output is safe to paste anywhere: statuses, counts, latencies and field names. Never a key, a link, a username, an address or a
 * customer id. Exit code: 0 all PASS, 1 any FAIL, 2 nothing failed but something was BLOCKED.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "redis";
import mongoose from "mongoose";
import { StatusApi, getAccount, getHosts, getServiceInfo, listClients, panelPingMs, quotePrice } from "../api/wizardApi.js";
import { probeHooshPay } from "../services/hooshpay/hooshpayClient.js";
import { probeNowPayments } from "../services/nowpayments/nowpaymentsClient.js";

const TIMEOUT_MS = 15_000;

/** Only what the error's own class says. A message could hold a URL with a token in it, so it is never printed. */
function failure(error) {
  const parts = [error?.reason, error?.code, Number.isInteger(error?.status) ? `HTTP ${error.status}` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : error?.name || "Error";
}

function collector() {
  const rows = [];
  return {
    rows,
    async check(name, requires, run) {
      const missing = requires.filter((key) => !process.env[key]?.trim());
      if (missing.length) { rows.push({ name, result: "BLOCKED", detail: `not set here: ${missing.join(", ")}` }); return null; }
      const started = Date.now();
      try {
        const { ok = true, detail = "", value = null } = (await run()) ?? {};
        rows.push({ name, result: ok ? "PASS" : "FAIL", detail: `${Date.now() - started} ms${detail ? `, ${detail}` : ""}` });
        return value;
      } catch (error) {
        rows.push({ name, result: "FAIL", detail: failure(error) });
        return null;
      }
    },
  };
}

async function telegram(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await response.json().catch(() => null);
  if (!body?.ok) throw Object.assign(new Error("telegram"), { status: response.status, code: "telegram_refused" });
  return body.result;
}

export async function runChecks() {
  const { rows, check } = collector();
  const wizard = ["WIZARD_API_URL", "VPN_API_KEY"];

  await check("wizardxray status", wizard, async () => {
    const { result } = await StatusApi();
    return { ok: result.system === "connected", detail: `system ${result.system}, service panel ${panelPingMs(result) ?? "?"} ms` };
  });
  const account = await check("wizardxray me", wizard, async () => {
    const value = await getAccount();
    return { value, detail: `unlimited ${value.limits.unlimitedEnabled ? "on" : "off"}, tests ${value.limits.testEnabled ? "on" : "off"}, ${value.services.active ?? "?"} of ${value.services.total ?? "?"} active` };
  });
  await check("wizardxray get_hosts", wizard, async () => {
    const hosts = await getHosts();
    const enabled = hosts.filter((host) => !host.disabled).length;
    return { ok: enabled > 0, detail: `${enabled} enabled of ${hosts.length}` };
  });
  await check("wizardxray price", wizard, async () => {
    const quote = await quotePrice(1, 1);
    const expected = account ? account.prices.perGb + account.prices.perDay : null;
    return { ok: expected === null || quote.price === expected, detail: expected === null ? "not compared: me failed" : `matches me: ${quote.price === expected}` };
  });
  const client = await check("wizardxray clients", wizard, async () => {
    const page = await listClients({ limit: 1 });
    return { value: page.items[0] ?? null, detail: `${page.total ?? 0} in all` };
  });
  await check("wizardxray info", wizard, async () => {
    if (!client?.username) return { ok: true, detail: "not exercised: the account has no service" };
    const service = await getServiceInfo(client.username);
    return { ok: Boolean(service.status), detail: `source ${service.source}, link present: ${Boolean(service.subLink)}` };
  });

  await check("hooshpay balance", ["HOOSHPAY_API_KEY"], async () => {
    const answer = await probeHooshPay();
    return { ok: answer.authorized && answer.recognized, detail: `authorized ${answer.authorized}, success field ${answer.recognized}, fields ${(answer.fields ?? []).join(" ") || "none"}` };
  });
  await check("nowpayments status and key", ["NOWPAYMENTS_API_KEY"], async () => {
    const answer = await probeNowPayments({ apiKey: process.env.NOWPAYMENTS_API_KEY.trim(), baseURL: process.env.NOWPAYMENTS_API_BASE_URL });
    return { ok: answer.reachable && answer.authorized, detail: `reachable ${answer.reachable}, key accepted ${answer.authorized}` };
  });

  const tokenName = process.env.TELEGRAM_BOT_TOKEN ? "TELEGRAM_BOT_TOKEN" : "BOT_TOKEN";
  await check("telegram getMe", [tokenName], async () => ({ ok: Boolean((await telegram("getMe")).id) }));
  await check("telegram getWebhookInfo", [tokenName], async () => {
    const info = await telegram("getWebhookInfo");
    return { ok: !info.url, detail: `webhook registered ${Boolean(info.url)}, waiting ${info.pending_update_count ?? "?"}` };
  });

  const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
  await check("mongodb ping", [process.env.MONGO_URL ? "MONGO_URL" : "MONGODB_URI"], async () => {
    const connection = await mongoose.createConnection(mongoUrl, { serverSelectionTimeoutMS: 8_000 }).asPromise();
    try {
      await connection.db.command({ ping: 1 });
      return { detail: "ping answered" };
    } finally {
      await connection.close().catch(() => {});
    }
  });
  await check("redis ping", ["REDIS_URL"], async () => {
    const redis = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 8_000, reconnectStrategy: false } });
    redis.on("error", () => {});
    await redis.connect();
    try {
      return { ok: (await redis.ping()) === "PONG", detail: `${await redis.dbSize()} keys` };
    } finally {
      await redis.quit().catch(() => {});
    }
  });

  await check("application /ready", ["PRODUCTION_URL"], async () => {
    const response = await fetch(new URL("/ready", process.env.PRODUCTION_URL), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.json().catch(() => null);
    return { ok: response.status === 200 && body?.ready === true, detail: `HTTP ${response.status}, ${Object.entries(body?.dependencies ?? {}).map(([name, up]) => `${name} ${up ? "up" : "down"}`).join(", ")}` };
  });
  return rows;
}

export function exitCodeFor(rows) {
  if (rows.some((row) => row.result === "FAIL")) return 1;
  return rows.some((row) => row.result === "BLOCKED") ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = await runChecks();
  for (const row of rows) console.log(`${row.result.padEnd(8)}${row.name.padEnd(30)}${row.detail}`);
  const count = (result) => rows.filter((row) => row.result === result).length;
  console.log(`\n${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED`);
  process.exit(exitCodeFor(rows));
}
