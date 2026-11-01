/**
 * QR codes are drawn in this process. A subscription link is a credential, so the two things proved here are that the picture really
 * decodes to the exact link, and that drawing it opens no connection of any kind.
 */
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { QR_PHOTO_FILE, sendWithQrCode, subscriptionQrPng } from "../../services/qrCode.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LINK = "https://sub.example.test/sub/88a7dabc5c6c41e7a33ed372dd1a15c6";

function decode(png) {
  const image = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data ?? null;
}

describe("the picture", () => {
  test("is a PNG that decodes to exactly the link", async () => {
    const png = await subscriptionQrPng(LINK);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(decode(png), LINK);
  });

  test("holds the characters and lengths real links have", async () => {
    for (const link of [
      "https://sub.example.test/sub/abc?token=a%20b&x=1#frag",
      "https://iranisystem.com/bot/sub/?hash=abc_DEF-123",
      `https://sub.example.test/sub/${"a".repeat(700)}`,
    ]) assert.equal(decode(await subscriptionQrPng(link)), link);
  });

  test("a missing link is refused rather than drawn", async () => {
    for (const link of ["", null, undefined, 5]) await assert.rejects(() => subscriptionQrPng(link), TypeError);
  });
});

describe("no network", () => {
  const touched = [];
  beforeEach(() => {
    touched.length = 0;
    const record = (name) => () => { touched.push(name); throw new Error(`network used: ${name}`); };
    mock.method(net.Socket.prototype, "connect", record("socket"));
    mock.method(http, "request", record("http"));
    mock.method(https, "request", record("https"));
    mock.method(dns, "lookup", record("dns"));
    mock.method(globalThis, "fetch", record("fetch"));
  });
  afterEach(() => mock.restoreAll());

  test("drawing a code opens nothing: no socket, no request, no DNS lookup", async () => {
    assert.equal(decode(await subscriptionQrPng(LINK)), LINK);
    assert.deepEqual(touched, []);
  });

  test("the only thing that leaves is the Telegram call the bot itself makes", async () => {
    const calls = [];
    await sendWithQrCode({ sendPhoto: async (...args) => { calls.push(args); } }, 1, LINK, "caption", { parse_mode: "HTML" });
    assert.deepEqual(touched, []);
    assert.equal(calls.length, 1);
  });
});

describe("delivery", () => {
  const sender = (photo) => {
    const sent = [];
    return { sent, sendPhoto: async (...args) => { sent.push(["photo", ...args]); if (photo) await photo(); }, sendMessage: async (...args) => { sent.push(["text", ...args]); } };
  };

  test("the upload is the image itself, with the caption and options the message needs", async () => {
    const bot = sender();
    await sendWithQrCode(bot, 7, LINK, "the caption", { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
    const [, chatId, png, options, file] = bot.sent[0];
    assert.equal(chatId, 7);
    assert.ok(Buffer.isBuffer(png), "never a URL for Telegram to fetch");
    assert.equal(decode(png), LINK);
    assert.deepEqual(options, { parse_mode: "HTML", reply_markup: { inline_keyboard: [] }, caption: "the caption" });
    assert.deepEqual(file, { ...QR_PHOTO_FILE });
  });

  test("if the picture fails the customer still gets the text with the link, once", async () => {
    const bot = sender(() => { throw new Error("ETELEGRAM: 413 Request Entity Too Large"); });
    await sendWithQrCode(bot, 7, LINK, `link ${LINK}`, { parse_mode: "HTML" });
    assert.deepEqual(bot.sent.filter(([kind]) => kind === "text").map(([, , text]) => text), [`link ${LINK}`]);
  });

  test("if the code cannot be drawn the text still goes out", async () => {
    const bot = sender();
    await sendWithQrCode(bot, 7, "", "text only", {});
    assert.deepEqual(bot.sent.map(([kind]) => kind), ["text"]);
  });

  test("a chat that refuses the bot is left to the caller's retry", async () => {
    for (const message of ["ETELEGRAM: 403 Forbidden: bot was blocked by the user", "ETELEGRAM: 400 Bad Request: chat not found"]) {
      const bot = sender(() => { throw new Error(message); });
      await assert.rejects(() => sendWithQrCode(bot, 7, LINK, "x"), /ETELEGRAM/);
      assert.equal(bot.sent.filter(([kind]) => kind === "text").length, 0);
    }
  });
});

describe("the third-party service is gone", () => {
  const sources = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(js|mjs|ts|tsx)$/.test(name) ? [path] : [];
  });

  test("no application code names it", () => {
    for (const folder of ["services", "handlers", "api", "web", "keyboards", "messages", "utils"]) {
      for (const file of sources(join(ROOT, folder)).filter((path) => !path.includes("public"))) {
        assert.doesNotMatch(readFileSync(file, "utf8"), /qrserver|create-qr-code/, file);
      }
    }
  });

  test("the new code does not log the link", () => {
    assert.doesNotMatch(readFileSync(join(ROOT, "services/qrCode.js"), "utf8"), /console\./);
  });
});
