import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { Check, CircleAlert, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Container } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import { durationTitle, plansFor, pricePerGb, type StoreCatalog, type StorePlan } from "@/lib/store";
import type { CatalogState } from "@/lib/use-catalog";
import { cn } from "@/lib/utils";

// Radix Dialog (+ focus trap, scroll lock) is only needed once a plan is chosen,
// so it is a separate chunk. It is requested on pointer/focus/touch intent over a
// plan button, so by the time of the click it is usually already on its way.
const loadOrderDialog = () => import("@/components/order-dialog").then((module) => module.OrderDialog);
const OrderDialog = dynamic(loadOrderDialog, { ssr: false });

const titleFor = (catalog: StoreCatalog, days: number) => durationTitle(catalog, days, (d) => `${fa(d)} روزه`);

function Notice({ tone = "info", children, action }: { tone?: "info" | "error"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mx-auto mb-[22px] flex max-w-[640px] flex-wrap items-center justify-center gap-3 rounded-lg border p-4 text-center text-muted-foreground",
        tone === "error" ? "border-destructive/40 bg-destructive/10 text-foreground" : "border-border-strong bg-card"
      )}
    >
      {tone === "error" ? <CircleAlert className="size-5 shrink-0 text-destructive" aria-hidden="true" /> : null}
      <span>{children}</span>
      {action}
    </div>
  );
}

function PlanCard({ plan, catalog, index, onSelect }: { plan: StorePlan; catalog: StoreCatalog; index: number; onSelect: (plan: StorePlan, opener: HTMLElement) => void }) {
  const perGb = pricePerGb(plan);
  const title = titleFor(catalog, plan.days);
  return (
    <Card
      className="animate-rise card-shadow-hover relative flex max-w-[274px] flex-1 basis-[230px] flex-col px-[22px] pb-[22px] pt-[26px] text-center transition-[transform,box-shadow] hover:-translate-y-1 focus-within:border-brand max-sm:max-w-none max-sm:basis-full"
      style={{ animationDelay: `${Math.min(index * 40, 240)}ms` }}
    >
      <div className="text-[40px] font-extrabold leading-[1.1] tracking-tight">{fa(plan.gig)}<small className="ms-1 text-base font-bold tracking-normal text-muted-foreground">گیگابایت</small></div>
      <div className="mt-1.5 text-sm font-semibold text-faint">{title} · {fa(plan.days)} روز</div>
      <div className="mb-1 mt-[18px] text-2xl font-extrabold">{fa(plan.price)}<small className="ms-1 text-sm font-semibold text-muted-foreground">تومان</small></div>
      <div className="min-h-5 text-[12.5px] text-faint">{perGb ? `هر گیگابایت حدود ${fa(perGb)} تومان` : ""}</div>
      <ul className="mb-[22px] mt-[18px] grid gap-2 border-t border-dashed border-border-strong pt-4 text-start text-sm text-muted-foreground">
        {["اتصال نامحدود کاربر", `${fa(plan.days)} روز اعتبار`, "تحویل خودکار در تلگرام"].map((line) => (
          <li key={line} className="flex items-center gap-2"><Check className="size-4 text-success" aria-hidden="true" />{line}</li>
        ))}
      </ul>
      <Button
        className="mt-auto w-full"
        aria-label={`انتخاب پلن ${fa(plan.gig)} گیگابایت ${title}`}
        onPointerEnter={() => void loadOrderDialog()}
        onFocus={() => void loadOrderDialog()}
        onTouchStart={() => void loadOrderDialog()}
        onClick={(event) => onSelect(plan, event.currentTarget)}>
        انتخاب این پلن
      </Button>
    </Card>
  );
}

export function PlansSection({ state, duration, onDuration, onReload, onRefresh }: { state: CatalogState; duration: number | null; onDuration: (days: number) => void; onReload: () => void; onRefresh: () => void }) {
  const [selected, setSelected] = useState<StorePlan | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const close = () => {
    setSelected(null);
    // Return focus to the card button that opened the dialog.
    requestAnimationFrame(() => openerRef.current?.focus());
  };

  const catalog = state.status === "ready" || state.status === "empty" ? state.catalog : null;
  const plans = state.status === "ready" ? plansFor(state.catalog, duration) : [];

  return (
    <section id="plans" aria-labelledby="plans-title" className="scroll-mt-[72px] py-[52px] sm:py-[72px]">
      <Container>
        <div className="mx-auto mb-8 max-w-[720px] text-center">
          <h2 id="plans-title" className="text-[clamp(24px,3.2vw,34px)] font-extrabold leading-snug">پلن‌ها و قیمت‌ها</h2>
          <p className="mt-2.5 text-muted-foreground">قیمت‌ها به تومان و مستقیماً از کاتالوگ فروش ربات خوانده می‌شوند؛ مبلغ نهایی هنگام ثبت سفارش دوباره روی سرور محاسبه می‌شود.</p>
        </div>

        <noscript><Notice>برای مشاهده و انتخاب پلن‌ها، جاوااسکریپت مرورگر باید فعال باشد.</Notice></noscript>

        {state.status === "error" ? (
          <Notice tone="error" action={<Button variant="outline" size="sm" onClick={onReload}><RefreshCw aria-hidden="true" />تلاش دوباره</Button>}>
            دریافت فهرست پلن‌ها ممکن نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.
          </Notice>
        ) : null}
        {state.status === "empty" ? <Notice>در حال حاضر پلنی برای فروش فعال نیست. لطفاً بعداً دوباره سر بزنید.</Notice> : null}

        {state.status === "loading" ? (
          <div aria-busy="true" className="flex flex-wrap justify-center gap-[18px]">
            {[0, 1, 2, 3].map((n) => (
              <Card key={n} aria-hidden="true" className="flex max-w-[274px] flex-1 basis-[230px] flex-col gap-3 p-[26px] max-sm:max-w-none max-sm:basis-full">
                <Skeleton className="mx-auto h-11 w-3/5" /><Skeleton className="mx-auto h-3.5 w-2/5" /><Skeleton className="mx-auto mt-3 h-7 w-[55%]" /><Skeleton className="my-3 h-[76px]" /><Skeleton className="h-11" />
              </Card>
            ))}
          </div>
        ) : null}

        {state.status === "ready" && catalog && duration !== null ? (
          <Tabs value={String(duration)} onValueChange={(value) => onDuration(Number(value))} dir="rtl">
            <TabsList aria-label="مدت اشتراک" className="mb-7 max-sm:grid max-sm:w-full max-sm:grid-cols-2">
              {catalog.durations.map((entry) => (
                <TabsTrigger key={entry.days} value={String(entry.days)}>
                  {entry.title}
                  <span className="mt-0.5 block text-[11.5px] font-semibold leading-none opacity-80">{fa(entry.days)} روز</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={String(duration)}>
              {plans.length === 0 ? (
                <Notice>برای این مدت پلن فعالی وجود ندارد.</Notice>
              ) : (
                <div className="flex flex-wrap justify-center gap-[18px]">
                  {plans.map((plan, index) => (
                    <PlanCard key={plan.id} plan={plan} catalog={catalog} index={index} onSelect={(picked, opener) => { openerRef.current = opener; setSelected(picked); }} />
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        ) : null}
      </Container>
      {/* Mounted only while a plan is selected, so its chunk is not fetched until then.
          A background refresh (onRefresh) never unmounts it. */}
      {catalog && selected ? <OrderDialog plan={selected} catalog={catalog} onClose={close} onGone={onRefresh} /> : null}
    </section>
  );
}
