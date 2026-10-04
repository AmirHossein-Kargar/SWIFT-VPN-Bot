import { randomUUID } from "node:crypto";
import AdminBroadcast from "../../models/AdminBroadcast.js";
import User from "../../models/User.js";
import { default as botInstance } from "../../config/botInstance.js";
import { acquireRedisLease, releaseRedisLease, startRedisLeaseHeartbeat } from "../redisLease.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { runAuditedAction } from "./audit.js";
import { requireReason } from "./validation.js";

const SEND_BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 1_050;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_BROADCAST_LOCK = "admin:broadcast:active";
const AUDIENCES = ["all", "active", "expired", "paying", "custom"];
const PENDING_ORDER_STATES = ["reserving", "reserved", "provisioning", "provisioned", "refund_pending"];

function log(level, message, meta = {}) {
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    JSON.stringify({ ts: new Date().toISOString(), service: "admin-broadcast", level, message, ...meta })
  );
}

function normalizeButtons(buttons) {
  if (buttons == null) return [];
  if (!Array.isArray(buttons) || buttons.length > 4) throw new AdminServiceError("حداکثر ۴ دکمه مجاز است.", { status: 400, code: "invalid_broadcast_buttons" });
  return buttons.map((button) => {
    if (!button || typeof button !== "object") throw new AdminServiceError("دکمه پیام همگانی نامعتبر است.", { status: 400, code: "invalid_broadcast_buttons" });
    const text = String(button.text ?? "").trim();
    const url = String(button.url ?? "").trim();
    if (!text || text.length > 64) throw new AdminServiceError("متن دکمه باید ۱ تا ۶۴ نویسه باشد.", { status: 400, code: "invalid_broadcast_button_text" });
    let parsed;
    try { parsed = new URL(url); } catch { throw new AdminServiceError("آدرس دکمه باید یک لینک معتبر t.me باشد.", { status: 400, code: "invalid_broadcast_button_url" }); }
    const host = parsed.hostname.toLowerCase();
    if (!["t.me", "telegram.me", "telegram.dog"].includes(host) || parsed.username || parsed.password || !/^https:$/.test(parsed.protocol)) {
      throw new AdminServiceError("دکمه‌ها فقط می‌توانند به آدرس‌های t.me لینک شوند.", { status: 400, code: "invalid_broadcast_button_url" });
    }
    return { text, url: parsed.toString() };
  });
}

export async function previewBroadcast({ actorId, message, buttons } = {}) {
  assertAdminUser(actorId);
  const text = requireReason(message, { min: 1, max: 4096, name: "message" });
  const parsedButtons = normalizeButtons(buttons);
  const lineCount = text.split(/\n/).length;
  const characterCount = text.length;
  const validationErrors = [];
  if (characterCount > 1024 && !parsedButtons.length) validationErrors.push("Caption length exceeds the 1024-character media limit.");
  return {
    preview: { message: text, lineCount, characterCount, buttons: parsedButtons },
    warnings: lineCount > 20 ? ["Very long messages may render poorly on mobile clients."] : [],
    validationErrors,
  };
}

async function resolveAudienceCount({ audience, customTelegramIds, now }) {
  if (audience === "all") {
    return { total: await User.countDocuments({ isBanned: { $ne: true } }), query: { isBanned: { $ne: true } } };
  }
  if (audience === "active") {
    const cutoff = new Date(now.getTime() - 30 * DAY_MS);
    return { total: await User.countDocuments({ isBanned: { $ne: true }, lastActivityAt: { $gte: cutoff } }), query: { isBanned: { $ne: true }, lastActivityAt: { $gte: cutoff } } };
  }
  if (audience === "paying") {
    return { total: await User.countDocuments({ isBanned: { $ne: true }, successfulPayments: { $gt: 0 } }), query: { isBanned: { $ne: true }, successfulPayments: { $gt: 0 } } };
  }
  if (audience === "expired") {
    // Single pass over users with at least one service whose tracked expiry
    // has passed; bounded by the audience cap below.
    const rows = await User.aggregate([
      { $match: { isBanned: { $ne: true } } },
      {
        $project: {
          telegramId: 1,
          serviceCount: { $size: { $ifNull: ["$services", []] } },
          anyActive: {
            $anyElementTrue: {
              $map: {
                input: { $ifNull: ["$services", []] },
                as: "service",
                in: { $gt: [{ $ifNull: ["$$service.expiresAt", null] }, now] },
              },
            },
          },
        },
      },
      { $match: { serviceCount: { $gt: 0 }, anyActive: false } },
      { $project: { _id: 0, telegramId: 1 } },
    ]).allowDiskUse(true);
    const ids = rows.map((row) => row.telegramId).slice(0, 50_000);
    return { total: ids.length, query: { telegramId: { $in: ids } } };
  }
  const ids = [...new Set((customTelegramIds || []).map((id) => String(id).trim()).filter((id) => /^[1-9]\d{0,19}$/.test(id)))];
  if (!ids.length) throw new AdminServiceError("برای ارسال به فهرست دلخواه، حداقل یک گیرنده انتخاب کنید.", { status: 400, code: "empty_custom_audience" });
  if (ids.length > 10_000) throw new AdminServiceError("ارسال به فهرست دلخواه حداکثر ۱۰,۰۰۰ گیرنده را پوشش می‌دهد.", { status: 400, code: "custom_audience_too_large" });
  return { total: await User.countDocuments({ telegramId: { $in: ids }, isBanned: { $ne: true } }), query: { telegramId: { $in: ids }, isBanned: { $ne: true } } };
}

const runningBroadcasts = new Map();

export async function createBroadcast({ actorId, operationId, message, audience, customTelegramIds, buttons, ipAddress, now = new Date() } = {}) {
  assertAdminUser(actorId);
  const text = requireReason(message, { min: 1, max: 4096, name: "message" });
  if (!AUDIENCES.includes(audience)) throw new AdminServiceError("گروه مخاطبان پشتیبانی نشده است.", { status: 400, code: "invalid_broadcast_audience" });
  const parsedButtons = normalizeButtons(buttons);
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId,
    action: "BROADCAST_SENT",
    targetType: "broadcast",
    targetId: audience,
    targetUserId: null,
    ipAddress,
    metadata: { audience, characterCount: text.length, buttons: parsedButtons.length },
    resumeStarted: true,
    execute: async ({ resumed }) => {
      let broadcast = await AdminBroadcast.findOne({ operationId });
      if (!broadcast) {
        const audienceInfo = await resolveAudienceCount({ audience, customTelegramIds, now });
        if (!audienceInfo.total) throw new AdminServiceError("گروه مخاطبان انتخاب‌شده در حال حاضر خالی است.", { status: 409, code: "empty_audience" });
        broadcast = await AdminBroadcast.create({
          operationId,
          adminTelegramId: String(actorId),
          message: text,
          audience,
          customTelegramIds: audience === "custom" ? (customTelegramIds || []).map(String).slice(0, 10_000) : [],
          buttons: parsedButtons,
          status: "queued",
          total: audienceInfo.total,
        });
      }
      if (["completed", "failed"].includes(broadcast.status)) return { broadcast, alreadyFinished: true, auditSummary: { status: broadcast.status, total: broadcast.total, succeeded: broadcast.succeeded, failed: broadcast.failed } };
      if (resumed && runningBroadcasts.has(operationId)) return { broadcast, alreadyRunning: true, auditSummary: { status: broadcast.status } };
      if (runningBroadcasts.has(operationId)) return { broadcast, alreadyRunning: true, auditSummary: { status: broadcast.status } };

      const lease = await acquireRedisLease(ACTIVE_BROADCAST_LOCK, 300).catch(() => null);
      if (!lease) throw new AdminServiceError("یک ارسال همگانی دیگر هنوز در حال انجام است. ابتدا پایان آن را منتظر بمانید یا آن را لغو کنید.", { status: 409, code: "broadcast_already_running" });

      await AdminBroadcast.updateOne({ _id: broadcast._id }, { $set: { status: "running", startedAt: new Date() } });
      broadcast.status = "running";
      const runner = runBroadcast(broadcast, { actorId, operationId }).finally(() => {
        runningBroadcasts.delete(operationId);
        releaseRedisLease(lease).catch(() => {});
      });
      runningBroadcasts.set(operationId, { cancelRequested: false, runner });
      // Delivery runs in the background so the request returns immediately with
      // progress available through the status endpoints.
      void runner;
      return { broadcast, started: true, auditSummary: { audience, total: broadcast.total, started: true } };
    },
  });
  return result;
}

async function runBroadcast(broadcast, { actorId, operationId }) {
  let audienceQuery = { isBanned: { $ne: true } };
  if (broadcast.audience === "custom") audienceQuery = { telegramId: { $in: broadcast.customTelegramIds }, isBanned: { $ne: true } };
  else {
    const now = new Date();
    if (broadcast.audience === "active") audienceQuery = { isBanned: { $ne: true }, lastActivityAt: { $gte: new Date(now.getTime() - 30 * DAY_MS) } };
    else if (broadcast.audience === "paying") audienceQuery = { isBanned: { $ne: true }, successfulPayments: { $gt: 0 } };
    else if (broadcast.audience === "expired") {
      const info = await resolveAudienceCount({ audience: "expired", now });
      audienceQuery = info.query;
    }
  }

  // Resume support: a crashed/interrupted delivery continues from the last
  // acknowledged recipient instead of re-sending earlier pages.
  let processed = Number(broadcast.processed || 0);
  let succeeded = Number(broadcast.succeeded || 0);
  let failed = Number(broadcast.failed || 0);
  let lastId = broadcast.lastProcessedId || null;
  let cancelled = false;
  let lastError = null;

  try {
    while (!cancelled) {
      const state = runningBroadcasts.get(operationId);
      if (state?.cancelRequested) {
        cancelled = true;
        break;
      }
      const page = await User.find({ ...audienceQuery, ...(lastId ? { _id: { $gt: lastId } } : {}) })
        .select("_id telegramId")
        .sort({ _id: 1 })
        .limit(SEND_BATCH_SIZE)
        .lean();
      if (!page.length) break;

      const send = botInstance.bot?.sendMessage?.bind(botInstance.bot);
      for (const recipient of page) {
        lastId = recipient._id;
        processed += 1;
        if (typeof send !== "function") {
          failed += 1;
          lastError = "bot_unavailable";
          continue;
        }
        try {
          await send(String(recipient.telegramId), broadcast.message, {
            disable_web_page_preview: true,
            ...(broadcast.buttons?.length ? { reply_markup: { inline_keyboard: broadcast.buttons.map((button) => [{ text: button.text, url: button.url }]) } } : {}),
          });
          succeeded += 1;
        } catch (error) {
          if (error?.code === 403 || error?.code === "ETELEGRAM_BLOCKED" || /blocked by user/i.test(String(error?.message))) {
            await User.updateOne({ telegramId: String(recipient.telegramId) }, { $set: { isBanned: true, blockedAt: new Date(), blockedBy: "system", blockReason: "Blocked the bot during a broadcast" } }).catch(() => {});
          }
          failed += 1;
          lastError = error?.code === "EFLOOD" ? "telegram_flood_wait" : (error?.code || error?.name || "TelegramError");
        }
        await AdminBroadcast.updateOne({ _id: broadcast._id }, { $set: { processed, succeeded, failed, lastProcessedId: lastId, lastErrorCode: lastError ? String(lastError).slice(0, 80) : null } }).catch(() => {});
      }

      const stillMore = page.length === SEND_BATCH_SIZE;
      if (!stillMore) break;
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    }
  } catch (error) {
    log("error", "Broadcast delivery loop failed", { operationId, errorType: error?.name || "BroadcastError" });
    lastError = String(error?.code || error?.name || "BroadcastError").slice(0, 80);
  }

  const finalStatus = cancelled ? "cancelled" : (failed > 0 && succeeded === 0 && processed > 0 ? "failed" : "completed");
  await AdminBroadcast.updateOne(
    { _id: broadcast._id, status: { $in: ["queued", "running", "cancel_requested"] } },
    { $set: { status: finalStatus, processed, succeeded, failed, finishedAt: new Date(), lastErrorCode: lastError } }
  ).catch(() => {});
  log("info", "Broadcast finished", { operationId, status: finalStatus, processed, succeeded, failed });
  return { status: finalStatus, processed, succeeded, failed };
}

export async function requestBroadcastCancel({ actorId, operationId, ipAddress } = {}) {
  assertAdminUser(actorId);
  const broadcast = await AdminBroadcast.findOne({ operationId }).lean();
  if (!broadcast) throw new AdminServiceError("پیام همگانی یافت نشد.", { status: 404, code: "broadcast_not_found" });
  // Each cancel request is its own audited event (fresh idempotency key); the
  // guarded update below makes the state change itself safe to repeat.
  const { result } = await runAuditedAction({
    actorTelegramId: actorId,
    operationId: `BCAST-CANCEL-${randomUUID()}`,
    action: "BROADCAST_CANCEL_REQUESTED",
    targetType: "broadcast",
    targetId: operationId,
    ipAddress,
    metadata: { broadcastStatus: broadcast.status },
    resumeStarted: true,
    execute: async () => {
      const state = runningBroadcasts.get(operationId);
      if (!["queued", "running", "cancel_requested"].includes(broadcast.status)) {
        return { ok: true, status: broadcast.status, alreadyFinished: true, auditSummary: { status: broadcast.status, alreadyFinished: true } };
      }
      if (state) state.cancelRequested = true;
      const updated = await AdminBroadcast.updateOne(
        { _id: broadcast._id, status: { $in: ["queued", "running"] } },
        { $set: { status: "cancel_requested" } }
      );
      const requested = Number(updated.modifiedCount || 0) > 0;
      return {
        ok: true,
        status: requested ? "cancel_requested" : broadcast.status,
        alreadyFinished: !requested,
        auditSummary: { status: requested ? "cancel_requested" : broadcast.status },
      };
    },
  });
  return result;
}

export async function getBroadcastStatus({ actorId, operationId } = {}) {
  assertAdminUser(actorId);
  const broadcast = await AdminBroadcast.findOne({ operationId }).lean();
  if (!broadcast) throw new AdminServiceError("پیام همگانی یافت نشد.", { status: 404, code: "broadcast_not_found" });
  return {
    operationId: broadcast.operationId,
    status: broadcast.status,
    audience: broadcast.audience,
    total: broadcast.total,
    processed: broadcast.processed,
    succeeded: broadcast.succeeded,
    failed: broadcast.failed,
    createdAt: broadcast.createdAt,
    startedAt: broadcast.startedAt,
    finishedAt: broadcast.finishedAt,
    lastErrorCode: broadcast.lastErrorCode,
  };
}

export async function listBroadcasts({ actorId, page = 1, pageSize = 10 } = {}) {
  assertAdminUser(actorId);
  const safePage = Math.max(1, Math.min(1_000, Number(page) || 1));
  const safeSize = Math.max(1, Math.min(50, Number(pageSize) || 10));
  const [items, total] = await Promise.all([
    AdminBroadcast.find({}).sort({ createdAt: -1 }).skip((safePage - 1) * safeSize).limit(safeSize)
      .select("operationId adminTelegramId audience status total processed succeeded failed createdAt finishedAt lastErrorCode")
      .lean(),
    AdminBroadcast.countDocuments({}),
  ]);
  return { items, page: safePage, pageSize: safeSize, total };
}

export { AUDIENCES, PENDING_ORDER_STATES };
