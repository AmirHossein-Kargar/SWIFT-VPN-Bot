import { Html, Head, Main, NextScript } from "next/document";

/**
 * Persian, right-to-left. Dark is the no-JS default; the saved/system theme is
 * applied before first paint by the EXTERNAL /store/theme-init.js, because the
 * storefront CSP (`script-src 'self'`) forbids inline scripts. This document
 * emits no executable inline script (scripts/build-storefront.mjs verifies it).
 */
export default function Document() {
  return (
    <Html lang="fa" dir="rtl" className="dark" data-theme="dark">
      <Head>
        <script src="/store/theme-init.js" />
        {/* Self-hosted font (see globals.css). Fonts are always fetched in CORS mode, so the preload needs crossOrigin. */}
        <link rel="preload" href="/store/fonts/iranyekanx-vf.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
