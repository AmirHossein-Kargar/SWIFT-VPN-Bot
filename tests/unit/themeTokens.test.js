/**
 * design/theme.css is the one palette. These checks keep the two Next apps on it, keep light mode green-tinted instead of
 * plain black and white, hold every text pairing to WCAG AA, and catch the hand-mapped static pages drifting away.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const read = (path) => readFileSync(resolve(path), "utf8");
const theme = read("design/theme.css");

function blockTokens(selector) {
  const start = theme.indexOf(`${selector} {`);
  assert.notEqual(start, -1, selector);
  const body = theme.slice(start, theme.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(\d[\d.]*)\s+(\d[\d.]*)%\s+(\d[\d.]*)%;/g)].map(([, name, h, s, l]) => [name, { h: Number(h), s: Number(s), l: Number(l) }]));
}
const light = blockTokens(":root");
const dark = blockTokens(".dark");

function rgb({ h, s, l }) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}
const hex = (color) => `#${rgb(color).map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
function luminance(channels) {
  const [r, g, b] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRgb(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
const contrast = (a, b) => contrastRgb(rgb(a), rgb(b));
const tint = (color, surface, alpha) => rgb(color).map((value, index) => value * alpha + rgb(surface)[index] * (1 - alpha));

function sources(dir, found = []) {
  for (const entry of readdirSync(resolve(dir), { withFileTypes: true })) {
    if (entry.name === ".next" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.tsx$/.test(entry.name)) found.push(path);
  }
  return found;
}
const tsx = [...sources("admin-panel/app"), ...sources("admin-panel/components"), ...sources("storefront/components"), ...sources("storefront/pages")];

describe("one palette", () => {
  for (const file of ["storefront/styles/globals.css", "admin-panel/app/globals.css"]) {
    test(`${file} imports design/theme.css and defines no colour of its own`, () => {
      const css = read(file);
      assert.match(css, /^@import "\.\.\/\.\.\/design\/theme\.css";/);
      assert.doesNotMatch(css, /--(background|foreground|primary|brand|border|muted|card):/);
    });
  }

  test("both themes define the same tokens", () => {
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  });

  test("light mode is green-tinted: no surface or ink is a plain grey, black or white", () => {
    for (const name of ["background", "foreground", "card", "popover", "secondary", "muted", "accent", "border", "input", "primary", "primary-foreground", "muted-foreground", "faint", "alt"]) {
      const color = light[name];
      assert.ok(color.s >= 10, `--${name} saturation ${color.s}`);
      assert.ok(color.h >= 140 && color.h <= 170, `--${name} hue ${color.h}`);
      assert.ok(color.l > 2 && color.l < 99, `--${name} lightness ${color.l}`);
    }
  });

  test("components use tokens, never Tailwind's plain white, black or greys", () => {
    for (const file of tsx) {
      assert.equal(/\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:white|black|gray|slate|zinc|neutral|stone)\b/.test(read(file)), false, file);
    }
  });
});

describe("contrast", () => {
  const pairs = [
    ["foreground", "background"], ["foreground", "card"], ["foreground", "alt"], ["foreground", "accent"],
    ["muted-foreground", "background"], ["muted-foreground", "card"], ["muted-foreground", "muted"], ["muted-foreground", "alt"],
    ["faint", "background"], ["faint", "card"], ["faint", "alt"],
    ["primary-foreground", "primary"], ["success-foreground", "success"], ["warning-foreground", "warning"], ["destructive-foreground", "destructive"],
    ["brand", "background"], ["brand", "card"], ["brand", "secondary"], ["destructive", "card"], ["warning", "card"],
  ];
  for (const [label, tokens] of [["light", light], ["dark", dark]]) {
    for (const [text, surface] of pairs) {
      test(`${label}: --${text} on --${surface} reaches AA`, () => {
        const ratio = contrast(tokens[text], tokens[surface]);
        assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
      });
    }
    // Status badges are `bg-success/15 text-success` and can sit on a selected (accent) row.
    for (const text of ["success", "warning", "destructive", "primary"]) {
      for (const surface of ["card", "background", "muted", "accent"]) {
        test(`${label}: --${text} on its 15% tint over --${surface} reaches AA`, () => {
          const ratio = contrastRgb(rgb(tokens[text]), tint(tokens[text], tokens[surface], 0.15));
          assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
        });
      }
    }
  }
});

describe("copies that cannot import the file agree with it", () => {
  const lightHex = hex(light.background);
  const darkHex = hex(dark.background);

  test("browser theme-color follows the background", () => {
    for (const file of ["storefront/components/theme-toggle.tsx", "admin-panel/app/layout.tsx"]) {
      const source = read(file);
      assert.ok(source.includes(lightHex), `${file} light ${lightHex}`);
      assert.ok(source.includes("#0B0F0D"), `${file} dark`);
    }
    assert.ok(Math.abs(parseInt(darkHex.slice(1), 16) - 0x0B0F0D) < 0x020202, "Vault Black stays the dark background");
  });

  for (const file of ["web/public/store/store.css", "web/public/styles.css"]) {
    test(`${file} uses the same paper, ink and accent`, () => {
      const css = read(file);
      const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'));
      assert.match(lightBlock, new RegExp(`--bg:\\s*${lightHex}`));
      assert.match(lightBlock, new RegExp(`--text:\\s*${hex(light.foreground)}`));
      assert.ok(lightBlock.includes(hex(light.primary)), "accent");
      assert.doesNotMatch(css, /rgba\((?:59, 130, 246|37, 99, 235),/, "no blue left over");
    });
  }
});

describe("controls", () => {
  test("buttons take their size from the scale, not from one-off heights", () => {
    for (const file of tsx) {
      assert.equal(/<Button\b[^>]*className="[^"]*\b(?:h|min-h|w|size|text)-(?:\d|\[|xs\b|sm\b|base\b)/.test(read(file)), false, file);
    }
  });

  test("both apps keep the agreed button scale", () => {
    const panel = read("admin-panel/components/ui/button.tsx");
    for (const size of ['default: "h-9 px-4"', 'sm: "h-8 px-3 text-xs"', 'lg: "h-10 px-6"', 'icon: "size-9', '"icon-sm": "size-8']) assert.ok(panel.includes(size), size);
    const store = read("storefront/components/ui/button.tsx");
    for (const size of ['sm: "min-h-10 px-4 text-sm"', 'default: "min-h-11 px-5', 'lg: "min-h-12 px-6 text-base"', 'icon: "size-11']) assert.ok(store.includes(size), size);
  });
});
