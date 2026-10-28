import { CalendarCheck, Gift, MessageCircleQuestion, QrCode, Send, UserCheck } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Facts from services/createTestService.js: one test per Telegram account
 * (`hasReceivedTest`), requested with the «🎁 سرویس تست» menu button, a
 * one-day service, delivered as link + QR in the chat. Traffic limit and other
 * terms are set by the panel, so none is promised here.
 */
const FACTS = [
  { icon: CalendarCheck, title: `${fa(1)} روز`, text: "سرویس تست یک‌روزه است." },
  { icon: UserCheck, title: "یک‌بار برای هر حساب", text: "هر حساب تلگرام فقط یک سرویس تست می‌گیرد." },
  { icon: QrCode, title: "لینک و QR", text: "همان‌جا در چت ربات تحویل داده می‌شود." },
] as const;

const HOW = [
  "ربات را باز کنید و از منوی اصلی «🎁 سرویس تست» را بزنید.",
  "چند لحظه صبر کنید تا سرویس ساخته شود؛ لینک اشتراک و QR در همان چت می‌آید.",
  "طبق راهنمای اتصال همین صفحه، لینک را در یک برنامهٔ سازگار با VLESS وارد کنید.",
];

export function Trial({ botUrl, loading }: { botUrl: string | null; loading: boolean }) {
  return (
    <section id="trial" aria-labelledby="trial-title" className="scroll-mt-[72px] py-[52px] sm:py-[72px]">
      <Container>
        <div data-reveal className="relative overflow-hidden rounded-3xl border border-border-strong bg-card p-6 card-shadow sm:p-10">
          <div aria-hidden="true" className="pointer-events-none absolute -top-24 start-[-60px] size-[320px] rounded-full bg-[radial-gradient(closest-side,hsl(var(--brand)/0.16),transparent)]" />
          <div className="relative grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-border-strong bg-brand/10 px-3 py-1.5 text-[13px] font-extrabold text-brand"><Gift className="size-[15px]" aria-hidden="true" />قبل از خرید امتحان کنید</p>
              <h2 id="trial-title" className="text-[clamp(24px,3.2vw,34px)] font-extrabold leading-snug">سرویس تست رایگان</h2>
              <p className="mt-3 max-w-[540px] text-muted-foreground">
                می‌خواهید قبل از خرید اتصال را روی دستگاه خودتان امتحان کنید؟ از همان ربات تلگرام یک سرویس تست یک‌روزه بگیرید و راهنمای اتصال را روی آن تمرین کنید.
              </p>
              <ol className="mt-5 grid list-none gap-2.5 p-0">
                {HOW.map((item, index) => (
                  <li key={item} className="flex items-start gap-3 text-[14.5px] text-muted-foreground">
                    <span className="mt-0.5 inline-grid size-6 flex-none place-items-center rounded-full bg-brand/10 text-[12.5px] font-extrabold text-brand"><span className="sr-only">مرحلهٔ </span>{fa(index + 1)}</span>
                    {item}
                  </li>
                ))}
              </ol>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {botUrl ? (
                  <a href={botUrl} target="_blank" rel="noopener" className={cn(buttonVariants({ size: "lg" }), "press")}><Send aria-hidden="true" />دریافت سرویس تست رایگان</a>
                ) : (
                  <span className={cn(buttonVariants({ size: "lg" }), "opacity-55")} aria-disabled="true">{loading ? "در حال آماده‌سازی لینک ربات…" : "ربات در حال حاضر در دسترس نیست"}</span>
                )}
                <a href="#devices" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "press")}>راهنمای اتصال</a>
              </div>
              <p className="mt-3 text-[13px] text-faint">پس از ورود به ربات، دکمهٔ «🎁 سرویس تست» را از منوی اصلی بزنید.</p>
            </div>
            <div className="grid gap-3">
              {FACTS.map((fact) => (
                <div key={fact.title} className="lift flex items-center gap-4 rounded-lg border bg-background/60 p-4">
                  <span className="inline-grid size-11 flex-none place-items-center rounded-xl bg-brand/10 text-brand"><fact.icon className="icon-pop size-5" aria-hidden="true" /></span>
                  <div>
                    <p className="font-extrabold">{fact.title}</p>
                    <p className="text-[13.5px] text-muted-foreground">{fact.text}</p>
                  </div>
                </div>
              ))}
              <p className="flex items-start gap-2 text-[12.5px] text-faint"><MessageCircleQuestion className="mt-0.5 size-4 shrink-0" aria-hidden="true" />اگر ساخت سرویس تست ناموفق یا نامشخص بود، ربات پیام می‌دهد و در صورت نیاز باید به پشتیبانی پیام بدهید.</p>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
