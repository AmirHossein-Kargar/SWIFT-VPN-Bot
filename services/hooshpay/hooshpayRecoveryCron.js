/**
 * hooshpayRecoveryCron
 * --------------------
 * Runs every 5 minutes. Safe under PM2 cluster / multiple bot instances.
 *
 * Distributed safety:
 *   Each run tries to acquire a Redis cron lock (SET NX EX 270).
 *   Only the first worker to acquire the lock runs the cycle.
 *   All others skip cleanly. If Redis is unavailable, all workers skip
 *   (fail-closed for cron — better to skip than double-recover).
 *
 * Scenarios handled:
 *   A) Crash-between-writes: fulfilled=true, balanceCredited=false
 *      → calls fulfillHooshOrder which re-runs Phase 2 atomically
 *   B) Stale pending invoices older than EXPIRY_MINUTES
 *      → marks as "expired"
 */
import { randomUUID } from "crypto";
import HooshPayInvoice from "../../models/HooshPayInvoice.js";
import { fulfillHooshOrder } from "./fulfillHooshOrder.js";
import { acquireCronLock } from "./verifyLock.js";

const INTERVAL_MS     = 5 * 60 * 1000;   // 5 minutes
const EXPIRY_MINUTES  = 35;
const BATCH_SIZE      = 50;
const CRON_JOB_NAME   = "hooshpay-recovery";

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "hooshpay-cron", level, message, ...meta })
  );
}

export function startHooshpayRecoveryCron(bot) {
  _runCycle(bot);
  const timer = setInterval(() => _runCycle(bot), INTERVAL_MS);
  if (timer.unref) timer.unref();
  log("info", "Recovery + expiry cron started", { pid: process.pid });
}

async function _runCycle(bot) {
  // ── Distributed lock: only one PM2 worker runs per cycle ─────────────────
  const won = await acquireCronLock(CRON_JOB_NAME, 270);
  if (!won) {
    log("info", "Cron slot taken by another worker — skipping", { pid: process.pid });
    return;
  }

  const cycleId = randomUUID();
  log("info", "Cron cycle started", { cycleId, pid: process.pid });

  try {
    await _recoverStuckInvoices(bot, cycleId);
    await _expireStaleInvoices(cycleId);
    log("info", "Cron cycle complete", { cycleId });
  } catch (err) {
    log("error", "Cron cycle error", { cycleId, error: err.message });
  }
  // Lock auto-expires after 270 s — no explicit release needed
  // (releasing early could allow another worker to immediately re-run)
}

async function _recoverStuckInvoices(bot, cycleId) {
  const stuck = await HooshPayInvoice.find({
    fulfilled: true,
    balanceCredited: false,
    status: "paid",
  })
    .limit(BATCH_SIZE)
    .lean();

  if (stuck.length === 0) return;

  log("warn", `Found ${stuck.length} stuck invoice(s) — re-running Phase-2`, { cycleId });

  for (const inv of stuck) {
    const cid = randomUUID();
    try {
      // fulfillHooshOrder._creditBalance uses its own atomic Phase-2 guard
      // so two concurrent workers calling this for the same invoice is safe.
      await fulfillHooshOrder({ invoice: inv, bot, chatId: inv.userId, correlationId: cid });
    } catch (err) {
      log("error", "Recovery failed for invoice", { cycleId, cid, uid: inv.uid, error: err.message });
    }
  }
}

async function _expireStaleInvoices(cycleId) {
  const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000);
  const result = await HooshPayInvoice.updateMany(
    { status: "pending", createdAt: { $lt: cutoff } },
    { $set: { status: "expired" } }
  );
  if (result.modifiedCount > 0) {
    log("info", `Expired ${result.modifiedCount} stale pending invoice(s)`, { cycleId });
  }
}
