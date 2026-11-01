import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { CalendarClock, Check, CircleAlert, Infinity as InfinityIcon, RefreshCw, Send, Tag } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Container, SectionHeading } from "@/components/site-chrome";
import { fa } from "@/lib/format";
import { durationTitle, isUnlimited, lowestPerGbPlanId, plansFor, pricePerGb, type StoreCatalog, type StorePlan } from "@/lib/store";
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

function PlanCard({ plan, catalog, index, selected, bestValue, onSelect }: { plan: StorePlan; catalog: StoreCatalog; index: number; selected: boolean; bestValue: boolean; onSelect: (plan: StorePlan, opener: HTMLElement) => void }) {
  const perGb = pricePerGb(plan);
  const unlimited = isUnlimited(plan);
  const title = titleFor(catalog, plan.days);
  return (
    <Card
      data-selected={selected ? "true" : undefined}
      className={cn(
        "animate-rise lift relative flex max-w-[274px] flex-1 basis-[230px] flex-col overflow-hidden px-[22px] pb-[22px] pt-5 text-center focus-within:border-brand max-sm:max-w-none max-sm:basis-full",
        selected && "border-brand ring-2 ring-brand/40",
        bestValue && "plan-best"
      )}
      style={{ animationDelay: `${Math.min(index * 40, 240)}ms` }}
    >
      <div className="mb-4 flex min-h-7 flex-wrap items-center justify-between gap-2 text-[12.5px] font-bold">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground"><CalendarClock className="size-[14px]" aria-hidden="true" />{title}</span>
        {bestValue ? <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-brand/10 px-2.5 py-1 text-brand"><Tag className="size-[13px]" aria-hidden="true" />کمترین قیمت هر گیگ</span> : null}
      </div>
      <div className="text-[42px] font-extrabold leading-[1.1] tracking-tight">{unlimited ? "نامحدود" : <>{fa(plan.gig)}<small className="ms-1 text-base font-bold tracking-normal text-muted-foreground">گیگابایت</small></>}</div>
      <div className="mt-1.5 text-sm font-semibold text-faint">اعتبار {fa(plan.days)} روز</div>
      <div className="mb-1 mt-[18px] text-2xl font-extrabold">{fa(plan.price)}<small className="ms-1 text-sm font-semibold text-muted-foreground">تومان</small></div>
      <div className="min-h-5 text-[12.5px] text-faint">{unlimited ? "بدون سقف حجم، در مدت اعتبار" : perGb ? `هر گیگابایت حدود ${fa(perGb)} تومان` : ""}</div>
      <ul className="mb-[22px] mt-[18px] grid gap-2 border-t border-dashed border-border-strong pt-4 text-start text-sm text-muted-foreground">
        <li className="flex items-center gap-2"><InfinityIcon className="size-4 shrink-0 text-success" aria-hidden="true" />اتصال نامحدود کاربر</li>
        <li className="flex items-center gap-2"><Check className="size-4 shrink-0 text-success" aria-hidden="true" />{fa(plan.days)} روز اعتبار</li>
        <li className="flex items-center gap-2"><Send className="size-4 shrink-0 text-success" aria-hidden="true" />تحویل خودکار در تلگرام</li>
      </ul>
      <Button
        className="mt-auto w-full"
        aria-label={`انتخاب پلن ${unlimited ? "نامحدود" : `${fa(plan.gig)} گیگابایت`} ${title}`}
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
  const bestValueId = lowestPerGbPlanId(plans);

  return (
    <section id="plans" aria-labelledby="plans-title" className="aurora relative isolate scroll-mt-[72px] overflow-clip py-[52px] sm:py-[72px]">
      <Container>
        <SectionHeading id="plans-title" eyebrow="مرحلهٔ اول" title="پلن‌ها و قیمت‌ها">
          قیمت‌ها به تومان و مستقیماً از کاتالوگ فروش ربات خوانده می‌شوند؛ مبلغ نهایی هنگام ثبت سفارش دوباره روی سرور محاسبه می‌شود.
        </SectionHeading>

        <noscript><Notice>برای مشاهده و انتخاب پلن‌ها، جاوااسکریپت مرورگر باید فعال باشد.</Notice></noscript>

        {state.status === "error" ? (
          <Notice tone="error" action={<Button variant="outline" size="sm" onClick={onReload}><RefreshCw aria-hidden="true" />تلاش دوباره</Button>}>
            دریافت فهرست پلن‌ها ممکن نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید؛ هیچ قیمتی بدون دریافت از سرور نمایش داده نمی‌شود.
          </Notice>
        ) : null}
        {state.status === "empty" ? <Notice>در حال حاضر پلنی برای فروش فعال نیست. لطفاً بعداً دوباره سر بزنید.</Notice> : null}

        {state.status === "loading" ? (
          <div aria-busy="true" aria-label="در حال دریافت پلن‌ها" role="status">
            <div aria-hidden="true" className="mx-auto mb-7 h-[62px] w-full max-w-[520px] rounded-2xl border bg-card p-1.5"><Skeleton className="size-full" /></div>
            <div aria-hidden="true" className="flex flex-wrap justify-center gap-[18px]">
              {[0, 1, 2, 3].map((n) => (
                <Card key={n} className="flex max-w-[274px] flex-1 basis-[230px] flex-col gap-3 p-[26px] max-sm:max-w-none max-sm:basis-full">
                  <Skeleton className="h-7 w-2/5" /><Skeleton className="mx-auto h-11 w-3/5" /><Skeleton className="mx-auto h-3.5 w-2/5" /><Skeleton className="mx-auto mt-3 h-7 w-[55%]" /><Skeleton className="my-3 h-[76px]" /><Skeleton className="h-11" />
                </Card>
              ))}
            </div>
          </div>
        ) : null}

        {state.status === "ready" && catalog && duration !== null ? (
          <Tabs value={String(duration)} onValueChange={(value) => onDuration(Number(value))} dir="rtl">
            <TabsList aria-label="مدت اشتراک" className="mb-3 grid w-full max-w-[440px] grid-cols-4">
              {catalog.durations.map((entry) => (
                <TabsTrigger key={entry.days} value={String(entry.days)} className="min-w-0 flex-col gap-1 whitespace-nowrap px-1 py-1.5 text-[13px] leading-5 sm:text-sm">
                  {entry.title}
                  <span className="text-[11.5px] font-semibold leading-none opacity-80">{fa(entry.days)} روز</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <p className="mx-auto mb-7 max-w-[640px] text-center text-[13.5px] text-faint">
              همهٔ پلن‌ها اتصال نامحدود کاربر دارند و فقط در حجم و مدت اعتبار با هم فرق می‌کنند. برای مقایسه، قیمت تقریبی هر گیگابایت زیر هر پلن نوشته شده است.
            </p>
            <TabsContent value={String(duration)}>
              {plans.length === 0 ? (
                <Notice>برای این مدت پلن فعالی وجود ندارد.</Notice>
              ) : (
                <div className="flex flex-wrap justify-center gap-[18px]">
                  {plans.map((plan, index) => (
                    <PlanCard
                      key={plan.id}
                      plan={plan}
                      catalog={catalog}
                      index={index}
                      selected={selected?.id === plan.id}
                      bestValue={plan.id === bestValueId}
                      onSelect={(picked, opener) => { openerRef.current = opener; setSelected(picked); }}
                    />
                  ))}
                </div>
              )}
            </TabsContent>
            <p className="mx-auto mt-7 max-w-[640px] text-center text-[13.5px] text-faint">
              با «انتخاب این پلن» خلاصهٔ سفارش را می‌بینید و به ربات تلگرام می‌روید؛ پرداخت و تأیید نهایی در ربات انجام می‌شود، نه در این صفحه.
            </p>
          </Tabs>
        ) : null}
      </Container>
      {/* Mounted only while a plan is selected, so its chunk is not fetched until then.
          A background refresh (onRefresh) never unmounts it. */}
      {catalog && selected ? <OrderDialog plan={selected} catalog={catalog} onClose={close} onGone={onRefresh} /> : null}
    </section>
  );
}
