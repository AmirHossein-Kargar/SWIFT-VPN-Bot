#!/usr/bin/env node
/** Safe Railway production preflight: validates config and probes configured services. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import axios from "axios";
import { createClient } from "redis";
import { inspectEnv, resolveMongoUrl, resolveRedisConfig } from "../config/env.js";

let failures = 0;
let warnings = 0;
const pass = (message) => console.log(`✔ PASS  ${message}`);
const fail = (message) => { failures += 1; console.error(`✖ FAIL  ${message}`); };
const warn = (message) => { warnings += 1; console.warn(`⚠ WARN  ${message}`); };
const safeError = (error) => {
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? ` (${error.code})` : "";
  return `${error?.name || "Error"}${code}`;
};
const timeout = (ms, label) => new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms);
  timer.unref?.();
});

console.log("\nSWIFT-VPN-Bot production preflight\n");
const report = inspectEnv();
for (const item of report.missing) fail(`${item.key} is missing — ${item.hint}`);
for (const item of report.invalid) fail(`${item.key} is invalid — ${item.hint}`);
if (report.fatalCount === 0) pass("Required environment variables are present and structurally valid");

let mongoConfig = null;
try { mongoConfig = resolveMongoUrl(); } catch (error) { fail(`MongoDB configuration cannot be resolved (${safeError(error)})`); }
if (mongoConfig && !report.invalid.some((item) => item.key === "MONGO_URL")) {
  try {
    await mongoose.connect(mongoConfig.url, {
      serverSelectionTimeoutMS: 6_000,
      connectTimeoutMS: 6_000,
      maxPoolSize: 2,
      autoIndex: false,
    });
    await mongoose.connection.db.command({ ping: 1 });
    pass(`MongoDB ping succeeded (${mongoConfig.source})`);
  } catch (error) {
    fail(`MongoDB connection failed (${safeError(error)})`);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

let redisConfig = null;
try { redisConfig = resolveRedisConfig(); } catch (error) { fail(`Redis configuration cannot be resolved (${safeError(error)})`); }
if (redisConfig && !report.invalid.some((item) => item.key === "REDIS_URL")) {
  const options = redisConfig.url
    ? { url: redisConfig.url, socket: { connectTimeout: 6_000, reconnectStrategy: () => false } }
    : {
        username: redisConfig.username || "default",
        password: redisConfig.password || undefined,
        socket: {
          host: redisConfig.host,
          port: redisConfig.port,
          tls: redisConfig.tls,
          connectTimeout: 6_000,
          reconnectStrategy: () => false,
        },
      };
  const client = createClient(options);
  client.on("error", () => {}); // avoid EventEmitter crashes; never print connection details
  try {
    await Promise.race([client.connect(), timeout(8_000, "Redis connect timeout")]);
    if (await client.ping() !== "PONG") throw new Error("Redis ping failed");
    const key = `preflight:${randomUUID()}`;
    await client.set(key, "ok", { EX: 10 });
    const value = await client.get(key);
    await client.del(key);
    if (value !== "ok") throw new Error("Redis read/write check failed");
    const lockKey = `${key}:lock`;
    const first = await client.set(lockKey, "owner", { NX: true, EX: 10 });
    const second = await client.set(lockKey, "other", { NX: true, EX: 10 });
    await client.del(lockKey);
    if (first !== "OK" || second !== null) throw new Error("Redis atomic lease check failed");
    pass(`Redis ping, read/write, and atomic lease checks succeeded (${redisConfig.source})`);
  } catch (error) {
    fail(`Redis connection/check failed (${safeError(error)})`);
  } finally {
    if (client.isOpen) await client.quit().catch(() => client.destroy());
    else if (client.isReady) client.destroy();
  }
}

const webhookBase = process.env.WEBHOOK_BASE_URL?.trim();
if (webhookBase && !report.invalid.some((item) => item.key === "WEBHOOK_BASE_URL")) {
  try {
    const response = await fetch(`${webhookBase}/health`, { signal: AbortSignal.timeout(8_000) });
    if (response.status === 200) pass("Public /health endpoint is reachable");
    else warn(`Public /health returned HTTP ${response.status}; verify the running deployment`);
  } catch (error) {
    warn(`Public /health probe did not complete (${safeError(error)}); run after deploy if not yet online`);
  }

  try {
    const response = await fetch(`${webhookBase}/api/hooshpay/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preflight: true }),
      signal: AbortSignal.timeout(8_000),
    });
    if ([400, 401, 415, 422].includes(response.status)) pass("Webhook route is reachable and rejects an unsigned probe");
    else if (response.status >= 500) warn(`Webhook route returned HTTP ${response.status}; check app dependency readiness`);
    else warn(`Webhook route returned HTTP ${response.status}; verify the deployed route and signature policy`);
  } catch (error) {
    warn(`Webhook route probe did not complete (${safeError(error)}); run after deploy if not yet online`);
  }
}

const hooshKey = process.env.HOOSHPAY_API_KEY?.trim();
if (hooshKey) {
  const baseURL = process.env.HOOSHPAY_API_BASE_URL?.trim() || "https://hooshpay.xyz/api/v1";
  try {
    const response = await axios.get(`${baseURL.replace(/\/+$/, "")}/invoices/preflight-check-uid`, {
      headers: { "X-API-KEY": hooshKey, Accept: "application/json" },
      timeout: 8_000,
      validateStatus: () => true,
    });
    if (response.status === 401 || response.status === 403) fail(`HooshPay API rejected the configured key (HTTP ${response.status})`);
    else if (response.status < 500) pass(`HooshPay API endpoint responded (HTTP ${response.status}); response body was not logged`);
    else warn(`HooshPay API returned HTTP ${response.status}; verify the provider status`);
  } catch (error) {
    warn(`HooshPay API probe did not complete (${safeError(error)})`);
  }
}

const wizardUrl = process.env.WIZARD_API_URL?.trim();
const wizardKey = process.env.VPN_API_KEY?.trim();
if (wizardUrl && wizardKey) {
  try {
    const response = await axios.get(`${wizardUrl.replace(/\/+$/, "")}/status`, {
      headers: { Authorization: `Bearer ${wizardKey}`, Accept: "application/json" },
      timeout: 8_000,
      validateStatus: () => true,
    });
    if (response.status === 401 || response.status === 403) fail(`Wizard panel rejected the configured API key (HTTP ${response.status})`);
    else if (response.status < 500 && response.data?.ok === true) pass("Wizard panel status endpoint responded successfully");
    else if (response.status < 500) warn(`Wizard panel responded with HTTP ${response.status}; verify its /status response contract`);
    else warn(`Wizard panel returned HTTP ${response.status}; verify the provider status`);
  } catch (error) {
    warn(`Wizard panel probe did not complete (${safeError(error)})`);
  }
}

console.log(`\nPreflight result: ${failures} failure(s), ${warnings} warning(s).`);
if (failures > 0) process.exitCode = 1;
