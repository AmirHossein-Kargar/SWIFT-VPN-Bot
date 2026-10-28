import { CreditCard, Gift, Infinity as InfinityIcon, Laptop, MonitorSmartphone, Send, Smartphone, Tablet, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/site-chrome";
import { cn } from "@/lib/utils";

/** Hub-and-spoke composition: the Telegram bot delivers the connection to the customer's devices. Decorative. */
const PATHS = {
  bot: "M 70 238 C 120 238 150 200 188 184",
  phone: "M 212 160 C 190 120 150 96 112 82",
  laptop: "M 238 156 C 262 120 300 96 336 82",
  tablet: "M 238 202 C 270 226 306 238 336 238",
} as const;

function Node({ className, children, label }: { className: string; children: React.ReactNode; label: string }) {
  return (
    <div className={cn("absolute grid -translate-x-1/2 -translate-y-1/2 justify-items-center gap-1.5", className)}>
      <span className="glass grid size-[52px] place-items-center rounded-2xl border border-border-strong text-foreground shadow-[var(--shadow-card)] sm:size-14 [&_svg]:size-[22px]">{children}</span>
      <span className="whitespace-nowrap text-[11.5px] font-bold text-muted-foreground">{label}</span>
    </div>
  );
}

function ConnectionArt() {
  return (
    <div aria-hidden="true" className="relative mx-auto aspect-[4/3] w-full max-w-[440px]">
      <div className="bg-grid absolute inset-0" />
      <div className="absolute left-1/2 top-1/2 size-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,hsl(var(--brand)/0.16),transparent)]" />
      <svg viewBox="0 0 400 300" className="absolute inset-0 size-full" fill="none">
        {Object.values(PATHS).map((d) => (
          <g key={d}>
            <path d={d} pathLength={100} stroke="hsl(var(--brand) / 0.35)" strokeWidth="1.5" className="flow-line" />
            <path d={d} pathLength={100} stroke="hsl(var(--brand))" strokeWidth="5" className="flow-packet" />
          </g>
        ))}
        <circle cx="200" cy="150" r="58" stroke="hsl(var(--brand) / 0.5)" strokeWidth="1" className="node-pulse" />
      </svg>
      <div className="absolute left-1/2 top-1/2 grid size-[92px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[28px] border border-border-strong bg-card shadow-[var(--shadow-card-hover)] sm:size-24">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo-light size-[52px]" src="/brand/icon.svg" alt="" width={52} height={52} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo-dark size-[52px]" src="/brand/icon-on-dark.svg" alt="" width={52} height={52} />
      </div>
      <Node className="left-[17.5%] top-[79%]" label="ربات تلگرام"><Send /></Node>
      <Node className="left-[28%] top-[27%]" label="اندروید و آیفون"><Smartphone /></Node>
      <Node className="left-[84%] top-[27%]" label="ویندوز و مک"><Laptop /></Node>
      <Node className="left-[84%] top-[79%]" label="آیپد و تبلت"><Tablet /></Node>
    </div>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden pb-10 pt-9 sm:pb-16 sm:pt-16">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-[520px] bg-[radial-gradient(640px_320px_at_18%_30%,hsl(var(--brand)/0.10),transparent_70%),radial-gradient(520px_300px_at_88%_8%,hsl(var(--brand)/0.08),transparent_70%)]" />
      <Container className="relative grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
        <div>
          <Badge className="mb-[18px]"><Zap className="size-[15px]" aria-hidden="true" />اشتراک اختصاصی VLESS</Badge>
          <h1 id="hero-title" className="text-[clamp(29px,4.8vw,50px)] font-extrabold leading-[1.35] tracking-tight">
            اینترنت آزاد، <span className="text-brand">سریع و پایدار</span> روی همه دستگاه‌ها
          </h1>
          <p className="mt-[18px] max-w-[580px] text-[clamp(15.5px,1.6vw,17.5px)] text-muted-foreground">
            پلن مناسب را انتخاب کنید، خرید را در ربات تلگرام سویفت تأیید کنید و لینک و QR اتصال را همان‌جا تحویل بگیرید. نیازی به ساخت حساب جداگانه در وب‌سایت نیست.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <a href="#plans" className={cn(buttonVariants({ size: "lg" }), "press shadow-[0_10px_30px_-10px_hsl(var(--brand)/0.7)] sm:min-w-[230px]")}>مشاهده پلن‌ها و قیمت‌ها</a>
            <a href="#trial" className={cn(buttonVariants({ size: "lg", variant: "outline" }), "press")}><Gift aria-hidden="true" />سرویس تست رایگان</a>
          </div>
          <ul aria-label="ویژگی‌ها" className="mt-8 grid list-none gap-x-6 gap-y-3 p-0 text-sm font-semibold text-muted-foreground sm:grid-cols-2">
            <li className="inline-flex items-center gap-2.5"><InfinityIcon className="size-[18px] shrink-0 text-brand" aria-hidden="true" />اتصال نامحدود کاربر در همه پلن‌ها</li>
            <li className="inline-flex items-center gap-2.5"><MonitorSmartphone className="size-[18px] shrink-0 text-brand" aria-hidden="true" />اندروید، آیفون، ویندوز و مک</li>
            <li className="inline-flex items-center gap-2.5"><Zap className="size-[18px] shrink-0 text-brand" aria-hidden="true" />تحویل خودکار پس از تأیید سفارش</li>
            <li className="inline-flex items-center gap-2.5"><CreditCard className="size-[18px] shrink-0 text-brand" aria-hidden="true" />پرداخت کارت‌به‌کارت یا ارز دیجیتال</li>
          </ul>
        </div>
        <ConnectionArt />
      </Container>
    </section>
  );
}
