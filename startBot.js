import connectDB from "./config/db.js";
import TelegramBot from "node-telegram-bot-api";
import trxScanner from "./services/trxWalletScanner.js";
import { setBotInstance } from "./config/botInstance.js";
import app, { PORT } from "./server.js";
import { startHooshpayRecoveryCron, stopHooshpayRecoveryCron } from "./services/hooshpay/hooshpayRecoveryCron.js";
import mongoose from "mongoose";
import redisClient from "./config/redisClient.js";

// ── Process-level safety net ─────────────────────────────────────────────────
// Registered inside startBot() so that simply importing this module (in tests,
// scripts) has no side effects on the host process.
let _globalHandlersInstalled = false;

function installGlobalErrorHandlers() {
  if (_globalHandlersInstalled) return;
  _globalHandlersInstalled = true;

  // A stray rejected promise (e.g. a Telegram API failure inside a fire-and-
  // forget handler) must not kill a running payment service.
  process.on("unhandledRejection", (reason) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        service: "process",
        level: "error",
        message: "Unhandled promise rejection",
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      })
    );
  });

  // An uncaught exception leaves the process in an undefined state — log it
  // and exit non-zero so the platform restarts a clean instance.
  process.on("uncaughtException", (err) => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        service: "process",
        level: "error",
        message: "Uncaught exception — exiting",
        error: err?.message,
        stack: err?.stack,
      })
    );
    process.exit(1);
  });
}

export default async function startBot() {
  installGlobalErrorHandlers();

  // 1. Connect to MongoDB
  await connectDB();
  console.log("\x1b[32m%s\x1b[0m", "✔ DB Ready");

  // 2. Start Express webhook server
  const httpServer = app.listen(PORT, () => {
    console.log("\x1b[32m%s\x1b[0m", `✔ Webhook server listening on port ${PORT}`);
  });
  httpServer.on("error", (err) => {
    console.error("\x1b[41m\x1b[37m❌ HTTP server error:\x1b[0m", err.message);
    process.exit(1);
  });

  // 3. Create Telegram bot (polling mode)
  if (!process.env.BOT_TOKEN) {
    console.error("\x1b[41m\x1b[37m❌ BOT_TOKEN is not set — cannot start Telegram bot\x1b[0m");
    process.exit(1);
  }
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  // Telegram transports errors via events. Without listeners an emitted 'error'
  // is re-thrown by EventEmitter and crashes the process.
  bot.on("error", (err) => {
    console.error("\x1b[31m%s\x1b[0m", `⚠️  Telegram client error: ${err.message}`);
  });
  bot.on("polling_error", (err) => {
    // 409 = another instance is polling with the same token (see README: 1 replica).
    const detail = err?.response?.body?.description || err.message;
    console.error("\x1b[31m%s\x1b[0m", `⚠️  Telegram polling error: ${detail}`);
  });

  // 4. Register shared bot instance so server.js webhook can send messages
  setBotInstance(bot);

  // 5. Start TRX wallet auto-scanner
  try {
    trxScanner.setBotInstance(bot);
    trxScanner.startAutoScan();
    console.log("\x1b[32m%s\x1b[0m", "🚀 TRX Wallet Scanner Started");
  } catch (error) {
    console.error(
      "\x1b[31m%s\x1b[0m",
      "❌ Failed to start TRX Wallet Scanner:",
      error.message
    );
  }

  // 6. Start HooshPay recovery + expiry cron
  try {
    startHooshpayRecoveryCron(bot);
    console.log("\x1b[32m%s\x1b[0m", "✔ HooshPay Recovery Cron Started");
  } catch (error) {
    console.error(
      "\x1b[31m%s\x1b[0m",
      "❌ Failed to start HooshPay Recovery Cron:",
      error.message
    );
  }

  // 7. Graceful shutdown — SIGTERM (Railway) + SIGINT (Ctrl-C)
  let shuttingDown = false;

  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\x1b[33m%s\x1b[0m`, `⚠️  ${signal} received — shutting down gracefully...`);

    // 7a. Stop Telegram polling (prevents new message handlers)
    try {
      await bot.stopPolling();
      console.log("\x1b[32m%s\x1b[0m", "✔ Telegram polling stopped");
    } catch (e) {
      console.error("⚠️  Telegram polling stop error:", e.message);
    }

    // 7b. Stop TRX scanner interval
    try {
      trxScanner.stopAutoScan();
      console.log("\x1b[32m%s\x1b[0m", "✔ TRX scanner stopped");
    } catch (e) {
      console.error("⚠️  TRX scanner stop error:", e.message);
    }

    // 7c. Stop HooshPay recovery cron
    try {
      stopHooshpayRecoveryCron();
      console.log("\x1b[32m%s\x1b[0m", "✔ HooshPay cron stopped");
    } catch (e) {
      console.error("⚠️  HooshPay cron stop error:", e.message);
    }

    // 7d. Close Express HTTP server
    try {
      await new Promise((resolve) => httpServer.close(() => resolve()));
      console.log("\x1b[32m%s\x1b[0m", "✔ Express server closed");
    } catch (e) {
      console.error("⚠️  Express close error:", e.message);
    }

    // 7e. Close MongoDB connection
    try {
      await mongoose.disconnect();
      console.log("\x1b[32m%s\x1b[0m", "✔ MongoDB disconnected");
    } catch (e) {
      console.error("⚠️  MongoDB disconnect error:", e.message);
    }

    // 7f. Close Redis connection
    try {
      await redisClient.quit();
      console.log("\x1b[32m%s\x1b[0m", "✔ Redis disconnected");
    } catch (e) {
      console.error("⚠️  Redis disconnect error:", e.message);
    }

    console.log("\x1b[32m%s\x1b[0m", "✔ Graceful shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  return bot;
}
