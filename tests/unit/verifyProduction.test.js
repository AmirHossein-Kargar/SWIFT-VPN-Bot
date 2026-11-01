/**
 * scripts/verify-production.mjs runs with real production credentials, so its two promises are what is tested: it changes nothing, and
 * nothing sensitive reaches its output. A local server plays the provider, so this proves the script, not the provider.
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";

const KEY = "unit-production-key-not-real";
const SECRET_LINK = "https://sub.example.test/sub/secret-subscription-hash";
const names = ["WIZARD_API_URL", "VPN_API_KEY", "HOOSHPAY_API_KEY", "HOOSHPAY_API_BASE_URL", "NOWPAYMENTS_API_KEY", "TELEGRAM_BOT_TOKEN", "BOT_TOKEN", "MONGO_URL", "MONGODB_URI", "REDIS_URL", "PRODUCTION_URL"];
const saved = {};
for (const name of names) { saved[name] = process.env[name]; delete process.env[name]; }

const { exitCodeFor, runChecks } = await import("../../scripts/verify-production.mjs");

let server;
let requests = [];
let system = "connected";
const SERVICE = { username: "9I517RL2K", status: "active", source: "panel", unlimited: false, sub_link: SECRET_LINK, links: ["vless://secret@de.example.test:443"], expire: 1795532266, data_limit_gb: 20 };

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const path = req.url.split("?")[0];
    const answer = (body) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const ok = (result) => answer({ ok: true, error: "", result, http_code: 200 });
    if (path === "/hoosh/balance") return answer({ success: true, data: { balance: 987654321 } });
    if (path === "/status") return ok({ per_gb: 1500, per_day: 500, system, ping: 0.01 });
    if (path === "/me") return ok({ balance: 987654321, prices: { per_gb: 1500, per_day: 500 }, limits: {}, services: { total: 1, active: 1 } });
    if (path === "/get_hosts") return ok({ Inbound: [{ remark: "Germany", address: "secret-node.example.test", is_disabled: false }] });
    if (path === "/price") return ok({ price: 2000, unlimited: false, enough: true });
    if (path === "/clients") return ok({ count: 1, total: 1, list: [SERVICE] });
    if (path === "/info") return ok(SERVICE);
    return answer({});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
beforeEach(() => { requests = []; system = "connected"; });

const withCredentials = () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, { WIZARD_API_URL: `${base}/`, VPN_API_KEY: KEY, HOOSHPAY_API_KEY: KEY, HOOSHPAY_API_BASE_URL: `${base}/hoosh`, NODE_ENV: "test" });
};
const clear = () => { for (const name of names) delete process.env[name]; };

describe("what it does", () => {
  test("with no credentials everything is BLOCKED, nothing is called and nothing passes", async () => {
    clear();
    const rows = await runChecks();
    assert.ok(rows.length >= 12);
    assert.deepEqual([...new Set(rows.map((row) => row.result))], ["BLOCKED"]);
    assert.deepEqual(requests, []);
    assert.equal(exitCodeFor(rows), 2);
  });

  test("a real answer passes, and only GET is ever sent", async () => {
    withCredentials();
    const rows = await runChecks();
    clear();
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.result]));
    for (const name of ["wizardxray status", "wizardxray me", "wizardxray get_hosts", "wizardxray price", "wizardxray clients", "wizardxray info", "hooshpay balance"]) assert.equal(byName[name], "PASS", name);
    assert.ok(requests.length >= 7);
    assert.deepEqual([...new Set(requests.map((request) => request.method))], ["GET"]);
  });

  test("a provider that lost its service panel is a FAIL, not a pass with a footnote", async () => {
    withCredentials();
    system = "disconnected";
    const rows = await runChecks();
    clear();
    assert.equal(rows.find((row) => row.name === "wizardxray status").result, "FAIL");
    assert.equal(exitCodeFor(rows), 1);
  });

  test("nothing in the output could be a secret", async () => {
    withCredentials();
    const text = JSON.stringify(await runChecks());
    clear();
    for (const secret of [KEY, SECRET_LINK, "secret-subscription-hash", "vless://", "secret-node", "9I517RL2K", "987654321"]) assert.equal(text.includes(secret), false, secret);
  });
});

describe("what it cannot do", () => {
  const source = readFileSync(new URL("../../scripts/verify-production.mjs", import.meta.url), "utf8");

  test("it imports no call that creates, changes, charges or deletes", () => {
    const imported = source.match(/import \{([^}]+)\} from "\.\.\/api\/wizardApi\.js"/)[1].split(",").map((name) => name.trim()).sort();
    assert.deepEqual(imported, ["StatusApi", "getAccount", "getHosts", "getServiceInfo", "listClients", "panelPingMs", "quotePrice"]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /createVpnService|createTestService|renewService|upgradeService|deleteService|changeLinkService|setServiceStatus|createInvoice|cancelInvoice|verifyInvoice/);
    assert.doesNotMatch(code, /purchaseLedger|walletCredit|method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });

  test("it cannot compete with the running bot", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /getUpdates|startPolling|polling:\s*true|node-telegram-bot-api/);
  });

  test("Redis gets only PING and DBSIZE", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /redis\.(set|del|flush|hSet|expire)/i);
  });

  test("an error's message is never printed, because it could hold a URL with a token", () => {
    const code = source.slice(source.indexOf("function failure"), source.indexOf("function collector"));
    assert.doesNotMatch(code, /\.message/);
  });
});
