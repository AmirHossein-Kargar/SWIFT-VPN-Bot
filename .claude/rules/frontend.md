---
paths:
  - "admin-panel/**"
  - "storefront/**"
  - "web/**"
  - "scripts/build-storefront.mjs"
---

# Frontend invariants

Details: `docs/storefront.md` (storefront) and `docs/admin.md` (dashboard).

- **Storefront** (`storefront/`) is a Next.js Pages Router static export built by `scripts/build-storefront.mjs` into
  git-ignored `web/public/storefront.html` + `web/public/_next/`, served by `web/spa.js` under `STORE_CSP`
  (`script-src 'self'`). No inline scripts: the App Router and inline theme scripts render blank under this CSP, which
  is why the theme comes from `web/public/store/theme-init.js`. Without a build, `/` falls back to
  `web/public/store.html`.
- **Storefront content** is Persian, right-to-left, light/dark. There is no web checkout; orders continue in Telegram.
- **Admin dashboard** (`admin-panel/`) is the English Next.js app with `basePath: "/panel"`. It runs under a nonce-based
  CSP (`web/nextAdminMiddleware.js`), so every page must render per request: never prerender a route or add
  `generateStaticParams`, never add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`, and pass the nonce to any new
  inline script. A third-party origin or a `blob:` needs a deliberate change to `buildPanelCsp`. See `docs/admin.md`.
- **One palette:** `design/theme.css` holds the colours, scrollbars and skeletons for both Next apps. Light mode is
  green-tinted, never plain black and white, and components use tokens. `web/public/store/store.css`, `web/public/styles.css`
  and the `theme-color` values are hand-mapped copies; `tests/unit/themeTokens.test.js` checks AA contrast and that they agree.
- **Buttons** take their size from the variants, never a one-off height: `/panel` 32/36/40 px, the storefront 40/44/48 px. On a
  touch screen both have a 44 px floor, set once for every control: the variants plus the `pointer: coarse` rule in each `globals.css`.
- **Responsive.** The document scrolls, never `<main>`: a scrolling `main` hides overflow from every width check. A new `/panel`
  table uses `<Table stack label>` (`stack="xl"` if it cannot fit a tablet) with `label` on each `TableCell`; wide content that cannot reflow goes in `ScrollRegion`. Do not
  hide a column or a control on phones without another way to reach it. Dialogs, sheets and popovers get their limits from
  `components/ui`, so do not re-add `max-h` or `overflow` per dialog. See `docs/admin.md` and `npm run test:e2e:responsive`.
- The legacy vanilla-JS dashboard files in `web/public/` are still served at `/index.html`; removing them is an owner
  decision.
- **`/panel` has no route loading file under `app/(app)`.** It hung filter navigation and streamed failed pages as 200; see
  `docs/admin.md`. Waiting states live in `admin-panel/components/shared/navigation-pending.tsx`. Success motion and
  toasts follow a server response, never a click.
- **Health claims need evidence.** In `/panel/reliability`, a state, a *Live* label or a moving dot appears only for something measured; silence reads
  *Unknown* or *Stale*, never healthy. See `docs/reliability.md`.
- Node tests must never request `/panel` on the real app: outside `NODE_ENV=production`, `web/nextAdminMiddleware.js`
  starts a Next.js dev server inside the test process.
