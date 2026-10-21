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
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
