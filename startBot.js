import connectDB from "./config/db.js";
import TelegramBot from "node-telegram-bot-api";
import trxScanner from "./services/trxWalletScanner.js";
import { setBotInstance } from "./config/botInstance.js";
import app, { PORT } from "./server.js";
import { startHooshpayRecoveryCron } from "./services/hooshpay/hooshpayRecoveryCron.js";

export default async function startBot() {
  // 1. Connect to MongoDB
  await connectDB();
  console.log("\x1b[32m%s\x1b[0m", "✔ DB Ready");

  // 2. Start Express webhook server
  app.listen(PORT, () => {
    console.log("\x1b[32m%s\x1b[0m", `✔ Webhook server listening on port ${PORT}`);
  });

  // 3. Create Telegram bot (polling mode)
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

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

  return bot;
}
