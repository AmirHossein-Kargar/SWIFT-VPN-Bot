/**
 * The public storefront is a Next.js Pages Router static export (storefront/),
 * installed into web/public by `npm run build` (scripts/build-storefront.mjs).
 * These tests run over REAL HTTP against the real Express app and check what
 * only a deployed build can break: the strict CSP (`script-src 'self'`), the
 * routing around it, asset caching/compression, and the SEO surface.
 *
 * They need the build output. If `npm run build:storefront` has not been run
 * they are SKIPPED with an explicit reason (the static fallback page is then
 * what is served, and storefrontAndPanel.test.js still covers that).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import mongoose from "mongoose";
import { makeFakeRedis } from "../helpers/fakeRedis.js";

process.env.ADMINS = "424242";
process.env.GROUP_ID = "";
process.env.BOT_USERNAME = "Swift_servicebot";
process.env.WEBHOOK_BASE_URL = "https://shop.example.com";
mongoose.set("bufferCommands", false);

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const built = existsSync(join(root, "web", "public", "storefront.html"));
const SKIP = built ? false : "storefront build missing — run `npm run build:storefront`";

const auth = await import("../../services/admin/auth.js");
auth.setAdminSessionRedisForTests(makeFakeRedis());
const { STORE_CSP, acceptsEncoding, injectCanonical } = await import("../../web/spa.js");
const { assertCspCompatible } = await import("../../scripts/build-storefront.mjs");
const app = (await import("../../server.js")).default;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  auth.setAdminSessionRedisForTests(null);
});

/** Raw GET with an explicit Accept-Encoding and no automatic decoding. */
function get(path, { encoding, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(encoding ? { "accept-encoding": encoding } : {}), ...extra };
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
const decode = (response) => {
  const encoding = response.headers["content-encoding"];
  if (encoding === "br") return brotliDecompressSync(response.body);
  if (encoding === "gzip") return gunzipSync(response.body);
  return response.body;
};
const text = (response) => decode(response).toString("utf8");

describe("storefront build output is compatible with the strict CSP", { skip: SKIP }, () => {
  test("/ is the Next.js build: Persian RTL, one h1, canonical + SEO tags, no inline executable script", async () => {
    const page = await get("/");
    assert.equal(page.status, 200);
    const html = text(page);
    assert.match(html, /<html[^>]*\blang="fa"[^>]*\bdir="rtl"/);
    assert.match(html, /<div id="__next"/, "served the Next.js build, not the static fallback");
    assert.equal((html.match(/<h1\b/g) || []).length, 1, "exactly one h1");
    assert.match(html, /<link rel="canonical" href="https:\/\/shop\.example\.com\/"\s*\/>/);
    assert.match(html, /<meta property="og:url" content="https:\/\/shop\.example\.com\/"\s*\/>/);
    assert.equal((html.match(/<title\b/g) || []).length, 1, "exactly one title");
    assert.match(html, /<title[^>]*>SWIFT VPN — خرید اشتراک VPN پرسرعت و پایدار<\/title>/);
    assert.equal((html.match(/name="description"/g) || []).length, 1, "exactly one description");
    for (const needle of ['name="description"', 'property="og:image" content="https://shop.example.com/og-image.png"', 'name="twitter:image" content="https://shop.example.com/og-image.png"', 'type="application/ld+json"', 'name="theme-color"', 'rel="manifest" href="/site.webmanifest"', 'rel="apple-touch-icon"', 'property="og:locale" content="fa_IR"']) {
      assert.ok(html.includes(needle), `missing ${needle}`);
    }
    assert.ok(html.includes('<link rel="preload" href="/api/store/catalog" as="fetch" crossorigin="anonymous"'), "catalog request starts during the JS download");
    assert.ok(html.indexOf('rel="preload" href="/api/store/catalog"') < html.indexOf("/_next/static/chunks/main-"), "hint precedes the app scripts");
    assert.doesNotThrow(() => assertCspCompatible(html), "no executable inline script / inline handler / javascript: URL");
  });

  test("the CSP header is unchanged and strict: scripts only from 'self'", async () => {
    const page = await get("/");
    const csp = page.headers["content-security-policy"];
    assert.equal(csp, STORE_CSP, "the storefront policy was not altered for the new build");
    const scriptSrc = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src"));
    assert.equal(scriptSrc, "script-src 'self'");
    assert.doesNotMatch(csp, /unsafe-eval|nonce-|sha\d+-/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["cache-control"], "public, max-age=300");
  });

  test("public responses carry HSTS only over HTTPS, plus COOP/CORP and a tight CSP", async () => {
    const plain = await get("/");
    assert.equal(plain.headers["strict-transport-security"], undefined, "plain HTTP (local dev) is never pinned to HTTPS");
    const secure = await get("/", { headers: { "x-forwarded-proto": "https" } });
    assert.equal(secure.headers["strict-transport-security"], "max-age=15552000");
    assert.doesNotMatch(secure.headers["strict-transport-security"], /includeSubDomains|preload/);
    assert.equal(secure.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(secure.headers["cross-origin-resource-policy"], "same-origin");
    for (const directive of ["frame-src 'none'", "worker-src 'none'", "manifest-src 'self'", "object-src 'none'", "frame-ancestors 'none'"]) {
      assert.ok(STORE_CSP.split("; ").includes(directive), directive);
    }
    const notFound = await get("/no-such-page", { headers: { "x-forwarded-proto": "https" } });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers["strict-transport-security"], "max-age=15552000");
    assert.equal(notFound.headers["referrer-policy"], "strict-origin-when-cross-origin");
    const api = await get("/api/store/nope", { headers: { "x-forwarded-proto": "https" } });
    assert.equal(api.status, 404);
    assert.equal(api.headers["cache-control"], "no-store", "error responses are not cached");
    assert.equal(api.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(api.headers["access-control-allow-origin"], undefined, "no CORS grant on the public API");
  });

  test("the theme is applied before first paint by the external script, which sets the shadcn dark class", async () => {
    const html = text(await get("/"));
    const themeScript = html.indexOf('<script src="/store/theme-init.js"');
    assert.ok(themeScript > -1, "external theme-init.js is referenced");
    assert.ok(themeScript < html.indexOf("<body"), "it is in <head>, before the body renders");
    assert.ok(themeScript < html.indexOf('rel="stylesheet"'), "it runs before the stylesheet paints");
    const init = await get("/store/theme-init.js");
    assert.equal(init.status, 200);
    assert.match(init.body.toString(), /classList\.toggle\("dark"/);
    assert.match(init.body.toString(), /swift\.theme/);
  });

  test("every build asset is served with long-lived immutable caching and the right type", async () => {
    const html = text(await get("/"));
    const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((match) => match[1]);
    assert.ok(assets.some((asset) => asset.endsWith(".js")) && assets.some((asset) => asset.endsWith(".css")));
    for (const asset of new Set(assets)) {
      const response = await get(asset);
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers["cache-control"], "public, max-age=31536000, immutable", asset);
      assert.match(response.headers["content-type"], asset.endsWith(".css") ? /^text\/css/ : /^(?:text|application)\/javascript/, asset);
    }
  });

  test("assets and HTML are served pre-compressed, byte-identical after decoding, with correct negotiation", async () => {
    const html = text(await get("/"));
    const script = [...html.matchAll(/src="(\/_next\/static\/chunks\/main-[^"]+\.js)"/g)][0]?.[1];
    assert.ok(script, "main chunk referenced");
    const identity = await get(script);
    assert.equal(identity.headers["content-encoding"], undefined);

    const br = await get(script, { encoding: "gzip, deflate, br" });
    assert.equal(br.headers["content-encoding"], "br");
    assert.match(br.headers.vary, /Accept-Encoding/i);
    assert.ok(br.body.length < identity.body.length / 2, "brotli is much smaller");
    assert.deepEqual(decode(br), identity.body, "brotli decodes to the original bytes");

    const gz = await get(script, { encoding: "gzip" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(decode(gz), identity.body);

    const refused = await get(script, { encoding: "br;q=0, gzip" });
    assert.equal(refused.headers["content-encoding"], "gzip", "q=0 refuses br");
    assert.equal((await get(script, { encoding: "identity" })).headers["content-encoding"], undefined);

    const pageBr = await get("/", { encoding: "br" });
    assert.equal(pageBr.headers["content-encoding"], "br");
    assert.match(pageBr.headers.vary, /Accept-Encoding/i);
    assert.equal(pageBr.headers["cache-control"], "public, max-age=300");
    assert.equal(pageBr.headers["content-security-policy"], STORE_CSP, "compressed responses keep the CSP");
    assert.equal(text(pageBr), html);
  });

  test("routing around the storefront is intact: panel, direct file names, 404s, API and traversal", async () => {
    // /panel is the Next.js app since the cutover (requesting it would boot Next): /admin redirects there,
    // and the legacy shell kept on disk is still served, still no-store, as /index.html.
    const admin = await get("/admin");
    assert.equal(admin.status, 307);
    assert.equal(admin.headers.location, "/panel");
    const panel = await get("/index.html");
    assert.equal(panel.status, 200);
    assert.match(text(panel), /SWIFT Admin/);
    assert.equal(panel.headers["cache-control"], "no-store");

    for (const path of ["/store.html", "/storefront.html"]) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.match(text(response), /<div id="__next"/, path);
      assert.equal(response.headers["content-security-policy"], STORE_CSP, path);
      assert.equal(response.headers["x-frame-options"], "DENY", path);
      assert.equal(response.headers["cache-control"], "public, max-age=300", path);
    }

    const missing = await get("/_next/static/chunks/does-not-exist.js");
    assert.equal(missing.status, 404);
    assert.ok(!text(missing).includes("SWIFT Admin"), "a missing asset is not answered with the admin shell");
    assert.equal((await get("/_next/static/chunks/../../../server.js")).status, 404, "path traversal cannot leave web/public");
    assert.equal((await get("/_next/static/chunks/../../../../.env")).status, 404);
    assert.equal((await get("/nope")).status, 404);

    const api = await get("/api/store/catalog");
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.body.toString()).ok, true);
    assert.equal((await get("/health")).status, 200);
  });

  test("robots.txt and sitemap.xml are served: storefront indexable, panels and APIs disallowed, absolute canonical URL", async () => {
    const robots = await get("/robots.txt");
    assert.equal(robots.status, 200);
    assert.match(robots.headers["content-type"], /^text\/plain/);
    const body = text(robots);
    for (const line of ["User-agent: *", "Disallow: /panel", "Disallow: /admin", "Disallow: /api/", "Sitemap: https://shop.example.com/sitemap.xml"]) assert.ok(body.includes(line), line);
    assert.doesNotMatch(body, /^Disallow: \/\s*$/m, "the storefront itself is not blocked");

    const sitemap = await get("/sitemap.xml");
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers["content-type"], /^application\/xml/);
    assert.match(text(sitemap), /<loc>https:\/\/shop\.example\.com\/<\/loc>/);
  });

  test("the font is self-hosted: no render-blocking third-party stylesheet, IRANYekanX is the preloaded primary face and Vazirmatn (OFL) the fallback", async () => {
    const html = text(await get("/"));
    assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/, "no third-party font origin in the page");
    const preloads = [...html.matchAll(/<link rel="preload" href="(\/store\/fonts\/[^"]+\.woff2)" as="font" type="font\/woff2" crossorigin="anonymous"/gi)].map((m) => m[1]);
    assert.deepEqual(preloads, ["/store/fonts/iranyekanx-vf.woff2"], "the single variable IRANYekanX file (both scripts, every weight) is the one preload");
    // The proprietary file is gitignored (public repo): where it is absent the page must still work through the Vazirmatn fallback, so only check serving when it is present.
    if (existsSync(join(root, "web", "public", "store", "fonts", "iranyekanx-vf.woff2"))) {
      const font = await get(preloads[0]);
      assert.equal(font.status, 200, preloads[0]);
      assert.match(font.headers["content-type"], /^font\/woff2/, preloads[0]);
      assert.equal(font.body.subarray(0, 4).toString("latin1"), "wOF2", `${preloads[0]} is a real woff2`);
    }
    const css = [...html.matchAll(/href="(\/_next\/static\/css\/[^"]+\.css)"/g)].map((m) => m[1]);
    assert.ok(css.length > 0);
    const styles = (await Promise.all(css.map(async (href) => text(await get(href))))).join("\n");
    assert.match(styles, /@font-face\{[^}]*font-family:"?IRANYekanX"?[^}]*\/store\/fonts\/iranyekanx-vf\.woff2/);
    assert.match(styles, /@font-face\{[^}]*font-family:"?Vazirmatn"?[^}]*\/store\/fonts\/vazirmatn-arabic-wght-normal\.woff2/);
    assert.match(styles, /font-family:IRANYekanX,Vazirmatn,/, "IRANYekanX first, Vazirmatn as the fallback");
  });

  test("the Vazirmatn fallback files and their OFL licence are served", async () => {
    for (const file of ["vazirmatn-arabic-wght-normal.woff2", "vazirmatn-latin-wght-normal.woff2"]) {
      const font = await get(`/store/fonts/${file}`);
      assert.equal(font.status, 200, file);
      assert.equal(font.body.subarray(0, 4).toString("latin1"), "wOF2", `${file} is a real woff2`);
    }
    const license = await get("/store/fonts/OFL.txt");
    assert.equal(license.status, 200, "the OFL license ships with the Vazirmatn font files");
    assert.match(license.headers["content-type"], /^text\/plain/, "readable in the browser, not downloaded as octet-stream");
    assert.match(text(license), /SIL OPEN FONT LICENSE/i);
  });

  test("brand assets referenced by the page are served", async () => {
    const html = text(await get("/"));
    const images = [...new Set([...html.matchAll(/src="(\/brand\/[^"]+\.svg)"/g)].map((match) => match[1]))];
    assert.ok(images.length >= 4, "light + dark lockups present");
    for (const image of images) assert.equal((await get(image)).status, 200, image);
  });

  test("the static HTML carries the Persian content (SEO) and no admin or secret material", async () => {
    const html = text(await get("/"));
    for (const phrase of ["اینترنت آزاد", "پلن‌ها و قیمت‌ها", "خرید در پنج مرحله", "سوالات متداول", "آیا سرویس تست رایگان دارید؟", "سرویس تست رایگان", "پرداخت کارت به کارت", "پرداخت کریپتو", "روی کدام دستگاه استفاده می‌کنید؟"]) assert.ok(html.includes(phrase), phrase);
    // Both payment guides and every device guide are in the static HTML (hidden panels still crawlable), not only the selected tab.
    for (const phrase of ["💳 پرداخت آنلاین کارت به کارت", "🪙 پرداخت با کریپتو", "شبکه را انتخاب کنید", "ویندوز", "macOS"]) assert.ok(html.includes(phrase), phrase);
    for (const id of ["plans", "how", "payment", "devices", "trial", "features", "faq"]) assert.match(html, new RegExp(`<section[^>]*id="${id}"`), `section #${id}`);
    assert.doesNotMatch(html, /SWIFT Admin|BOT_TOKEN|api[_-]?key|secret/i);
    assert.equal(html.includes("/api/admin"), false, "the public page never references the admin API");
    // Every shipped script chunk, too.
    const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((match) => match[1]);
    for (const script of scripts) assert.equal(text(await get(script, { encoding: "gzip" })).includes("/api/admin"), false, script);
  });
});

describe("storefront helpers (no build needed)", () => {
  test("robots.txt and sitemap.xml never emit relative or unescaped URLs", async () => {
    const { robotsTxt, sitemapXml } = await import("../../web/spa.js");
    assert.doesNotMatch(robotsTxt(null), /Sitemap:/, "no sitemap line without a valid public origin");
    assert.match(robotsTxt("https://a.example/"), /Sitemap: https:\/\/a\.example\/sitemap\.xml\n$/);
    assert.equal(sitemapXml(null), null);
    assert.ok(sitemapXml("https://a.example/").includes("<loc>https://a.example/</loc>"));
    assert.ok(sitemapXml('https://a.example/?a=1&b="2"').includes("&amp;") && !sitemapXml('https://a.example/?a=1&b="2"').includes('"2"'));
  });

  test("injectCanonical works with the legacy marker, with Next.js HTML (no marker) and without a canonical", () => {
    assert.equal(injectCanonical("<head><!--canonical--></head>", null), "<head></head>");
    assert.match(injectCanonical("<head><!--canonical--></head>", "https://a.example/"), /<link rel="canonical" href="https:\/\/a\.example\/"/);
    assert.match(injectCanonical("<head><title>t</title></head>", "https://a.example/"), /<title>t<\/title><link rel="canonical"[^>]+\/>\s*<meta property="og:url"[^>]+\/><\/head>/);
    assert.equal(injectCanonical("<head></head>", null), "<head></head>");
    const social = '<head><meta property="og:image" content="/og-image.png"/><meta property="og:image:width" content="1200"/><meta name="twitter:image" content="/og-image.png"/></head>';
    const absolute = injectCanonical(social, "https://a.example/");
    assert.equal((absolute.match(/content="https:\/\/a\.example\/og-image\.png"/g) || []).length, 2, "og:image and twitter:image become absolute");
    assert.ok(absolute.includes('og:image:width" content="1200"'), "other og:image:* tags are untouched");
    assert.equal(injectCanonical(social, null), social, "without a canonical the relative URLs stay as they are");
    assert.ok(!injectCanonical("<head></head>", 'https://a.example/"><script>1</script>').includes("<script>"), "canonical value is escaped");
  });

  test("Accept-Encoding negotiation honours q=0 and ignores unknown tokens", () => {
    assert.equal(acceptsEncoding("gzip, deflate, br", "br"), true);
    assert.equal(acceptsEncoding("br;q=0", "br"), false);
    assert.equal(acceptsEncoding("BR;Q=0.5", "br"), true);
    assert.equal(acceptsEncoding("", "gzip"), false);
    assert.equal(acceptsEncoding(undefined, "gzip"), false);
    assert.equal(acceptsEncoding("brotli", "br"), false);
  });

  test("the build gate rejects anything the CSP would break and accepts a clean export", () => {
    const base = '<html lang="fa" dir="rtl"><head><script src="/a.js"></script><script id="__NEXT_DATA__" type="application/json">{"a":1}</script></head><body><div id="__next"></div></body></html>';
    assert.doesNotThrow(() => assertCspCompatible(base));
    assert.throws(() => assertCspCompatible(base.replace("</head>", "<script>self.__next_f.push([0])</script></head>")), /executable inline <script>/);
    assert.throws(() => assertCspCompatible(base.replace("<div", '<button onclick="x()"></button><div')), /event-handler/);
    assert.throws(() => assertCspCompatible(base.replace("<div", '<a href="javascript:alert(1)">x</a><div')), /javascript:/);
    assert.throws(() => assertCspCompatible(base.replace('lang="fa" dir="rtl"', 'lang="en"')), /lang="fa" dir="rtl"/);
    assert.throws(() => assertCspCompatible(base.replace('<div id="__next">', "<div>")), /#__next/);
  });
});
