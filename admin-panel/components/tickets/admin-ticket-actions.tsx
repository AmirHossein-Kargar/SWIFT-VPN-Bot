"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import { STATUS_LABELS, ticketErrorMessage, type TicketStatus } from "@/lib/tickets";

const MAX_LENGTH = 3500;

// Mirrors services/admin ADMIN_TRANSITIONS in services/support/tickets.js.
const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = {
  open: ["pending", "resolved", "closed"],
  pending: ["open", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};

export function AdminTicketActions({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const reply = useOperationId();
  const change = useOperationId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<TicketStatus | null>(null);
  const [changing, setChanging] = useState(false);
  const closed = status === "closed";

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await adminMutate<{ delivered: boolean | null; replayed?: boolean }>(`/tickets/${ticketId}/reply`, "POST", csrfToken, { operationId: reply.operationId, text: body });
      if (result.delivered === false) toast.warning("پاسخ ذخیره شد اما ارسال به تلگرام مشتری ناموفق بود. مشتری آن را در پنل وب می‌بیند.");
      else toast.success(result.replayed ? "این پاسخ قبلاً ارسال شده بود؛ دوباره ارسال نشد." : "پاسخ ارسال شد.");
      reply.rotate();
      setText("");
      router.refresh();
    } catch (sendError) {
      // The same operationId is kept, so a retry cannot deliver the reply twice.
      setError(ticketErrorMessage(sendError));
    } finally {
      setSending(false);
    }
  }

  async function applyStatus(next: TicketStatus) {
    setChanging(true);
    try {
      await adminMutate(`/tickets/${ticketId}/status`, "POST", csrfToken, { operationId: change.operationId, status: next });
      toast.success(`وضعیت تیکت: ${STATUS_LABELS[next]}`);
      change.rotate();
      router.refresh();
    } catch (changeError) {
      toast.error(ticketErrorMessage(changeError));
    } finally {
      setChanging(false);
      setPendingStatus(null);
    }
  }

  return (
    <div className="space-y-4" dir="rtl" lang="fa">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">تغییر وضعیت:</span>
        {NEXT_STATUSES[status].map((next) => (
          <Button
            key={next}
            size="sm"
            variant={next === "closed" ? "destructive" : "outline"}
            disabled={changing}
            onClick={() => (next === "closed" ? setPendingStatus(next) : void applyStatus(next))}
          >
            {STATUS_LABELS[next]}
          </Button>
        ))}
      </div>

      {closed ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          این تیکت بسته است. برای پاسخ، ابتدا آن را دوباره باز کنید.
        </p>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="ticket-reply" className="text-sm font-medium">پاسخ به مشتری</label>
          <Textarea id="ticket-reply" rows={5} maxLength={MAX_LENGTH} value={text} onChange={(event) => setText(event.target.value)} dir="auto" placeholder="پاسخ شما از طریق ربات تلگرام برای مشتری ارسال می‌شود." />
          <div className="flex items-center justify-between">
            <span className={`text-xs ${text.length > MAX_LENGTH - 200 ? "text-warning" : "text-muted-foreground"}`}>
              {text.length.toLocaleString("fa-IR")} / {MAX_LENGTH.toLocaleString("fa-IR")}
            </span>
            <Button type="submit" disabled={sending || !text.trim()}>{sending ? "در حال ارسال…" : "ارسال پاسخ"}</Button>
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </form>
      )}

      <AlertDialog open={pendingStatus !== null} onOpenChange={(open) => { if (!open && !changing) setPendingStatus(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>بستن تیکت {ticketId}؟</AlertDialogTitle>
            <AlertDialogDescription>پس از بستن، هیچ‌کدام از طرفین نمی‌توانند پیام جدیدی ارسال کنند تا تیکت دوباره باز شود. مشتری از بسته شدن مطلع می‌شود.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changing}>انصراف</AlertDialogCancel>
            <AlertDialogAction disabled={changing} onClick={(event) => { event.preventDefault(); if (pendingStatus) void applyStatus(pendingStatus); }}>
              {changing ? "در حال بستن…" : "بستن تیکت"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
