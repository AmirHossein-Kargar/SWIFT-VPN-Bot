import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createVpnService } from "../../api/wizardApi.js";

let server;
let responseMode = "ok";
let previousEnv;

before(async () => {
  previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    WIZARD_API_URL: process.env.WIZARD_API_URL,
    VPN_API_KEY: process.env.VPN_API_KEY,
  };
  process.env.NODE_ENV = "test";
  server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (responseMode === "insufficient") {
      res.end(JSON.stringify({ ok: false, error: "insufficient balance; supplier cost 987654321" }));
      return;
    }
    if (responseMode === "malformed") {
      res.end(JSON.stringify({ ok: true, result: { username: "invalid username", hash: "", supplier_cost: 987654321 } }));
      return;
    }
    if (responseMode === "server_error") {
      res.writeHead(503).end(JSON.stringify({ error: "supplier cost 987654321" }));
      return;
    }
    res.end(JSON.stringify({ ok: true, result: { username: "api_unit", hash: "safeHash" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.WIZARD_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.VPN_API_KEY = "fake-unit-key-not-a-real-credential";
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("centralized WizardXray client safety contract", () => {
  test("sends valid numeric service terms and accepts a valid response", async () => {
    responseMode = "ok";
    const result = await createVpnService(5, 7, 0);
    assert.equal(result.ok, true);
    assert.equal(result.result.username, "api_unit");
    await assert.rejects(() => createVpnService(0, 7, 0), /positive integers/);
    await assert.rejects(() => createVpnService(5, 0, 0), /positive integers/);
  });

  test("classifies provider insufficient balance without retaining raw response text", async () => {
    responseMode = "insufficient";
    await assert.rejects(() => createVpnService(5, 7, 0), (error) => {
      assert.equal(error.code, "provider_insufficient_balance");
      assert.equal(error.ambiguous, false);
      assert.doesNotMatch(error.message, /987654321|supplier cost/i);
      return true;
    });
  });

  test("malformed create result is ambiguous and is not treated as success", async () => {
    responseMode = "malformed";
    await assert.rejects(() => createVpnService(5, 7, 0), (error) => {
      assert.equal(error.code, "invalid_provisioning_response");
      assert.equal(error.ambiguous, true);
      assert.doesNotMatch(error.message, /987654321|supplier cost/i);
      return true;
    });
  });

  test("server errors on a create mutation are marked ambiguous", async () => {
    responseMode = "server_error";
    await assert.rejects(() => createVpnService(5, 7, 0), (error) => {
      assert.equal(error.ambiguous, true);
      assert.doesNotMatch(error.message, /987654321|supplier cost/i);
      return true;
    });
  });
});
