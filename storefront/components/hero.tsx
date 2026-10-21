import { Gift, Infinity as InfinityIcon, MonitorSmartphone, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Container } from "@/components/site-chrome";

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden pb-9 pt-10 sm:pb-14 sm:pt-16">
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 -top-24 h-[420px] bg-[radial-gradient(600px_300px_at_20%_30%,hsl(var(--brand)/0.08),transparent_70%),radial-gradient(520px_280px_at_85%_10%,hsl(var(--brand)/0.08),transparent_70%)]" />
      <Container className="relative grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <Badge className="mb-[18px]"><Zap className="size-[15px]" aria-hidden="true" />اشتراک اختصاصی VLESS</Badge>
          <h1 id="hero-title" className="text-[clamp(28px,4.6vw,48px)] font-extrabold leading-[1.35] tracking-tight">
            اینترنت آزاد، <span className="text-brand">سریع و پایدار</span> روی همه دستگاه‌ها
          </h1>
          <p className="mt-[18px] max-w-[600px] text-[clamp(15.5px,1.6vw,17.5px)] text-muted-foreground">
            پلن مناسب خود را انتخاب کنید و خرید را در ربات تلگرام SWIFT کامل کنید. پس از تأیید سفارش، سرویس به‌صورت خودکار ساخته و لینک اتصال برایتان ارسال می‌شود.
          </p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <a href="#plans" className={buttonVariants({ size: "lg" })}>مشاهده پلن‌ها و قیمت‌ها</a>
            <a href="#faq-trial" className={buttonVariants({ size: "lg", variant: "outline" })}><Gift aria-hidden="true" />سرویس تست رایگان</a>
          </div>
          <ul aria-label="ویژگی‌ها" className="mt-[30px] flex flex-wrap gap-x-5 gap-y-2.5 text-sm font-semibold text-muted-foreground">
            <li className="inline-flex items-center gap-2"><InfinityIcon className="size-[18px] text-brand" aria-hidden="true" />اتصال نامحدود کاربر</li>
            <li className="inline-flex items-center gap-2"><MonitorSmartphone className="size-[18px] text-brand" aria-hidden="true" />اندروید، آیفون، ویندوز و مک</li>
            <li className="inline-flex items-center gap-2"><Zap className="size-[18px] text-brand" aria-hidden="true" />تحویل خودکار پس از تأیید</li>
          </ul>
        </div>
        <div aria-hidden="true" className="hidden min-h-[320px] place-items-center lg:grid">
          <div className="card-shadow grid w-[300px] justify-items-center gap-[22px] rounded-3xl border border-border-strong bg-card px-7 pb-7 pt-10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img loading="lazy" decoding="async" className="logo-light h-auto w-32" src="/brand/logo-stacked.svg" alt="" width={128} height={160} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img loading="lazy" decoding="async" className="logo-dark h-auto w-32" src="/brand/logo-stacked-on-dark.svg" alt="" width={128} height={160} />
            <div className="inline-flex items-center gap-2 rounded-full border bg-secondary px-3.5 py-1.5 text-[13px] font-bold text-muted-foreground">
              <span className="size-2 rounded-full bg-success shadow-[0_0_0_4px_hsl(var(--brand)/0.12)]" />
              <span>اتصال امن</span>
              <span dir="ltr">VLESS</span>
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
