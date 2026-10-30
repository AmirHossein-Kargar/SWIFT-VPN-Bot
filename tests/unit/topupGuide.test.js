/**
 * The wallet top-up guide must describe what the bot really does. Every button, message title and `verbatim` line in
 * storefront/lib/topup-guide.json has to exist in the bot's source, so a renamed button or a changed warning fails here
 * instead of silently leaving the guide wrong. The images are drawn from the same file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, openSync, readFileSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";

const read = (path) => readFileSync(resolve(path), "utf8");
const guide = JSON.parse(read("storefront/lib/topup-guide.json"));
const steps = [...guide.card, ...guide.crypto];

// Bot source with markup and template placeholders removed, so "<b>x</b>" still matches "x".
const botSource = [
  "keyboards/mainKeyboard.js",
  "handlers/message/showPaymentMethods.js",
  "handlers/handleCallbackQuery.js",
  "paymentHandlers/payHoosh.js",
  "paymentHandlers/payNowPayments.js",
].map(read).join("\n")
  .replace(/<\/?(?:b|i|code)>/g, "")
  .replace(/\$\{group\.ticker\}/g, "USDT")
  .replace(/\$\{cleanNetwork\}/g, "TRC20")
  .replace(/\$\{cleanTicker\}/g, "USDT");

const inBotSource = (text) => botSource.includes(text);

describe("the guide matches the bot", () => {
  for (const step of steps.filter((entry) => entry.kind === "bot")) {
    test(`${step.id}: buttons and title are the bot's own`, () => {
      for (const row of step.mock.rows ?? []) {
        for (const button of row) {
          if (button.sample) continue; // coin and network names come from the live provider configuration
          assert.ok(inBotSource(button.label), `button not in bot source: ${button.label}`);
        }
      }
      // The menu has no title of its own. Titles keep their leading emoji in the guide, which the source may hold apart.
      if (step.id !== "card-menu") assert.ok(inBotSource(step.mock.title.split(" ").slice(1).join(" ")), `title not in bot source: ${step.mock.title}`);
    });
    test(`${step.id}: lines marked verbatim are the bot's own`, () => {
      for (const line of step.mock.lines ?? []) {
        if (line.verbatim) assert.ok(inBotSource(line.text), `line not in bot source: ${line.text}`);
      }
    });
  }

  test("the card-to-card limits are the ones the bot enforces", () => {
    const hoosh = read("paymentHandlers/payHoosh.js");
    assert.match(hoosh, /10,000 تومان/);
    assert.match(hoosh, /50,000,000 تومان/);
    const amount = guide.card.find((step) => step.id === "card-amount");
    assert.match(amount.text, /۱۰٬۰۰۰/);
    assert.match(amount.text, /۵۰٬۰۰۰٬۰۰۰/);
  });

  test("the offered methods are the two the bot offers, card-to-card first", () => {
    const methods = read("handlers/message/showPaymentMethods.js");
    assert.ok(methods.indexOf('callback_data: "pay_hoosh"') < methods.indexOf('callback_data: "pay_nowpayments"'));
    assert.doesNotMatch(methods, /pay_bank|pay_trx/, "no direct-transfer method is offered to customers");
  });

  test("no receipt step: neither offered method asks for one, and the guide says so", () => {
    assert.doesNotMatch(read("paymentHandlers/payHoosh.js"), /رسید/);
    assert.doesNotMatch(read("paymentHandlers/payNowPayments.js"), /رسید واریزی/);
    assert.match(guide.card.at(-1).text, /ارسال رسید لازم نیست/);
  });
});

describe("the guide never pretends", () => {
  const allText = (step) => JSON.stringify(step);

  test("no step shows a successful payment or a charged wallet", () => {
    for (const step of steps) {
      assert.doesNotMatch(
        JSON.stringify([step.mock, step.diagram]),
        /پرداخت (شما )?(با موفقیت|موفق|تأیید شد|انجام شد)|کیف پول شما شارژ شد|موجودی شما افزایش یافت/,
        step.id
      );
    }
  });

  test("provider steps are diagrams with a caption that says so, never a provider-looking screen", () => {
    const diagrams = steps.filter((step) => step.kind === "diagram");
    assert.deepEqual(diagrams.map((step) => step.id), ["card-pay", "crypto-send"]);
    for (const step of diagrams) {
      assert.equal(step.mock, undefined);
      assert.match(step.caption, /نمودار راهنماست، نه تصویر درگاه/);
    }
  });

  test("the image generator labels every image as an illustration", () => {
    const script = read("scripts/build-guide-images.mjs");
    assert.match(script, /تصویر نمونه، نه اسکرین‌شات/);
    assert.match(script, /نمودار راهنما، نه تصویر درگاه/);
  });

  test("values are placeholders: no card number or wallet address anywhere", () => {
    for (const step of steps) {
      assert.doesNotMatch(allText(step), /\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}/, step.id);
      assert.doesNotMatch(allText(step), /\bT[1-9A-HJ-NP-Za-km-z]{33}\b|\b0x[0-9a-fA-F]{40}\b|\bbc1[0-9a-z]{20,}\b/, step.id);
    }
  });
});

describe("guide assets", () => {
  for (const step of steps) {
    test(`${step.id}: has an image, alt text and a caption`, () => {
      const file = resolve(`web/public/store/guide/${step.id}.webp`);
      assert.ok(existsSync(file), "run npm run build:guide-images");
      const header = Buffer.alloc(30);
      const fd = openSync(file, "r");
      readSync(fd, header, 0, 30, 0);
      closeSync(fd);
      assert.equal(header.toString("latin1", 0, 4), "RIFF");
      assert.equal(header.toString("latin1", 8, 12), "WEBP");
      // Extended WebP canvas size. 2x, so the text stays sharp when the image is enlarged.
      assert.equal(header.toString("latin1", 12, 16), "VP8X");
      assert.equal(1 + header.readUIntLE(24, 3), 800);
      assert.equal(1 + header.readUIntLE(27, 3), 1000);
      assert.ok(step.alt.length > 20);
      assert.ok(step.caption.length > 10);
      assert.ok(step.title && step.text && step.label);
    });
  }

  test("ids are unique, so no image is shared by two steps", () => {
    assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);
  });
});
