import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Send } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { StoreApiError, getStoreJson } from "@/lib/api";
import { fa } from "@/lib/format";
import { classifyPlanCheckFailure, durationTitle, handoffUrl, safeExternalUrl, type PlanCheck, type StoreCatalog, type StorePlan } from "@/lib/store";
import { cn } from "@/lib/utils";

const titleFor = (catalog: StoreCatalog, days: number) => durationTitle(catalog, days, (d) => `${fa(d)} روزه`);

type CheckState = { kind: "checking" } | { kind: "ready"; plan: StorePlan; url: string } | { kind: "unavailable" } | { kind: "gone" } | { kind: "error" };

function SummaryRow({ label, value, total }: { label: string; value: string; total?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-3 px-3.5 py-3", total ? "border-t" : "[&+&]:border-t")}>
      <dt className="m-0 text-muted-foreground">{label}</dt>
      <dd className={cn("m-0 text-end font-bold", total && "text-lg text-brand")}>{value}</dd>
    </div>
  );
}

/**
 * Order review. The catalog plan is shown immediately; the server's own answer
 * (GET /api/store/plans/:id) replaces it and is the only source of the hand-off
 * link. Checkout itself stays in the Telegram bot (wallet, payment, order).
 *
 * Loaded on demand (next/dynamic) so Radix Dialog is not part of first load.
 */
export function OrderDialog({ plan, catalog, onClose, onGone }: { plan: StorePlan | null; catalog: StoreCatalog; onClose: () => void; onGone: () => void }) {
  const [check, setCheck] = useState<CheckState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  useEffect(() => {
    if (!plan) return;
    const controller = new AbortController();
    setCheck({ kind: "checking" });
    getStoreJson<PlanCheck>(`/api/store/plans/${encodeURIComponent(plan.id)}`, controller.signal)
      .then((data) => {
        const url = safeExternalUrl(handoffUrl(data));
        setCheck(url ? { kind: "ready", plan: data.plan, url } : { kind: "unavailable" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (classifyPlanCheckFailure(error instanceof StoreApiError ? error.status : undefined) === "gone") {
          setCheck({ kind: "gone" });
          onGoneRef.current();
        } else {
          setCheck({ kind: "error" });
        }
      });
    return () => controller.abort();
  }, [plan, attempt]);

  const shown = check.kind === "ready" ? check.plan : plan;
  return (
    <Dialog open={plan !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <div className="p-5 pb-0">
          <DialogTitle>بررسی سفارش</DialogTitle>
        </div>
        {shown ? (
          <dl className="mx-5 mt-4 overflow-hidden rounded-[10px] border">
            <SummaryRow label="پلن" value={`${fa(shown.gig)} گیگابایت`} />
            <SummaryRow label="مدت" value={`${titleFor(catalog, shown.days)} (${fa(shown.days)} روز)`} />
            <SummaryRow label="حداکثر اتصال" value="نامحدود" />
            <SummaryRow total label="مبلغ قابل پرداخت" value={`${fa(shown.price)} تومان`} />
          </dl>
        ) : null}
        <DialogDescription className="px-5 pt-3.5">مبلغ نهایی هنگام تأیید سفارش در ربات دوباره روی سرور محاسبه و از کیف پول شما کسر می‌شود.</DialogDescription>
        <div className="grid gap-2.5 p-5">
          {/* Keyed by outcome so each result fades in, and the row keeps its height so the dialog does not jump. */}
          <div key={check.kind} className="animate-rise grid min-h-[52px] gap-2.5">
            {check.kind === "checking" ? (
              <Button size="lg" className="w-full" disabled aria-disabled="true"><LoaderCircle className="animate-spin" aria-hidden="true" />در حال بررسی موجودی پلن…</Button>
            ) : null}
            {check.kind === "ready" ? (
              <a className={buttonVariants({ size: "lg", className: "w-full" })} href={check.url} target="_blank" rel="noopener"><Send aria-hidden="true" />ادامه خرید در تلگرام</a>
            ) : null}
            {check.kind === "unavailable" ? <p role="alert" className="text-center text-sm text-destructive">ربات تلگرام در حال حاضر در دسترس نیست؛ لطفاً چند دقیقه بعد دوباره تلاش کنید.</p> : null}
            {check.kind === "gone" ? <p role="alert" className="text-center text-sm text-destructive">این پلن دیگر برای فروش فعال نیست. فهرست پلن‌ها به‌روزرسانی شد.</p> : null}
            {check.kind === "error" ? (
              <>
                <p role="alert" className="text-center text-sm text-destructive">بررسی پلن ممکن نشد. اتصال را بررسی کنید و دوباره تلاش کنید.</p>
                <Button size="lg" className="w-full" onClick={() => setAttempt((n) => n + 1)}><RefreshCw aria-hidden="true" />تلاش دوباره</Button>
              </>
            ) : null}
          </div>
          <Button variant="outline" className="w-full" onClick={onClose}>بازگشت به پلن‌ها</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
