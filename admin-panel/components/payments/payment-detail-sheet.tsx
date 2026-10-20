"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, Circle, AlertCircle, Clock } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { useAdminSession } from "@/components/session-provider";
import { adminGet, adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { PaymentDetail } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";

const STEP_ICON: Record<string, typeof CheckCircle2> = {
  success: CheckCircle2,
  done: CheckCircle2,
  warning: AlertCircle,
  pending: Clock,
};

function ReasonAction({ label, variant = "default", minLength = 5, maxLength = 240, onSubmit }: {
  label: string;
  variant?: "default" | "destructive" | "outline";
  minLength?: number;
  maxLength?: number;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`Reason (${minLength}-${maxLength} characters)`} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => { setOpen(false); setReason(""); setError(null); }} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant={variant}
          size="sm"
          disabled={submitting}
          onClick={async () => {
            const trimmed = reason.trim();
            if (trimmed.length < minLength || trimmed.length > maxLength) {
              setError(`Reason must be between ${minLength} and ${maxLength} characters.`);
              return;
            }
            setSubmitting(true);
            try {
              await onSubmit(trimmed);
              setOpen(false);
              setReason("");
            } catch (error_) {
              setError(error_ instanceof AdminApiError ? error_.message : "The request failed.");
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Confirm
        </Button>
      </div>
    </div>
  );
}

export function PaymentDetailSheet({ paymentKey, open, onOpenChange }: { paymentKey: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  function load() {
    if (!paymentKey) return;
    setLoading(true);
    adminGet<PaymentDetail>(`/payments/${encodeURIComponent(paymentKey)}`)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (open && paymentKey) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, paymentKey]);

  async function refresh() {
    load();
    router.refresh();
  }

  async function handleRetry() {
    if (!detail) return;
    setRetrying(true);
    try {
      await adminMutate(`/payments/${encodeURIComponent(detail.key)}/retry`, "POST", csrfToken, { operationId: newOperationId() });
      toast.success("Retry submitted.");
      await refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Retry failed.");
    } finally {
      setRetrying(false);
    }
  }

  const bankPaymentId = detail?.provider === "bank" ? detail.id : null;
  const bankPending = Boolean(bankPaymentId) && detail?.rawStatus === "waiting_for_approval";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Payment detail</SheetTitle>
          <SheetDescription>{paymentKey}</SheetDescription>
        </SheetHeader>
        {loading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !detail ? (
          <p className="mt-6 text-sm text-muted-foreground">Could not load this payment.</p>
        ) : (
          <div className="mt-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xl font-semibold">{formatToman(detail.amount)}</p>
                <p className="text-sm text-muted-foreground">{detail.providerLabel} · user {detail.userId}</p>
              </div>
              <PaymentStatusBadge status={detail.status} />
            </div>

            <div className="flex flex-wrap gap-2">
              {(detail.actions.retryVerification || detail.actions.retryFulfillment) && (
                <Button size="sm" onClick={handleRetry} disabled={retrying}>
                  Retry
                </Button>
              )}
              {bankPending && (
                <>
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await adminMutate(`/payments/bank/${bankPaymentId}/confirm`, "POST", csrfToken, { operationId: newOperationId() });
                        toast.success("Bank payment confirmed.");
                        await refresh();
                      } catch (error) {
                        toast.error(error instanceof AdminApiError ? error.message : "Confirmation failed.");
                      }
                    }}
                  >
                    Confirm receipt
                  </Button>
                  <ReasonAction
                    label="Reject receipt"
                    variant="destructive"
                    onSubmit={async (reason) => {
                      await adminMutate(`/payments/bank/${bankPaymentId}/reject`, "POST", csrfToken, { operationId: newOperationId(), reason });
                      toast.success("Bank payment rejected.");
                      await refresh();
                    }}
                  />
                </>
              )}
              {detail.status !== "recovery-required" && (
                <ReasonAction
                  label="Flag for manual recovery"
                  variant="outline"
                  onSubmit={async (reason) => {
                    await adminMutate(`/payments/${encodeURIComponent(detail.key)}/recovery-required`, "POST", csrfToken, { operationId: newOperationId(), reason });
                    toast.success("Flagged for manual recovery.");
                    await refresh();
                  }}
                />
              )}
              {detail.actions.manualResolve && (
                <ReasonAction
                  label="Mark resolved"
                  variant="outline"
                  minLength={10}
                  maxLength={500}
                  onSubmit={async (reason) => {
                    await adminMutate(`/payments/${encodeURIComponent(detail.key)}/resolve`, "POST", csrfToken, { operationId: newOperationId(), reason });
                    toast.success("Marked as resolved.");
                    await refresh();
                  }}
                />
              )}
            </div>

            <Separator />

            <div>
              <h3 className="mb-3 text-sm font-medium">Timeline</h3>
              <ol className="space-y-3">
                {detail.timeline.map((event, index) => {
                  const Icon = STEP_ICON[event.status] ?? Circle;
                  return (
                    <li key={`${event.name}-${index}`} className="flex gap-3">
                      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${event.status === "warning" ? "text-warning" : event.status === "success" ? "text-success" : "text-muted-foreground"}`} />
                      <div>
                        <p className="text-sm font-medium">{event.name}</p>
                        {event.detail ? <p className="text-xs text-muted-foreground">{event.detail}</p> : null}
                        <p className="text-xs text-muted-foreground">{formatDateTime(event.at)}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
