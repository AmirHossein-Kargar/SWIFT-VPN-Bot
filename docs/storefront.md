# Public storefront and routes

The Express server in `server.js` serves the public storefront, both admin dashboards, the
webhook endpoints and the read-only store API from one process.

## Routes

| Path | Serves |
|---|---|
| `/` | Public storefront (Persian, right-to-left, light/dark). Strict CSP; canonical URL derived from `WEBHOOK_BASE_URL` |
| `/robots.txt`, `/sitemap.xml` | Crawler rules (panels and `/api/` disallowed) and a one-URL sitemap; both use the absolute origin from `WEBHOOK_BASE_URL` (the sitemap is a 404 without a valid public HTTPS one) |
| `/panel` | Next.js admin dashboard, embedded in the same process (`web/nextAdminMiddleware.js`, mounted before the static handler). `/next-panel` and `/panel-next` redirect here (308), `/admin` redirects here (307) |
| `/index.html` | The original static admin dashboard, kept on disk and still served (`noindex`, `no-store`); no longer reachable at `/panel` |
| `/api/store/catalog`, `/api/store/plans/:id` | Public catalog: GET only, rate-limited, customer-safe fields only |
| `/api/admin/*` | Admin JSON API ([reference](admin.md#apiadmin-reference)) |
| `/api/hooshpay/webhook`, `/api/nowpayments/ipn` | Payment webhooks ([details](deployment.md#webhooks)) |
| `/health`, `/livez`, `/ready` | Health probes ([details](deployment.md#health-checks)) |
| anything else | 404 page (API paths get a JSON 404) |

## Checkout hand-off

- Plans, prices (stored Toman, never divided by 10) and durations come from `customerPlans` in
  [`services/plans.js`](../services/plans.js): the same catalog the Telegram shop charges from. An unlimited product appears only
  while the provider has unlimited switched on for this account ([WizardXray](wizardxray.md#unlimited)).
  The API returns only `id, name, days, durationLabel, gig, price`.
- Selecting a plan opens an order review that re-validates the plan on the server
  (`/api/store/plans/:id`) and offers a Telegram link of the form
  `https://t.me/<bot>?start=plan_<id>`. The bot then shows its normal order confirmation and
  re-reads price, traffic and duration at charge time.
- **There is no web checkout.** Wallet, payment providers and orders are bound to the
  customer's Telegram account and there is no customer web login, so payment, order status and
  delivery stay in Telegram.
- Payment-method chips show only providers that are configured on the server.

## Page structure and content rules

`storefront/pages/index.tsx` composes the sections in this order (anchor ids in brackets):
hero, plans `#plans`, how it works `#how`, payment guide `#payment`, device guide `#devices`,
free trial `#trial`, trust `#features`, FAQ `#faq`, footer. The header links to plans, features,
payment, devices and FAQ and has a mobile menu (`aria-expanded`, closes on Escape/selection).

- **Everything is server-rendered into the static HTML**, including the inactive payment and
  device tabs (`TabsContent forceMount`, hidden), so none of it depends on JavaScript to be
  indexed. Only the catalog-driven parts (plans, bot link, support link, payment chips) need
  the API.
- **Copy mirrors the bot, not marketing.** The "card-to-card" guide describes `payHoosh.js`
  (HooshPay: amount 10,000–50,000,000 toman, invoice with payment link, «✅ پرداخت کردم»
  verification, no receipt upload) and the crypto guide describes `payNowPayments.js`
  (coin, then network, then amount, estimate, invoice link, status check). Mockups use the
  real button labels but placeholder values; no card number, address or amount is real. The
  trial text (one day, once per Telegram account, via «🎁 سرویس تست») comes from
  `services/createTestService.js`. When the bot's flow changes, update `lib/topup-guide.json`,
  `trial.tsx` and `faq.tsx` with it.
- **Wallet top-up guide.** `storefront/lib/topup-guide.json` is the single source for the steps. `payment-guide.tsx`
  renders it as a stepper (progress bar, step list with arrow keys, previous/next, one step visible; every step stays
  in the static HTML, and without JavaScript all of them show), and images enlarge in a lazy dialog
  (`guide-lightbox.tsx`) that stays in step with the guide. `tests/unit/topupGuide.test.js` pins every button, title
  and `verbatim` line to the bot's source, so a renamed button fails a test instead of leaving the guide wrong.
- **Guide images are illustrations, not screenshots.** Telegram is not reachable from the build, so
  `npm run build:guide-images` draws `web/public/store/guide/<id>.webp` (800×1000) from that JSON with the bot's real
  labels and masked placeholder values; captions say what is a sample. Steps at the payment provider are diagrams,
  labelled as such in the image, never an imitation of its screen, and no image shows a successful payment. A real screenshot can replace
  a file at the same path and 4:5 ratio; change that step's caption and its `kind` with it. Neither offered method
  has a receipt step, and the guide says so.
- **Deliberately absent:** testimonials, user counts, ratings, uptime or speed claims,
  discounts, countdowns, crossed-out prices, refund or response-time promises, and named client
  apps (their names and links cannot be verified from this repository; the guide links the
  bot's own `t.me/swift_shield/<n>` posts for Android, iPhone and Windows instead).
- **Plan highlight:** the only badge is «کمترین قیمت هر گیگ» (`lowestPerGbPlanId`), a computed
  fact that appears only when one plan is strictly cheapest per GB.
- **Motion:** CSS only (transitions, a looping dash/packet animation in the hero art, the FAQ
  open animation, a sliding tab pill measured in `ui/tabs.tsx`, slow background light on the plans and
  payment sections, direction-aware guide steps). The header marks the section in view (`aria-current`). Scroll reveal (`lib/use-reveal.ts`) hides only blocks that start below the
  fold after hydration, never plans, and is skipped under `prefers-reduced-motion`, which also
  switches the decorative loops off.

### Metadata

The storefront is a Pages Router export, so metadata is declared in `<Head>` in
`pages/index.tsx` (the App Router `app/icon.*` conventions do not apply and the App Router is
unusable under this CSP). Icons are the existing brand assets in `web/public`: `favicon.svg`
(light/dark aware), `favicon.ico`, `apple-touch-icon.png`, `icon-192/512.png` via
`site.webmanifest`, and the 1200×630 `og-image.png`. `web/spa.js` injects the canonical link and
`og:url` and rewrites the site-relative `og:image` / `twitter:image` URLs to absolute ones from
`WEBHOOK_BASE_URL` (crawlers need absolute URLs; they read the server HTML, not the
client-rendered head). A `FAQPage` JSON-LD data block is generated from the same entries as the
accordion. The admin panel has its own icons and is untouched.

## Build and serving

The storefront (`storefront/`) is a **Next.js Pages Router static export** using shadcn/ui and
Tailwind. It is deliberately the *Pages* Router: its export has no executable inline scripts,
so it runs under the unchanged storefront CSP (`script-src 'self'`). The App Router export
inlines `self.__next_f.push(...)` scripts and renders a blank page under that policy — do not
switch to it.

| Step | What happens |
|---|---|
| `npm run build` (storefront part: `npm run build:storefront`) | `scripts/build-storefront.mjs` runs `next build storefront`, **refuses** output with executable inline scripts, inline event handlers or `javascript:` URLs, installs `storefront.html` and `_next/` into `web/public` (git-ignored build output) with pre-compressed `.br`/`.gz` copies, and deletes the build cache. `npm run build` also builds the `/panel` admin dashboard |
| Serving (`web/spa.js`) | `/` serves `storefront.html`, falling back to the static `web/public/store.html` if the build is missing, so the site stays up. It injects the canonical link from `WEBHOOK_BASE_URL`, compresses the HTML once per encoding and serves `/_next/static/**` pre-compressed with `Cache-Control: public, max-age=31536000, immutable` |
| Fonts | **IRANYekanX** (proprietary, fontiran.com) is the primary face in the storefront and the admin panel: one variable woff2, `web/public/store/fonts/iranyekanx-vf.woff2`, preloaded by the storefront, with Vazirmatn as the fallback. **Licence NOT confirmed:** publishing it needs a fontiran.com web licence registered for this project (licence code in `FontLicense.txt` next to the font and in a CSS comment); none is on record. The file is gitignored and must be placed on the server by hand; without it the sites fall back to Vazirmatn. Vazirmatn is self-hosted (OFL-1.1; license text in `OFL.txt` next to the fonts, served as `text/plain`) in `web/public/store/fonts/`: variable weight, Arabic and Latin subsets split by `unicode-range`. `.woff2` files are served with a 30-day cache. The former Google Fonts stylesheet blocked first render and its late swap shifted the hero heading (Lighthouse CLS 0.09 on mobile) |
| Theme | The external `web/public/store/theme-init.js` sets `data-theme` and the `dark` class before first paint (no inline script, so no CSP change) |
| Plan loading | The catalog request is preloaded in `<head>` so it overlaps the JavaScript download and is reused by the app's `fetch()`. Retries and the refresh after "plan no longer sold" bypass the HTTP cache. The order dialog (Radix Dialog) is a separate chunk fetched on pointer/focus/touch intent over a plan. Tabs are a small in-repo component |
| Development | `npm run storefront:dev` (port 3101) and `npm run admin:dev` (port 3100). Remove `storefront/.next` and `admin-panel/.next` afterwards: the module smoke test imports stray `.js` files |

### Performance notes

Measured in Chrome with a cold cache at 375 px, on simulated slow 4G (1.6 Mbit/s, 150 ms RTT)
and a 4× slower CPU, third-party fonts blocked on both pages, median of 9 runs:

| | Storefront (Next.js) | Previous static page |
|---|---|---|
| Transfer (own origin) | about 125 kB | about 70 kB (served uncompressed) |
| JavaScript | about 108 kB | about 18 kB |
| First paint | about 0.84 s | about 0.98 s |
| Plans visible | about 1.9 s | about 1.5 s |

Lighthouse 13.5 (lab data only, local production build, Chrome headless, its default simulated
throttling; no field/CrUX data exists for this site). Three runs each, after self-hosting the font:

| | Performance | LCP | CLS | TBT | Accessibility / Best practices / SEO |
|---|---|---|---|---|---|
| Mobile (before: render-blocking Google Fonts) | 69 | 4.6 s | 0.09 | 0 ms | 100 / 100 / 100 |
| Mobile (after) | 89–96 | 2.8–3.0 s | 0 | 50–190 ms | 100 / 100 / 100 |
| Desktop (before) | 93 | 1.2 s | 0.078 | 0 ms | 100 / 100 / 100 |
| Desktop (after) | 100 | 0.6–0.7 s | 0 | 10–20 ms | 100 / 100 / 100 |

INP needs real interaction and is not produced by a Lighthouse navigation run.

Comparing changes here needs both builds alternated on one machine: separate batches differed by more than any change
tested (LCP 1.7 s to 2.8 s for one build), and LCP is bimodal, because the font swap can repaint the heading. A PC with
IRANYekanX installed also hides the "file missing" case, since Chrome falls back to the local face; rename the family in
a copy of the built CSS to simulate a visitor. Measured that way (slow 4G, 4× CPU, 2026-10-31):

- **Kept:** guide images past step one load only once someone uses the guide, and the hero icons load lazily, which cut a
  first visit by about 38 kB and 3 requests with timing unchanged within noise. Skeletons stay still until hydration, the
  hero's loops pause off screen, and `.glass` no longer uses `backdrop-filter`.
- **Rejected:** `content-visibility: auto` on sections took about 0.5 s off first paint but sent 12 of 14 anchor checks
  up to thousands of pixels off target. Dropping the font preload made no reliable difference with the file present and
  raised CLS from 0.01 to 0.066 without it. Preloading Vazirmatn instead was slower.

After the landing-page redesign the page's own JavaScript grew by about 5 kB brotli (framework
58 kB, main 30 kB, page 17 kB, plus a 6 kB shared chunk; the order dialog stays a lazy chunk),
and the server-rendered HTML is about 14 kB brotli. The load-timing table above was not
re-measured after that change.

Most of the JavaScript is the React and Next runtime (about 90 kB brotli), which cannot be
reduced without replacing the framework runtime. The static page remains in the repository as
the fallback.

### Security notes

- The storefront CSP is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
  https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none'` (see `STORE_CSP` in
  `web/spa.js`). The Next.js page itself no longer uses any third-party origin; the Google Fonts
  entries stay only because the static fallback `store.html` and `404.html` still load that font.
- **Dependency overrides** (`package.json` → `overrides`): `next`'s exact-pinned `postcss@8.4.31`
  (GHSA-qx2v-qp2m-jg93, -6g55-p6wh-862q, -fxqj-rqcc-2cmp, -r28c-9q8g-f849; all fixed by 8.5.23)
  is replaced by the project's own `postcss` (`"next": { "postcss": "$postcss" }`), and
  `postcss-selector-parser` is pinned to 7.1.7 (GHSA-rj75-hqrm-r3gf, fixed in 7.1.6). Both only run at
  build time on repository CSS; the generated CSS of the storefront and the admin panel was verified
  byte-identical before and after. Remove the overrides once Next and Tailwind ship patched versions
  themselves. `zod` is 4.6.7 and `@hookform/resolvers` 5.9.2 (GHSA-mrhx-c7xc-m3w5, fixed in zod 4.6.6: a
  `.max()`/`.length()` bound on arrays, sets and maps is now checked before any element is parsed;
  unbounded arrays are unchanged). Only the two `/panel` forms use zod, in the browser; their schemas
  live in `admin-panel/lib/form-schemas.ts` and are tested by `tests/unit/adminFormSchemas.test.js` and
  the form scenarios of `tests/e2e/nextPanel.e2e.mjs`. Zod 4 words its default messages differently
  (for example for an empty number field); the messages the forms define themselves are unchanged.
- `/panel` has its own policy with a per-response script nonce; see [browser protections](admin.md#browser-protections).

## Verification

- `npm test` includes real-HTTP tests of the built storefront (`tests/integration/storefrontBuild.test.js`),
  skipped with an explicit reason when the build is missing.
- `npm run test:e2e:store` drives real Chrome under the real CSP: hydration, themes and
  persistence, plan selection, the order review and its failure paths, right-to-left layout,
  accessibility (axe-core, if installed) and SEO tags. See [Testing](testing.md).
