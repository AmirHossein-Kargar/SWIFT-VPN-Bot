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
- **Admin dashboard** (`admin-panel/`) is the English Next.js app with `basePath: "/panel"`. Its responses send
  `frame-ancestors 'none'` without `script-src` (Next and next-themes need inline bootstrap scripts).
- The legacy vanilla-JS dashboard files in `web/public/` are still served at `/index.html`; removing them is an owner
  decision.
- **`/panel` has no route loading file under `app/(app)`.** It hung filter navigation and streamed failed pages as 200; see
  `docs/admin.md`. Waiting states live in `admin-panel/components/shared/navigation-pending.tsx`. Success motion and
  toasts follow a server response, never a click.
- Node tests must never request `/panel` on the real app: outside `NODE_ENV=production`, `web/nextAdminMiddleware.js`
  starts a Next.js dev server inside the test process.
