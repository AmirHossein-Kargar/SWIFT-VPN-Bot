# Public storefront and routes

The Express server in `server.js` serves the public storefront, both admin dashboards, the
webhook endpoints and the read-only store API from one process.

## Routes

| Path | Serves |
|---|---|
| `/` | Public storefront (Persian, right-to-left, light/dark). Strict CSP; canonical URL derived from `WEBHOOK_BASE_URL` |
| `/panel`, `/admin` | Original static admin dashboard (`noindex`, `no-store`) |
| `/panel` | Next.js admin dashboard, embedded in the same process (`/next-panel`, `/panel-next` and `/admin` redirect here) |
| `/api/store/catalog`, `/api/store/plans/:id` | Public catalog: GET only, rate-limited, customer-safe fields only |
| `/api/admin/*` | Admin JSON API ([reference](admin.md#apiadmin-reference)) |
| `/api/hooshpay/webhook`, `/api/nowpayments/ipn` | Payment webhooks ([details](deployment.md#webhooks)) |
| `/health`, `/livez`, `/ready` | Health probes ([details](deployment.md#health-checks)) |
| anything else | 404 page (API paths get a JSON 404) |

## Checkout hand-off

- Plans, prices (stored Toman, never divided by 10) and durations come from `customerPlans` in
  [`services/plans.js`](../services/plans.js): the same catalog the Telegram shop charges from.
  The API returns only `id, name, days, durationLabel, gig, price`.
- Selecting a plan opens an order review that re-validates the plan on the server
  (`/api/store/plans/:id`) and offers a Telegram link of the form
  `https://t.me/<bot>?start=plan_<id>`. The bot then shows its normal order confirmation and
  re-reads price, traffic and duration at charge time.
- **There is no web checkout.** Wallet, payment providers and orders are bound to the
  customer's Telegram account and there is no customer web login, so payment, order status and
  delivery stay in Telegram.
- Payment-method chips show only providers that are configured on the server.

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

Most of the JavaScript is the React and Next runtime (about 90 kB brotli), which cannot be
reduced without replacing the framework runtime. The static page remains in the repository as
the fallback.

### Security notes

- The storefront CSP is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
  https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:;
  connect-src 'self'; object-src 'none'; frame-ancestors 'none'` (see `STORE_CSP` in
  `web/spa.js`). Google Fonts are the only third-party origin.
- `/panel` responses send `X-Frame-Options: DENY` and `frame-ancestors 'none'` (no
  `script-src`: Next.js and next-themes need inline bootstrap scripts there).

## Verification

- `npm test` includes real-HTTP tests of the built storefront (`tests/integration/storefrontBuild.test.js`),
  skipped with an explicit reason when the build is missing.
- `npm run test:e2e:store` drives real Chrome under the real CSP: hydration, themes and
  persistence, plan selection, the order review and its failure paths, right-to-left layout,
  accessibility (axe-core, if installed) and SEO tags. See [Testing](testing.md).
