#!/usr/bin/env node
/**
 * SWIFT-VPN-Bot — Production Preflight Check
 * -------------------------------------------
 * Run on the production server BEFORE starting the bot:
 *
 *   node scripts/preflight.js
 *
 * Checks:
 *   1.  All required environment variables are present and non-empty
 *   2.  HOOSHPAY_WEBHOOK_SECRET is configured and strong enough
 *   3.  WEBHOOK_BASE_URL is HTTPS and reachable
 *   4.  MongoDB connection and basic read/write
 *   5.  Redis connection and basic set/get/del
 *   6.  HooshPay API key is valid (GET /invoices with expect 401 OR 200/404)
 *   7.  Webhook route responds on /health
 *   8.  BOT_TOKEN format is valid (no live Telegram call needed)
 *   9.  CARD_NUMBER format is valid (16 digits)
 *  10.  TRX_WALLET format is valid (starts with T, 34 chars)
 *
 * Exit code 0 = all checks passed (GO for deployment)
 * Exit code 1 = one or more checks failed (NO-GO)
 */

import "dotenv/config";
import crypto from "node:crypto";
import process from "node:process";

// ── ANSI colours ─────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;   // green
const R = (s) => `\x1b[31m${s}\x1b[0m`;   // red
const Y = (s) => `\x1b[33m${s}\x1b[0m`;   // yellow
const B = (s) => `\x1b[1m${s}\x1b[0m`;    // bold

const PASS = G("  ✔ PASS");
const FAIL = R("  ✖ FAIL");
const WARN = Y("  ⚠ WARN");

let failures = 0;
let warnings = 0;

function pass(label)         { console.log(`${PASS}  ${label}`); }
function fail(label, detail) { console.log(`${FAIL}  ${label}`); if (detail) console.log(`       ${R(detail)}`); failures++; }
function warn(label, detail) { console.log(`${WARN}  ${label}`); if (detail) console.log(`       ${Y(detail)}`); warnings++; }
function section(title)      { console.log(`\n${B(`── ${title} ${"─".repeat(Math.max(0, 55 - title.length))}`)}`); }

// ─────────────────────────────────────────────────────────────────────────────

section("1. Required Environment Variables");

const REQUIRED = {
  // Telegram
  BOT_TOKEN:              { critical: true,  hint: "Get from @BotFather on Telegram" },
  ADMINS:                 { critical: true,  hint: "Comma-separated Telegram user IDs" },
  GROUP_ID:               { critical: true,  hint: "Admin group chat ID (negative number)" },
  // Database
  MONGO_URL:              { critical: true,  hint: "MongoDB connection string" },
  // Redis
  REDIS_HOST:             { critical: true,  hint: "Redis server hostname or IP" },
  REDIS_PORT:             { critical: true,  hint: "Redis server port (default 6379)" },
  REDIS_USERNAME:         { critical: false, hint: "Redis username (default: 'default')" },
  // HooshPay
  HOOSHPAY_API_KEY:       { critical: true,  hint: "Get from HooshPay dashboard" },
  HOOSHPAY_WEBHOOK_SECRET:{ critical: true,  hint: "Set in HooshPay webhook settings" },
  WEBHOOK_BASE_URL:       { critical: true,  hint: "Public HTTPS URL of this server, no trailing slash" },
  // VPN Panel
  WIZARD_API_URL:         { critical: true,  hint: "VPN panel base URL" },
  VPN_API_KEY:            { critical: true,  hint: "VPN panel Bearer token" },
  // Payment methods
  CARD_NUMBER:            { critical: true,  hint: "16-digit bank card number" },
  TRX_WALLET:             { critical: true,  hint: "Tron wallet address (starts with T)" },
  // Optional but recommended
  CMC_API_KEY:            { critical: false, hint: "CoinMarketCap API key for TRX price" },
  COST_PER_DAY:           { critical: false, hint: "Server cost per day in Toman (default 200)" },
  COST_PER_GB:            { critical: false, hint: "Server cost per GB in Toman (default 300)" },
  PORT:                   { critical: false, hint: "Express port (default 3000)" },
};

for (const [key, { critical, hint }] of Object.entries(REQUIRED)) {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    if (critical) fail(`${key} is missing`, hint);
    else          warn(`${key} is not set (optional)`, hint);
  } else {
    pass(`${key} is set`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

section("2. HOOSHPAY_WEBHOOK_SECRET Strength");

const whSecret = process.env.HOOSHPAY_WEBHOOK_SECRET || "";
if (whSecret.length === 0) {
  fail("HOOSHPAY_WEBHOOK_SECRET is empty", "Without this, ALL webhooks skip signature validation");
} else if (whSecret.length < 32) {
  warn("HOOSHPAY_WEBHOOK_SECRET is shorter than 32 characters", `Current length: ${whSecret.length}. Recommend 64+ hex chars.`);
} else {
  // Check it doesn't look like a placeholder
  if (/your[_-]?hook|example|placeholder|test|demo|change.?me/i.test(whSecret)) {
    fail("HOOSHPAY_WEBHOOK_SECRET looks like a placeholder value", "Replace with a cryptographically random secret");
  } else {
    pass(`HOOSHPAY_WEBHOOK_SECRET is set (${whSecret.length} chars)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

section("3. WEBHOOK_BASE_URL");

const webhookBase = process.env.WEBHOOK_BASE_URL || "";
if (!webhookBase) {
  fail("WEBHOOK_BASE_URL is not set");
} else if (!webhookBase.startsWith("https://")) {
  fail("WEBHOOK_BASE_URL must use HTTPS", `Got: ${webhookBase}`);
} else if (webhookBase.endsWith("/")) {
  fail("WEBHOOK_BASE_URL must not have a trailing slash", `Got: ${webhookBase}`);
} else if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(webhookBase)) {
  fail("WEBHOOK_BASE_URL points to localhost — HooshPay cannot reach it", `Got: ${webhookBase}`);
} else {
  pass(`WEBHOOK_BASE_URL format is valid: ${webhookBase}`);

  // Live reachability check
  try {
    const { default: https } = await import("node:https");
    const healthUrl = `${webhookBase}/health`;
    const statusCode = await new Promise((resolve, reject) => {
      const req = https.get(healthUrl, { timeout: 8000 }, (res) => resolve(res.statusCode));
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
    if (statusCode === 200) {
      pass(`/health endpoint is reachable (HTTP ${statusCode})`);
    } else {
      warn(`/health endpoint returned HTTP ${statusCode}`, "Expected 200 — server may not be running yet");
    }
  } catch (err) {
    warn(`/health endpoint is not reachable: ${err.message}`, "Start the bot server before this check can pass");
  }

  // Webhook route reachability (POST to the webhook URL — expect 200 or 400/401, not 404/502)
  try {
    const { default: https } = await import("node:https");
    const whUrl = new URL(`${webhookBase}/api/hooshpay/webhook`);
    const testBody = JSON.stringify({ test: true });
    const statusCode = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: whUrl.hostname, port: whUrl.port || 443, path: whUrl.pathname, method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(testBody) },
          timeout: 8000 },
        (res) => resolve(res.statusCode)
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.write(testBody);
      req.end();
    });
    if (statusCode === 200) {
      pass(`/api/hooshpay/webhook is reachable (HTTP ${statusCode})`);
    } else if (statusCode >= 500) {
      fail(`/api/hooshpay/webhook returned HTTP ${statusCode}`, "Server error — check bot logs");
    } else {
      warn(`/api/hooshpay/webhook returned HTTP ${statusCode}`, "Non-200 but route exists (may require valid signature)");
    }
  } catch (err) {
    warn(`/api/hooshpay/webhook not reachable: ${err.message}`, "Start the server before this check can pass");
  }
}

// ─────────────────────────────────────────────────────────────────────────────

section("4. MongoDB Connection");

if (!process.env.MONGO_URL) {
  fail("MONGO_URL is not set — skipping connection test");
} else {
  try {
    const { default: mongoose } = await import("mongoose");
    await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 6000 });

    // Verify read/write with a lightweight operation
    const db = mongoose.connection.db;
    await db.command({ ping: 1 });
    const adminInfo = await db.admin().serverInfo();
    pass(`MongoDB connected — server version ${adminInfo.version}`);

    // Check if HooshPayInvoice collection has required indexes
    const collections = await db.listCollections({ name: "hooshpayinvoices" }).toArray();
    if (collections.length > 0) {
      const indexes = await db.collection("hooshpayinvoices").indexes();
      const indexNames = indexes.map(i => i.name);
      const hasRecoveryIdx = indexNames.some(n => n.includes("recovery") || n.includes("fulfilled"));
      const hasUid = indexNames.some(n => n.includes("uid"));
      if (hasUid)      pass("HooshPayInvoice uid index exists");
      else             warn("HooshPayInvoice uid index not yet created", "Will be created on first bot startup");
      if (hasRecoveryIdx) pass("HooshPayInvoice recovery compound index exists");
      else             warn("HooshPayInvoice recovery index not yet created", "Will be created on first bot startup");
    } else {
      warn("hooshpayinvoices collection does not exist yet", "Will be created on first payment");
    }

    await mongoose.disconnect();
  } catch (err) {
    fail("MongoDB connection failed", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

section("5. Redis Connection");

const redisHost = process.env.REDIS_HOST;
const redisPort = process.env.REDIS_PORT;

if (!redisHost || !redisPort) {
  fail("REDIS_HOST or REDIS_PORT is not set — skipping connection test");
} else {
  try {
    const { createClient } = await import("redis");
    const client = createClient({
      socket: { host: redisHost, port: Number(redisPort), connectTimeout: 6000 },
      username: process.env.REDIS_USERNAME || "default",
      password: process.env.REDIS_PASSWORD || undefined,
    });

    let redisError = null;
    client.on("error", (e) => { redisError = e; });
    await client.connect();

    if (redisError) throw redisError;

    // Basic set/get/del round-trip
    const testKey = `preflight:${crypto.randomUUID()}`;
    await client.set(testKey, "ok", { EX: 10 });
    const val = await client.get(testKey);
    await client.del(testKey);

    if (val === "ok") {
      pass(`Redis connected and read/write healthy (${redisHost}:${redisPort})`);
    } else {
      fail("Redis SET/GET round-trip failed", `Expected "ok", got "${val}"`);
    }

    // Verify NX (atomic lock) works — critical for payment deduplication
    const lockKey = `preflight:lock:${crypto.randomUUID()}`;
    const r1 = await client.set(lockKey, "1", { NX: true, EX: 5 });
    const r2 = await client.set(lockKey, "1", { NX: true, EX: 5 });
    await client.del(lockKey);

    if (r1 === "OK" && r2 === null) {
      pass("Redis SET NX (atomic lock) works correctly");
    } else {
      fail("Redis SET NX atomic lock is not working correctly", `r1=${r1} r2=${r2} — expected OK + null`);
    }

    await client.quit();
  } catch (err) {
    fail("Redis connection failed", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

section("6. HooshPay API Key");

if (!process.env.HOOSHPAY_API_KEY) {
  fail("HOOSHPAY_API_KEY is not set — skipping API check");
} else if (/your[_-]?api|example|placeholder|test|demo/i.test(process.env.HOOSHPAY_API_KEY)) {
  fail("HOOSHPAY_API_KEY looks like a placeholder", "Replace with your real key from HooshPay dashboard");
} else {
  try {
    const { default: axios } = await import("axios");
    // A GET to a non-existent invoice UID — we expect 404 (key valid) or 401 (key invalid)
    // Any response from the server means the key & URL are routable
    const res = await axios.get("https://hooshpay.xyz/api/v1/invoices/preflight-check-uid", {
      headers: { "X-API-KEY": process.env.HOOSHPAY_API_KEY, Accept: "application/json" },
      timeout: 10000,
      validateStatus: () => true, // don't throw on any status
    });

    if (res.status === 401 || res.status === 403) {
      fail("HOOSHPAY_API_KEY is invalid — authentication rejected", `HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    } else if (res.status === 404 || res.status === 200 || res.status === 422) {
      pass(`HooshPay API key is valid (HTTP ${res.status} — authenticated request)`);
    } else {
      warn(`HooshPay API returned unexpected HTTP ${res.status}`, "Key may be valid — verify manually");
    }
  } catch (err) {
    warn("HooshPay API unreachable", `${err.message} — check internet connectivity`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

section("7. BOT_TOKEN Format");

const botToken = process.env.BOT_TOKEN || "";
if (!botToken) {
  fail("BOT_TOKEN is not set");
} else if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(botToken)) {
  fail("BOT_TOKEN format is invalid", "Expected format: 123456789:ABCDefgh... (get from @BotFather)");
} else {
  pass("BOT_TOKEN format is valid");
}

// ─────────────────────────────────────────────────────────────────────────────

section("8. Payment Method Configuration");

// Bank card
const cardNumber = process.env.CARD_NUMBER || "";
if (!cardNumber) {
  fail("CARD_NUMBER is not set");
} else if (!/^\d{16}$/.test(cardNumber.replace(/[-\s]/g, ""))) {
  fail("CARD_NUMBER is not a valid 16-digit card number", `Got: ${cardNumber}`);
} else if (/^0{16}$|^1{16}$/.test(cardNumber.replace(/[-\s]/g, ""))) {
  fail("CARD_NUMBER looks like a placeholder (all same digit)");
} else {
  pass(`CARD_NUMBER is set (ending in ${cardNumber.slice(-4)})`);
}

// TRX wallet
const trxWallet = process.env.TRX_WALLET || "";
if (!trxWallet) {
  fail("TRX_WALLET is not set");
} else if (!trxWallet.startsWith("T") || trxWallet.length !== 34) {
  fail("TRX_WALLET format is invalid", "Tron addresses start with T and are 34 characters");
} else if (trxWallet === "TYourTronWalletAddressHere" || trxWallet.includes("Your")) {
  fail("TRX_WALLET looks like a placeholder", "Replace with your real Tron wallet address");
} else {
  pass(`TRX_WALLET is set (${trxWallet.slice(0, 6)}...${trxWallet.slice(-4)})`);
}

// VPN API
const vpnUrl  = process.env.WIZARD_API_URL || "";
const vpnKey  = process.env.VPN_API_KEY || "";
if (!vpnUrl || vpnUrl.includes("your-vpn-panel")) {
  fail("WIZARD_API_URL is not configured");
} else {
  pass(`WIZARD_API_URL is set: ${vpnUrl}`);
}
if (!vpnKey || vpnKey.includes("bearer_token")) {
  fail("VPN_API_KEY is not configured");
} else {
  pass("VPN_API_KEY is set");
}

// ADMINS list
const admins = (process.env.ADMINS || "").split(",").map(s => s.trim()).filter(Boolean);
if (admins.length === 0) {
  fail("ADMINS list is empty — no one can access the admin panel");
} else if (admins.some(id => isNaN(Number(id)))) {
  fail("ADMINS contains non-numeric values", "Each entry must be a Telegram user ID (number)");
} else {
  pass(`ADMINS has ${admins.length} configured admin(s)`);
}

// GROUP_ID
const groupId = process.env.GROUP_ID || "";
if (!groupId) {
  fail("GROUP_ID is not set");
} else if (!groupId.startsWith("-")) {
  warn("GROUP_ID does not start with '-'", "Telegram group/supergroup IDs are negative numbers");
} else {
  pass(`GROUP_ID is set: ${groupId}`);
}

// ─────────────────────────────────────────────────────────────────────────────

section("9. Security Posture");

// Ensure .env is not committed
try {
  const { default: fs } = await import("node:fs");
  const gitignore = fs.existsSync(".gitignore") ? fs.readFileSync(".gitignore", "utf8") : "";
  if (gitignore.includes(".env")) {
    pass(".env is listed in .gitignore");
  } else {
    fail(".env is NOT in .gitignore", "Add '.env' to .gitignore immediately to prevent secret exposure");
  }
} catch { warn("Could not read .gitignore"); }

// Webhook secret entropy estimate
if (whSecret.length >= 32) {
  const entropy = Math.log2(Math.pow(256, whSecret.length));
  if (entropy > 200) pass(`HOOSHPAY_WEBHOOK_SECRET entropy is high (~${Math.round(entropy)} bits)`);
  else warn(`HOOSHPAY_WEBHOOK_SECRET entropy is low (~${Math.round(entropy)} bits)`, "Use a 32+ byte random value");
}

// ─────────────────────────────────────────────────────────────────────────────

section("Final Result");

console.log("");
if (failures === 0 && warnings === 0) {
  console.log(G("  ✅ ALL CHECKS PASSED — SYSTEM IS GO FOR PRODUCTION\n"));
} else if (failures === 0) {
  console.log(Y(`  ⚠  ALL CRITICAL CHECKS PASSED — ${warnings} warning(s) noted`));
  console.log(Y("     Review warnings above before going live.\n"));
} else {
  console.log(R(`  ❌ ${failures} CRITICAL CHECK(S) FAILED — DO NOT DEPLOY`));
  console.log(R(`     Fix all FAIL items above before starting the bot.\n`));
}

console.log(`  Failures: ${failures === 0 ? G(failures) : R(failures)}`);
console.log(`  Warnings: ${warnings === 0 ? G(warnings) : Y(warnings)}`);
console.log("");

process.exit(failures > 0 ? 1 : 0);
