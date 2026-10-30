#!/usr/bin/env node
/**
 * Draws the wallet top-up guide images from storefront/lib/topup-guide.json into web/public/store/guide/<id>.webp.
 * Run it by hand after changing that file (`npm run build:guide-images`, needs Chrome); the images are committed, so
 * deploys do not need a browser. They are labelled illustrations built from the bot's real labels and placeholder
 * values, not screenshots: Telegram is not reachable from the build. A real screenshot can replace a file at the same
 * path and 4:5 ratio.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const guide = JSON.parse(readFileSync(path.join(root, "storefront/lib/topup-guide.json"), "utf8"));
const outDir = path.join(root, "web/public/store/guide");
const fonts = path.join(root, "web/public/store/fonts");

const WIDTH = 400;
const HEIGHT = 500;

const fontData = (file) => readFileSync(path.join(fonts, file)).toString("base64");
const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STYLE = `
@font-face { font-family: V; font-weight: 100 900; src: url(data:font/woff2;base64,${fontData("vazirmatn-arabic-wght-normal.woff2")}) format("woff2"); unicode-range: U+0600-06FF, U+200C-200E, U+FB50-FDFF, U+FE70-FEFC; }
@font-face { font-family: V; font-weight: 100 900; src: url(data:font/woff2;base64,${fontData("vazirmatn-latin-wght-normal.woff2")}) format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
* { box-sizing: border-box; margin: 0; }
html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
body { direction: rtl; font-family: V, "Segoe UI Emoji", sans-serif; color: #eaf2ed; background: radial-gradient(320px 220px at 85% 0%, rgba(16,185,129,.14), transparent 70%), #0b0f0d; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #1f2a25; font-weight: 800; font-size: 15px; }
header i { width: 10px; height: 10px; border-radius: 50%; background: #10b981; }
header b { margin-inline-start: auto; font-size: 11.5px; font-weight: 700; color: #a8b5ae; border: 1px solid #33423a; border-radius: 99px; padding: 3px 10px; }
main { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 14px 16px; }
.bubble { background: #131b17; border: 1px solid #25332c; border-radius: 16px 16px 16px 4px; padding: 13px 14px; display: grid; gap: 6px; }
.bubble h2 { font-size: 17.5px; font-weight: 800; line-height: 1.5; }
.bubble p { font-size: 15px; line-height: 1.65; color: #c4d0ca; }
.bubble p.strong { color: #eaf2ed; font-weight: 700; }
.bubble p.muted { color: #93a29a; font-size: 14px; }
.bubble p.warn { color: #fbbf24; font-weight: 600; font-size: 14px; }
.rows { display: grid; gap: 7px; }
.row { display: flex; gap: 7px; }
.btn { position: relative; flex: 1; min-height: 42px; display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px 10px; border-radius: 11px; font-size: 14.5px; font-weight: 700; background: #1a2420; border: 1px solid #2c3a33; color: #b7c4bd; }
.btn.hot { color: #fff; background: rgba(16,185,129,.2); border-color: #10b981; box-shadow: 0 0 0 4px rgba(16,185,129,.2); }
.btn.hot::after { content: ""; position: absolute; inset-inline-start: 10px; top: 50%; width: 16px; height: 16px; margin-top: -8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 5px rgba(16,185,129,.35); }
.input { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 12px; background: #1a2420; border: 1px solid #10b981; font-size: 16px; font-weight: 700; }
.input span { direction: ltr; }
.input small { margin-inline-start: auto; font-size: 12px; font-weight: 600; color: #93a29a; }
.flow { display: grid; gap: 6px; }
.node { background: #131b17; border: 1px solid #25332c; border-radius: 14px; padding: 12px 14px; text-align: center; }
.node.out { border-style: dashed; border-color: #4b5e54; }
.node h2 { font-size: 16.5px; font-weight: 800; }
.node p { font-size: 13.5px; color: #93a29a; }
.arrow { text-align: center; color: #10b981; font-size: 20px; line-height: 1; }
.alert { margin-top: 4px; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(251,191,36,.5); background: rgba(251,191,36,.1); color: #fbbf24; font-size: 14px; font-weight: 700; text-align: center; }
`;

function botBody({ title, lines = [], rows = [], input }) {
  const text = lines.map((line) => {
    const tone = line.strong ? "strong" : line.warn ? "warn" : line.muted ? "muted" : "";
    return `<p class="${tone}">${escapeHtml(line.text)}</p>`;
  }).join("");
  const buttons = rows.map((row) =>
    `<div class="row">${row.map((button) => `<div class="btn${button.hot ? " hot" : ""}">${escapeHtml(button.label)}</div>`).join("")}</div>`).join("");
  return `<div class="bubble"><h2>${escapeHtml(title)}</h2>${text}</div>`
    + (buttons ? `<div class="rows">${buttons}</div>` : "")
    + (input ? `<div class="input"><span>${escapeHtml(input)}</span><small>پیام شما (نمونه)</small></div>` : "");
}

function diagramBody({ nodes, warning }) {
  const flow = nodes.map((node, index) =>
    `<div class="node${index === 1 ? " out" : ""}"><h2>${escapeHtml(node.title)}</h2><p>${escapeHtml(node.note)}</p></div>`).join('<div class="arrow">↓</div>');
  return `<div class="flow">${flow}</div><div class="alert">⚠️ ${escapeHtml(warning)}</div>`;
}

function pageFor(step) {
  const diagram = step.kind === "diagram";
  const body = diagram ? diagramBody(step.diagram) : botBody(step.mock);
  const badge = diagram ? "نمودار راهنما، نه تصویر درگاه" : "تصویر نمونه، نه اسکرین‌شات";
  return `<!doctype html><html lang="fa"><head><meta charset="utf-8"><style>${STYLE}</style></head><body>`
    + `<header><i></i>${diagram ? "مسیر پرداخت" : "ربات سویفت"}<b>${badge}</b></header><main>${body}</main></body></html>`;
}

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const cdp = await page.context().newCDPSession(page);

for (const step of [...guide.card, ...guide.crypto]) {
  await page.setContent(pageFor(step), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => document.querySelector("main").scrollHeight - document.querySelector("main").clientHeight);
  if (overflow > 0) throw new Error(`${step.id} overflows the image by ${overflow}px`);
  // The clip's scale is what sets the output size: this call ignores the page's deviceScaleFactor.
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "webp",
    quality: 82,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 2 },
  });
  const file = path.join(outDir, `${step.id}.webp`);
  await import("node:fs/promises").then((fs) => fs.writeFile(file, Buffer.from(data, "base64")));
  console.log(`${step.id}.webp ${(statSync(file).size / 1024).toFixed(1)} KB`);
}
await browser.close();
