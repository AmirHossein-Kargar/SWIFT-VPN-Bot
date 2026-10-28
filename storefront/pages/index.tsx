import Head from "next/head";
import { useEffect, useState } from "react";

import { Faq, FAQ_ITEMS } from "@/components/faq";
import { DeviceGuide } from "@/components/devices";
import { Hero } from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";
import { PaymentGuide } from "@/components/payment-guide";
import { PlansSection } from "@/components/plans";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { Trial } from "@/components/trial";
import { Trust } from "@/components/trust";
import { currentYearLabel } from "@/lib/format";
import { safeExternalUrl } from "@/lib/store";
import { useCatalog } from "@/lib/use-catalog";
import { useReveal } from "@/lib/use-reveal";

const TITLE = "SWIFT VPN — خرید اشتراک VPN پرسرعت و پایدار";
const DESCRIPTION = "خرید اشتراک اختصاصی SWIFT VPN با اتصال نامحدود کاربر و تحویل خودکار لینک و QR در تلگرام. پلن‌ها با قیمت شفاف به تومان، شارژ کیف پول با کارت‌به‌کارت یا ارز دیجیتال و سرویس تست رایگان یک‌روزه.";
const SOCIAL_TITLE = "SWIFT VPN — اشتراک VPN پرسرعت و پایدار";
const SOCIAL_DESCRIPTION = "پلن‌های اختصاصی با اتصال نامحدود کاربر، تحویل خودکار در تلگرام و سرویس تست رایگان یک‌روزه.";

/** FAQPage structured data, generated from the very same entries the accordion renders. `<` is escaped so the JSON can never close its own tag. */
const FAQ_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  inLanguage: "fa",
  mainEntity: FAQ_ITEMS.map((item) => ({ "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })),
}).replace(/</g, "\\u003c");

export default function Home() {
  const { state, duration, setDuration, reload, refresh } = useCatalog();
  const [year, setYear] = useState("");
  // Set after mount: the Persian-calendar year is a runtime value, so rendering
  // it during the static build would not match the client.
  useEffect(() => setYear(currentYearLabel()), []);
  useReveal();

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
        {/* The canonical <link>, og:url and the absolute og:image/twitter:image URLs are injected by web/spa.js from WEBHOOK_BASE_URL. */}
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="fa_IR" />
        <meta property="og:site_name" content="SWIFT VPN" />
        <meta property="og:title" content={SOCIAL_TITLE} />
        <meta property="og:description" content={SOCIAL_DESCRIPTION} />
        <meta property="og:image" content="/og-image.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="لوگوی SWIFT VPN: قفل سبز با حرف S و نوشتهٔ swift روی زمینهٔ تیره" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={SOCIAL_TITLE} />
        <meta name="twitter:description" content={SOCIAL_DESCRIPTION} />
        <meta name="twitter:image" content="/og-image.png" />
        {/* Start the catalog request while the JavaScript downloads instead of after hydration (one request, reused by fetch()). */}
        <link rel="preload" href="/api/store/catalog" as="fetch" crossOrigin="anonymous" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        {/* A JSON data block is not executable, so it is allowed by the storefront CSP (see scripts/build-storefront.mjs). */}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: FAQ_JSON_LD }} />
      </Head>

      <a href="#main" className="sr-only rounded-xl bg-primary px-3.5 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:start-3 focus:top-3 focus:z-[100]">
        پرش به محتوا
      </a>
      <SiteHeader botUrl={botUrl} />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero />
        <PlansSection state={state} duration={duration} onDuration={setDuration} onReload={reload} onRefresh={refresh} />
        <HowItWorks catalog={catalog} />
        <PaymentGuide botUrl={botUrl} />
        <DeviceGuide />
        <Trial botUrl={botUrl} loading={state.status === "loading"} />
        <Trust />
        <Faq botUrl={botUrl} />
      </main>
      <SiteFooter botUrl={botUrl} supportUrl={supportUrl} year={year} />
    </>
  );
}
