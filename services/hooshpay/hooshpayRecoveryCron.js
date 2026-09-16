/**
 * hooshpayRecoveryCron
 * --------------------
 * Runs every 5 minutes on startup.
 * Handles two recovery scenarios:
 *
 * A) Crash-between-writes:
 *    Invoice has fulfilled=true but balanceCredited=false.
 *    The process crashed after Phase 1 but before Phase 2.
 *    Action: re-run _creditBalance (via fulfillHooshOrder which detects this case).
 *
 * B) Expired pending invoices:
 *    Invoice has status=pending and createdAt older than EXPIRY_MINUTES.
 *    Action: mark status=expired so admin reports are clean.
 *
 * This runs inside the bot process (called from startBot.js) and has access
 * to the bot instance for sending notifications.
 */
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";

const INTERVAL_MS = 5 * 60 * 1000;       // every 5 minutes
const EXPIRY_MINUTES = 35;               // invoices older than this are expired
const RECOVERY_BATCH_SIZE = 50;          // process at most N stuck invoices per run

/**
 * @param {object} bot  - node-telegram-bot-api instance
 */
export function startHooshpayRecoveryCron(bot) {
  // Run once immediately on startup, then on interval
  _runCycle(bot);
  const timer = setInterval(() => _runCycle(bot), INTERVAL_MS);
  // Allow the process to exit even if the timer is active
  if (timer.unref) timer.unref();
  console.log("[HooshPay Cron] Recovery + expiry cron started");
}

async function _runCycle(bot) {
  try {
    await _recoverStuckInvoices(bot);
    await _expireStaleInvoices();
  } catch (err) {
    console.error("[HooshPay Cron] Error in cycle:", err.message);
  }
}

// ── A) Recover crash-between-writes ──────────────────────────────────────────
async function _recoverStuckInvoices(bot) {
  // fulfilled=true means Phase 1 ran; balanceCredited=false means Phase 2 didn't
  const stuck = await HooshPayInvoice.find({
    fulfilled: true,
    balanceCredited: false,
    status: "paid",
  })
    .limit(RECOVERY_BATCH_SIZE)
    .lean();

  if (stuck.length === 0) return;

  console.log(`[HooshPay Cron] Found ${stuck.length} stuck invoice(s) — re-running credit`);

  for (const inv of stuck) {
    try {
      // fulfillHooshOrder detects fulfilled=true && balanceCredited=false
      // and goes straight to _creditBalance without re-acquiring the lock
      await fulfillHooshOrder({ invoice: inv, bot, chatId: inv.userId });
    } catch (err) {
      console.error(`[HooshPay Cron] Recovery failed for uid=${inv.uid}:`, err.message);
    }
  }
}

// ── B) Expire stale pending invoices ─────────────────────────────────────────
async function _expireStaleInvoices() {
  const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000);

  const result = await HooshPayInvoice.updateMany(
    { status: "pending", createdAt: { $lt: cutoff } },
    { $set: { status: "expired" } }
  );

  if (result.modifiedCount > 0) {
    console.log(`[HooshPay Cron] Expired ${result.modifiedCount} stale pending invoice(s)`);
  }
}
