/**
 * Streams a ticket attachment from Telegram to an authorized web client.
 *
 * The browser never receives the Telegram file URL (it embeds the bot token):
 * the server resolves it, streams the bytes, and applies defensive headers so
 * user-uploaded media can never execute or be framed.
 */
import axios from "axios";
import { SupportError } from "./tickets.js";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const CONTENT_TYPES = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
});

const FALLBACK_TYPES = Object.freeze({ photo: "image/jpeg", video: "video/mp4" });

export function contentTypeFor(kind, filePath = "") {
  const extension = String(filePath).split(".").pop().toLowerCase();
  return CONTENT_TYPES[extension] || FALLBACK_TYPES[kind] || "application/octet-stream";
}

export async function streamAttachment({ bot, attachment, res, http = axios }) {
  if (!bot || !attachment?.fileId) throw new SupportError("پیوست در دسترس نیست.", { status: 404, code: "attachment_unavailable" });
  let url;
  let filePath = "";
  try {
    const file = await bot.getFile(attachment.fileId);
    if (Number(file?.file_size) > MAX_ATTACHMENT_BYTES) throw new SupportError("حجم پیوست بیش از حد مجاز است.", { status: 413, code: "attachment_too_large" });
    filePath = file?.file_path || "";
    url = await bot.getFileLink(attachment.fileId);
  } catch (error) {
    if (error instanceof SupportError) throw error;
    throw new SupportError("دریافت پیوست از تلگرام ممکن نشد.", { status: 502, code: "attachment_unavailable" });
  }

  let upstream;
  try {
    upstream = await http.get(url, { responseType: "stream", timeout: 15_000, maxContentLength: MAX_ATTACHMENT_BYTES, validateStatus: (status) => status === 200 });
  } catch {
    throw new SupportError("دریافت پیوست از تلگرام ممکن نشد.", { status: 502, code: "attachment_unavailable" });
  }

  res.status(200);
  res.set({
    "Content-Type": contentTypeFor(attachment.kind, filePath),
    "Content-Disposition": "inline",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  await new Promise((resolve, reject) => {
    upstream.data.on("error", reject);
    res.on("close", resolve);
    res.on("finish", resolve);
    upstream.data.pipe(res);
  }).catch(() => { res.destroy(); });
}
