import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, Coins, CreditCard, FileSearch, Maximize2, Send } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Container, SectionHeading } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import guide from "@/lib/topup-guide.json";
import { cn } from "@/lib/utils";

/**
 * Everything here describes what the bot does today (paymentHandlers/payHoosh.js for card-to-card,
 * paymentHandlers/payNowPayments.js for crypto). The steps and images come from lib/topup-guide.json, which
 * tests/unit/topupGuide.test.js pins to the bot's source. Images are labelled illustrations with placeholder values.
 */
export interface GuideStep { id: string; label: string; kind: string; title: string; text: string; caption: string; alt: string }

// Radix Dialog is only needed once an image is enlarged, so the lightbox is its own chunk (shared with the order dialog).
const loadLightbox = () => import("@/components/guide-lightbox").then((module) => module.GuideLightbox);
const GuideLightbox = dynamic(loadLightbox, { ssr: false });

export const guideImage = (step: GuideStep) => `/store/guide/${step.id}.webp`;

function StepFlow({ steps, label }: { steps: GuideStep[]; label: string }) {
  const [current, setCurrent] = useState(0);
  const [direction, setDirection] = useState<"next" | "back" | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLOListElement>(null);

  const go = (index: number) => {
    setDirection(index >= current ? "next" : "back");
    setCurrent(index);
  };

  useEffect(() => {
    // Centre the active step in the phone-width strip. A delta, because scrollLeft is negative in RTL, and never
    // scrollIntoView, which would also move the page.
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!nav || !active) return;
    const from = nav.getBoundingClientRect();
    const to = active.getBoundingClientRect();
    nav.scrollBy({ left: to.left + to.width / 2 - (from.left + from.width / 2) });
    // The next image is usually wanted right away; hidden lazy images would otherwise only start loading on arrival.
    const next = steps[current + 1];
    if (next) new Image().src = guideImage(next);
  }, [current, steps]);

  const closeLightbox = () => {
    setEnlarged(false);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>("[data-guide-step]:not([hidden]) [data-enlarge]")?.focus());
  };

  const moveFocusBy = (event: React.KeyboardEvent, index: number) => {
    // Arrow keys follow the reading direction, like the tabs above.
    const delta = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    const target = index + delta;
    if (delta === 0 || target < 0 || target >= steps.length) return;
    event.preventDefault();
    go(target);
    navRef.current?.querySelectorAll("button")[target]?.focus();
  };

  const progress = (current + 1) / steps.length;
  return (
    <div ref={rootRef}>
      <div className="mb-3 flex items-center justify-between gap-3 text-[13.5px] font-bold">
        <p aria-live="polite">مرحلهٔ {fa(current + 1)} از {fa(steps.length)}<span className="text-muted-foreground">: {steps[current]?.title}</span></p>
      </div>
      <div aria-hidden="true" className="mb-4 h-1.5 overflow-hidden rounded-full bg-secondary">
        <span className="guide-progress block h-full rounded-full bg-brand" style={{ transform: `scaleX(${progress})` }} />
      </div>

      <ol ref={navRef} aria-label={label} className="guide-nav mb-6 flex list-none gap-2 overflow-x-auto p-1">
        {steps.map((step, index) => {
          const active = index === current;
          return (
            <li key={step.id} className="flex-none sm:flex-1">
              <button
                type="button"
                aria-current={active ? "step" : undefined}
                data-done={index < current ? "true" : undefined}
                onClick={() => go(index)}
                onKeyDown={(event) => moveFocusBy(event, index)}
                className="press guide-step-button flex min-h-11 w-full items-center gap-2 whitespace-nowrap rounded-xl border bg-card px-3 text-[13.5px] font-bold text-muted-foreground hover:border-brand/50 hover:text-foreground"
              >
                <span className="guide-step-number inline-grid size-6 flex-none place-items-center rounded-full bg-secondary text-[12px] font-extrabold"><span className="sr-only">مرحلهٔ </span>{fa(index + 1)}</span>
                {step.label}
              </button>
            </li>
          );
        })}
      </ol>

      {steps.map((step, index) => (
        // `hidden` keeps every step in the static HTML; the layout lives on an inner element because a display utility would override it.
        <div key={step.id} data-guide-step hidden={index !== current}>
          <div className={cn("grid items-start gap-5 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)] md:gap-8", index === current && direction && `guide-in-${direction}`)}>
            <figure className="m-0 min-w-0">
              <button
                type="button"
                data-enlarge
                onPointerEnter={() => void loadLightbox()}
                onFocus={() => void loadLightbox()}
                onClick={() => setEnlarged(true)}
                className="press group relative block aspect-[4/5] w-full max-w-[360px] overflow-hidden rounded-2xl border border-border-strong bg-secondary max-md:mx-auto"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={guideImage(step)} alt={step.alt} width={400} height={500} loading="lazy" decoding="async" className="size-full object-cover" />
                <span className="glass absolute bottom-2.5 end-2.5 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-bold text-foreground transition-transform group-hover:scale-105">
                  <Maximize2 className="size-3.5" aria-hidden="true" />بزرگ‌نمایی تصویر
                </span>
              </button>
              <figcaption className="mx-auto mt-2 max-w-[360px] text-[12.5px] leading-relaxed text-faint">{step.caption}</figcaption>
            </figure>
            <div className="min-w-0">
              <p className="mb-1 text-[13px] font-extrabold text-brand">مرحلهٔ {fa(index + 1)}</p>
              <h3 className="text-[19px] font-extrabold leading-snug">{step.title}</h3>
              <p className="mt-2 text-[15px] text-muted-foreground">{step.text}</p>
              <div className="mt-5 flex flex-wrap gap-2.5">
                {index > 0 ? (
                  <Button variant="outline" onClick={() => go(index - 1)}><ChevronRight aria-hidden="true" />مرحلهٔ قبل</Button>
                ) : null}
                {index < steps.length - 1 ? (
                  <Button onClick={() => go(index + 1)}>مرحلهٔ بعد<ChevronLeft aria-hidden="true" /></Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ))}

      {enlarged ? <GuideLightbox steps={steps} index={current} onIndex={go} onClose={closeLightbox} /> : null}
    </div>
  );
}

function Callout({ tone, title, children }: { tone: "warn" | "info"; title: string; children: React.ReactNode }) {
  return (
    <div className={cn("mt-8 flex gap-3 rounded-lg border p-4", tone === "warn" ? "border-destructive/40 bg-destructive/10" : "border-border-strong bg-card")}>
      {tone === "warn" ? <CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" /> : <FileSearch className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />}
      <div>
        <p className="mb-1.5 font-extrabold">{title}</p>
        <div className="text-[14px] text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function PaymentGuide({ botUrl }: { botUrl: string | null }) {
  const [method, setMethod] = useState("card");
  return (
    <section id="payment" aria-labelledby="payment-title" className="aurora relative isolate scroll-mt-[72px] overflow-clip py-[52px] sm:py-[72px]">
      <Container>
        <SectionHeading id="payment-title" eyebrow="راهنمای تصویری" title="شارژ کیف پول: کارت‌به‌کارت یا ارز دیجیتال">
          پرداخت‌ها داخل ربات تلگرام انجام می‌شود، نه روی این صفحه. قبل از شروع ببینید هر روش دقیقاً چه مراحلی دارد. روش‌هایی که در لحظهٔ خرید در ربات فعال باشند قابل انتخاب‌اند.
        </SectionHeading>
        <div data-reveal>
          {/* Without JavaScript the stepper cannot switch, so every step and both methods stay readable. */}
          <noscript><style>{"[data-guide-step][hidden], #payment [role=tabpanel][hidden] { display: block; margin-bottom: 24px; }"}</style></noscript>
          <Tabs value={method} onValueChange={setMethod} dir="rtl">
            <TabsList aria-label="روش پرداخت" className="mb-8 grid w-full max-w-[460px] grid-cols-2">
              <TabsTrigger value="card" className="gap-2 px-3 max-sm:flex-col max-sm:gap-1 max-sm:py-2 max-sm:leading-snug max-sm:text-balance"><CreditCard className="size-[18px]" aria-hidden="true" />پرداخت کارت به کارت</TabsTrigger>
              <TabsTrigger value="crypto" className="gap-2 px-3 max-sm:flex-col max-sm:gap-1 max-sm:py-2 max-sm:leading-snug max-sm:text-balance"><Coins className="size-[18px]" aria-hidden="true" />پرداخت کریپتو</TabsTrigger>
            </TabsList>

            <TabsContent value="card" forceMount className="animate-rise">
              <StepFlow steps={guide.card} label="مراحل پرداخت کارت‌به‌کارت" />
              <Callout tone="info" title="نکته‌هایی که پرسش پشتیبانی را کم می‌کند">
                <ul className="grid list-disc gap-1 ps-5">
                  <li>همیشه مبلغ «قابل پرداخت» فاکتور را واریز کنید؛ ممکن است با مبلغ درخواستی شما فرق داشته باشد، چون کارمزد درگاه، اگر وجود داشته باشد، در فاکتور نوشته می‌شود.</li>
                  <li>فاکتور مهلت دارد. اگر منقضی شد، فاکتور جدید بسازید و به فاکتور قدیمی پرداخت نکنید.</li>
                  <li>تأیید پرداخت با درگاه است و زمان ثابتی ندارد. اگر پرداخت کرده‌اید اما موجودی اضافه نشد، شناسهٔ فاکتور را برای پشتیبانی بفرستید.</li>
                </ul>
              </Callout>
            </TabsContent>

            <TabsContent value="crypto" forceMount className="animate-rise">
              <StepFlow steps={guide.crypto} label="مراحل پرداخت با ارز دیجیتال" />
              <Callout tone="warn" title="قبل از ارسال حتماً بررسی کنید">
                <ul className="grid list-disc gap-1 ps-5">
                  <li>رمزارز و شبکه باید دقیقاً همان باشند که در فاکتور آمده است؛ ارسال از شبکهٔ دیگر ممکن است باعث از دست رفتن وجه شود.</li>
                  <li>مبلغ و آدرس را از فاکتور یا صفحهٔ پرداخت کپی کنید و پیش از تأیید دوباره بررسی کنید.</li>
                  <li>کارمزد انتقال شبکه معمولاً از کیف پول مبدأ شما کسر می‌شود و جدا از مبلغ فاکتور است؛ مبلغی کمتر از مبلغ فاکتور به دست درگاه نرسانید. پرداخت ناقص برای بررسی به پشتیبانی ارجاع داده می‌شود.</li>
                  <li>فهرست رمزارزها و شبکه‌ها به تنظیمات درگاه بستگی دارد و در خود ربات نمایش داده می‌شود؛ احتمالاً USDT (در چند شبکه)، TRX، TON، BTC، LTC و BNB را می‌بینید.</li>
                </ul>
              </Callout>
            </TabsContent>
          </Tabs>
          <div className="mt-8 flex flex-col items-center gap-3">
            {botUrl ? (
              <a href={botUrl} target="_blank" rel="noopener" className={buttonVariants({ size: "lg" })}><Send aria-hidden="true" />باز کردن ربات و شارژ کیف پول</a>
            ) : (
              <a href="#plans" className={buttonVariants({ size: "lg" })}>انتخاب پلن و ادامه در تلگرام</a>
            )}
            <p className="max-w-[560px] text-center text-[13px] text-faint">اگر هنوز پلنی انتخاب نکرده‌اید، می‌توانید اول پلن را از بخش پلن‌ها انتخاب کنید؛ ربات در صورت کمبود موجودی شما را به شارژ کیف پول هدایت می‌کند.</p>
          </div>
        </div>
      </Container>
    </section>
  );
}
