import connectDB from "./config/db.js";
import TelegramBot from "node-telegram-bot-api";
import trxScanner from "./services/trxWalletScanner.js";
import { setBotInstance } from "./config/botInstance.js";
import app, { PORT, setRuntimeReadiness } from "./server.js";
import { startHooshpayRecoveryCron, stopHooshpayRecoveryCron } from "./services/hooshpay/hooshpayRecoveryCron.js";
import mongoose from "mongoose";
import { connectRedis, closeRedis } from "./config/redisClient.js";
import { seedDefaultProducts } from "./services/plans.js";

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
        errorType: reason instanceof Error ? reason.name : "UnhandledRejection",
        code: typeof reason?.code === "string" || typeof reason?.code === "number" ? reason.code : undefined,
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
        errorType: err?.name || "Error",
        code: typeof err?.code === "string" || typeof err?.code === "number" ? err.code : undefined,
      })
    );
    process.exit(1);
  });
}

export default async function startBot() {
  installGlobalErrorHandlers();

  // Bind HTTP before external dependencies so /health and /livez remain
  // independent probes and /ready can report which critical dependency failed.
  const httpServer = app.listen(PORT, "0.0.0.0");
  httpServer.on("error", (err) => {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      service: "http",
      level: "fatal",
      message: "HTTP server failed",
      errorType: err?.name || "Error",
      code: typeof err?.code === "string" ? err.code : undefined,
    }));
    process.exit(1);
  });
  await new Promise((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  setRuntimeReadiness({ http: true, telegram: false });
  console.log("\x1b[32m%s\x1b[0m", `✔ Webhook server listening on port ${PORT}`);

  // The HTTP listener is already available while these bounded dependency
  // checks run; fatal errors are surfaced without printing connection secrets.
  try {
    await connectDB();
    console.log("\x1b[32m%s\x1b[0m", "✔ DB Ready");
    // Seed the shared product catalog (never overwrites admin edits).
    try {
      const seeded = await seedDefaultProducts();
      if (seeded > 0) console.log("\x1b[32m%s\x1b[0m", `✔ Product catalog seeded (${seeded} defaults added)`);
    } catch (error) {
      console.warn("⚠️  Product catalog seeding skipped:", error?.name || "DatabaseError");
    }
    await connectRedis();
    console.log("\x1b[32m%s\x1b[0m", "✔ Redis Ready");
  } catch (error) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      service: "startup",
      level: "fatal",
      message: "Critical database dependency failed",
      errorType: error?.name || "StartupError",
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined,
    }));
    throw new Error("Critical MongoDB/Redis startup dependency failed; check /ready and Railway networking.");
  }

  // Create Telegram bot (polling mode)
  if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not set; Telegram bot cannot start");
  }
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

  // Telegram transports errors via events. Without listeners an emitted 'error'
  // is re-thrown by EventEmitter and crashes the process.
  bot.on("error", (err) => {
    console.error(JSON.stringify({ service: "telegram", level: "error", event: "client_error", errorType: err?.name || "Error", code: typeof err?.code === "string" ? err.code : undefined }));
  });
  bot.on("polling_error", (err) => {
    // 409 = another instance is polling with the same token (see README: 1 replica).
    setRuntimeReadiness({ telegram: false });
    console.error(JSON.stringify({
      service: "telegram",
      level: "error",
      event: "polling_error",
      errorType: err?.name || "TelegramError",
      code: typeof err?.code === "string" ? err.code : undefined,
      status: Number.isInteger(err?.response?.statusCode) ? err.response.statusCode : undefined,
    }));
  });

  // Register the instance before an incoming signed callback can be processed.
  setBotInstance(bot);
  try {
    await Promise.race([
      bot.getMe(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Telegram API startup check timed out")), 10_000);
        timer.unref?.();
      }),
    ]);
    setRuntimeReadiness({ telegram: true });
  } catch (error) {
    await bot.stopPolling().catch(() => {});
    throw new Error(`Telegram startup check failed (${error?.name || "TelegramError"})`);
  }

  // 5. Start TRX wallet auto-scanner
  try {
    trxScanner.setBotInstance(bot);
    trxScanner.startAutoScan();
    console.log("\x1b[32m%s\x1b[0m", "🚀 TRX Wallet Scanner Started");
  } catch (error) {
    console.error(
      "\x1b[31m%s\x1b[0m",
      "❌ Failed to start TRX Wallet Scanner:",
      error?.name || "Error"
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
      error?.name || "Error"
    );
  }

  // 7. Graceful shutdown — SIGTERM (Railway) + SIGINT (Ctrl-C)
  let shuttingDown = false;

  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\x1b[33m%s\x1b[0m`, `⚠️  ${signal} received — shutting down gracefully...`);
    setRuntimeReadiness({ http: false, telegram: false });

    // 7a. Stop Telegram polling (prevents new message handlers)
    try {
      await bot.stopPolling();
      console.log("\x1b[32m%s\x1b[0m", "✔ Telegram polling stopped");
    } catch (e) {
      console.error("⚠️  Telegram polling stop error:", e?.name || "Error");
    }

    // 7b. Stop TRX scanner interval
    try {
      trxScanner.stopAutoScan();
      console.log("\x1b[32m%s\x1b[0m", "✔ TRX scanner stopped");
    } catch (e) {
      console.error("⚠️  TRX scanner stop error:", e?.name || "Error");
    }

    // 7c. Stop HooshPay recovery cron
    try {
      stopHooshpayRecoveryCron();
      console.log("\x1b[32m%s\x1b[0m", "✔ HooshPay cron stopped");
    } catch (e) {
      console.error("⚠️  HooshPay cron stop error:", e?.name || "Error");
    }

    // 7d. Close Express HTTP server
    try {
      await new Promise((resolve) => httpServer.close(() => resolve()));
      console.log("\x1b[32m%s\x1b[0m", "✔ Express server closed");
    } catch (e) {
      console.error("⚠️  Express close error:", e?.name || "Error");
    }

    // 7e. Close MongoDB connection
    try {
      await mongoose.disconnect();
      console.log("\x1b[32m%s\x1b[0m", "✔ MongoDB disconnected");
    } catch (e) {
      console.error("⚠️  MongoDB disconnect error:", e?.name || "Error");
    }

    // 7f. Close Redis connection
    try {
      await closeRedis();
      console.log("\x1b[32m%s\x1b[0m", "✔ Redis disconnected");
    } catch (e) {
      console.error("⚠️  Redis disconnect error:", e?.name || "Error");
    }

    console.log("\x1b[32m%s\x1b[0m", "✔ Graceful shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  return bot;
}
