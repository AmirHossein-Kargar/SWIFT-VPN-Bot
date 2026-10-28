import { Coins, CreditCard, MousePointerClick, PackageCheck, Send, ShieldCheck, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Container, SectionHeading } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import { PAY_LABELS, type StoreCatalog, visiblePayMethods } from "@/lib/store";

const STEPS = [
  { icon: MousePointerClick, title: "انتخاب پلن", text: "مدت و حجم دلخواه را از بخش پلن‌ها انتخاب و خلاصهٔ سفارش را بررسی کنید.", where: "در این وب‌سایت" },
  { icon: Send, title: "ادامه در تلگرام", text: "با دکمهٔ «ادامه خرید در تلگرام»، ربات همان پلن را برای بررسی و تأیید به شما نشان می‌دهد.", where: "ربات تلگرام" },
  { icon: Wallet, title: "شارژ کیف پول", text: "اگر موجودی کافی نیست، ربات از شما می‌خواهد از «💰 افزایش موجودی» و با یکی از روش‌های فعال، کیف پول را شارژ کنید.", where: "ربات تلگرام" },
  { icon: ShieldCheck, title: "تأیید سفارش", text: "مشخصات و مبلغ را در ربات مرور و با «✅ تایید سفارش» ثبت کنید. مبلغ نهایی همان لحظه دوباره روی سرور محاسبه می‌شود.", where: "ربات تلگرام" },
  { icon: PackageCheck, title: "دریافت اتصال", text: "پس از ساخت موفق سرویس، لینک اشتراک و QR اتصال در همان چت تلگرام ارسال می‌شود و در «📦 سرویس‌های من» هم می‌ماند.", where: "ربات تلگرام" },
] as const;

export function HowItWorks({ catalog }: { catalog: StoreCatalog | null }) {
  const methods = catalog ? visiblePayMethods(catalog) : [];
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-[72px] border-y bg-alt py-[52px] sm:py-[72px]">
      <Container>
        <SectionHeading id="how-title" eyebrow="مرحلهٔ دوم" title="خرید در پنج مرحله">
          این وب‌سایت ویترین فروش است. کیف پول، پرداخت و تحویل سرویس به حساب تلگرام شما وصل است؛ به همین دلیل خرید در ربات نهایی می‌شود و سیستم پرداخت جداگانه‌ای روی وب‌سایت وجود ندارد.
        </SectionHeading>
        <div data-reveal className="relative mx-auto max-w-[760px]">
          {/* connecting line: runs through the centre of the number badges */}
          <span aria-hidden="true" data-reveal className="step-line absolute bottom-6 start-[23px] top-6 w-0.5 rounded bg-gradient-to-b from-brand/60 via-brand/30 to-border" />
          <ol className="relative grid list-none gap-4 p-0">
            {STEPS.map((step, index) => (
              <li key={step.title} className="group relative flex gap-4">
                <span className="relative z-10 inline-grid size-12 flex-none place-items-center rounded-2xl border border-brand/40 bg-card font-extrabold text-brand shadow-[var(--shadow-card)] transition-transform duration-300 group-hover:scale-105">
                  <span className="sr-only">مرحلهٔ </span>{fa(index + 1)}
                </span>
                <div className="lift flex-1 rounded-lg border bg-card px-5 py-4">
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <step.icon className="icon-pop size-5 text-brand" aria-hidden="true" />
                    <h3 className="text-[17px] font-extrabold">{step.title}</h3>
                    <span className="ms-auto rounded-full bg-secondary px-2.5 py-0.5 text-[12px] font-bold text-faint">{step.where}</span>
                  </div>
                  <p className="text-[14.5px] text-muted-foreground">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div aria-label="روش‌های پرداخت فعال" className="mt-9 flex flex-wrap justify-center gap-3">
          {methods.length > 0 ? (
            <>
              <Badge variant="chip"><Wallet className="size-[18px] text-brand" aria-hidden="true" />شارژ کیف پول در ربات با:</Badge>
              {methods.map((method) => {
                const entry = PAY_LABELS[method.id];
                if (!entry) return null;
                const Icon = entry.icon === "card" ? CreditCard : Coins;
                return <Badge key={method.id} variant="chip"><Icon className="size-[18px] text-brand" aria-hidden="true" />{entry.label}</Badge>;
              })}
            </>
          ) : (
            <Badge variant="chipMuted"><Wallet className="size-[18px] text-brand" aria-hidden="true" />روش‌های پرداخت فعال در ربات نمایش داده می‌شوند</Badge>
          )}
        </div>
      </Container>
    </section>
  );
}
