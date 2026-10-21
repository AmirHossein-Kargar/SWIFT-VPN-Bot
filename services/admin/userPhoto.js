import User from "../../models/User.js";
import { default as botInstance } from "../../config/botInstance.js";
import { assertAdminUser, AdminServiceError } from "./authorization.js";
import { requireTelegramId } from "./validation.js";

/**
 * Admin-only Telegram profile photo retrieval.
 *
 * - Reuses the running bot (and therefore its token); the token and Telegram
 *   file paths never leave the server: the browser only receives image bytes
 *   from /api/admin/users/:id/photo.
 * - Only users already known to this bot are looked up, so the endpoint cannot
 *   be used to probe arbitrary Telegram ids.
 * - Nothing is persisted. Only the small file_unique_id mapping is kept in
 *   memory for a few minutes to answer conditional requests without calling
 *   Telegram again.
 * - Telegram only exposes a photo for users who interacted with the bot and
 *   whose privacy settings allow it; "no photo" is a normal outcome, not an error.
 */
export const PHOTO_MAX_BYTES = 1_000_000;
const TELEGRAM_TIMEOUT_MS = 8_000;
const META_TTL_MS = 10 * 60 * 1000;
const META_MAX_ENTRIES = 500;
const meta = new Map();

export function clearUserPhotoCacheForTests() { meta.clear(); }

function withTimeout(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), { code: "telegram_timeout" })), TELEGRAM_TIMEOUT_MS); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** Prefer the smallest rendition that is still sharp at avatar size (>=160px), else the largest available. */
export function pickPhotoSize(sizes = []) {
  const usable = sizes.filter((size) => size?.file_id && Number.isFinite(size.width));
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => a.width - b.width);
  return sorted.find((size) => size.width >= 160) || sorted[sorted.length - 1];
}

async function readStream(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > PHOTO_MAX_BYTES) {
      stream.destroy?.();
      throw Object.assign(new Error("photo too large"), { code: "photo_too_large" });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sniffContentType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length > 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

/**
 * @returns {Promise<{status:"ok", body:Buffer, contentType:string, etag:string}
 *   | {status:"not_modified", etag:string}
 *   | {status:"none"}
 *   | {status:"unavailable"}>}
 */
export async function getUserProfilePhoto({
  actorId,
  telegramId,
  ifNoneMatch = null,
  bot = botInstance.bot,
  userModel = User,
  now = Date.now,
} = {}) {
  assertAdminUser(actorId);
  const id = requireTelegramId(telegramId);
  const known = await userModel.exists({ telegramId: id });
  if (!known) throw new AdminServiceError("کاربر یافت نشد.", { status: 404, code: "user_not_found" });
  if (!bot?.getUserProfilePhotos || !bot?.getFileStream) return { status: "unavailable" };

  const current = now();
  try {
    let cached = meta.get(id);
    if (!cached || cached.expiresAt <= current) {
      const result = await withTimeout(bot.getUserProfilePhotos(Number(id), { limit: 1 }), "getUserProfilePhotos");
      const size = pickPhotoSize(result?.photos?.[0]);
      cached = size
        ? { none: false, fileId: size.file_id, uniqueId: String(size.file_unique_id || size.file_id), expiresAt: current + META_TTL_MS }
        : { none: true, expiresAt: current + META_TTL_MS };
      if (meta.size >= META_MAX_ENTRIES) meta.delete(meta.keys().next().value);
      meta.set(id, cached);
    }
    if (cached.none) return { status: "none" };

    const etag = `"tg-${cached.uniqueId.replace(/[^A-Za-z0-9_-]/g, "")}"`;
    if (ifNoneMatch && ifNoneMatch === etag) return { status: "not_modified", etag };

    const body = await withTimeout(readStream(bot.getFileStream(cached.fileId)), "getFileStream");
    const contentType = sniffContentType(body);
    if (!contentType) return { status: "unavailable" }; // never relay bytes that are not a known image type
    return { status: "ok", body, contentType, etag };
  } catch (error) {
    // The file reference can expire or Telegram can fail: drop the mapping so the next call re-resolves it.
    meta.delete(id);
    console.warn(JSON.stringify({ ts: new Date().toISOString(), service: "admin", level: "warn", message: "Profile photo unavailable", code: typeof error?.code === "string" ? error.code : error?.name }));
    return { status: "unavailable" };
  }
}
