import Head from "next/head";
import { useEffect, useState } from "react";

import { Hero } from "@/components/hero";
import { Faq, HowItWorks } from "@/components/info-sections";
import { PlansSection } from "@/components/plans";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { currentYearLabel } from "@/lib/format";
import { safeExternalUrl } from "@/lib/store";
import { useCatalog } from "@/lib/use-catalog";

const TITLE = "SWIFT VPN — خرید اشتراک VPN پرسرعت و پایدار";
const DESCRIPTION = "خرید اشتراک اختصاصی SWIFT VPN با اتصال نامحدود کاربر، تحویل خودکار در تلگرام و پرداخت آنلاین. پلن‌های یک‌ماهه تا یک‌ساله با قیمت شفاف به تومان.";

export default function Home() {
  const { state, duration, setDuration, reload, refresh } = useCatalog();
  const [year, setYear] = useState("");
  // Set after mount: the Persian-calendar year is a runtime value, so rendering
  // it during the static build would not match the client.
  useEffect(() => setYear(currentYearLabel()), []);

  const catalog = state.status === "ready" || state.status === "empty" ? state.catalog : null;
  const botUrl = catalog?.checkout.available ? safeExternalUrl(catalog.checkout.botUrl) : null;
  const supportUrl = safeExternalUrl(catalog?.support.url);

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="description" content={DESCRIPTION} />
        <meta name="color-scheme" content="dark light" />
        <meta name="theme-color" content="#0B0F0D" />
        {/* The canonical <link> and og:url are injected by web/spa.js from WEBHOOK_BASE_URL. */}
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="fa_IR" />
        <meta property="og:site_name" content="SWIFT VPN" />
        <meta property="og:title" content="SWIFT VPN — اشتراک VPN پرسرعت و پایدار" />
        <meta property="og:description" content="پلن‌های اختصاصی با اتصال نامحدود کاربر و تحویل خودکار در تلگرام." />
        <meta property="og:image" content="/og-image.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        {/* Start the catalog request while the JavaScript downloads instead of after hydration (one request, reused by fetch()). */}
        <link rel="preload" href="/api/store/catalog" as="fetch" crossOrigin="anonymous" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
      </Head>

      <a href="#main" className="sr-only rounded-xl bg-primary px-3.5 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-[100]">
        پرش به محتوا
      </a>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <PlansSection state={state} duration={duration} onDuration={setDuration} onReload={reload} onRefresh={refresh} />
        <HowItWorks catalog={catalog} />
        <Faq botUrl={botUrl} />
      </main>
      <SiteFooter botUrl={botUrl} supportUrl={supportUrl} year={year} />
    </>
  );
}
