"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
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
import { useCustomerSession } from "@/components/support/customer-session";
import { customerMutate, newOperationId } from "@/lib/customerApi.client";
import { ticketErrorMessage, type TicketStatus } from "@/lib/tickets";

const MAX_LENGTH = 3500;

export function CustomerTicketActions({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const { csrfToken } = useCustomerSession();
  const router = useRouter();
  const operationId = useRef(newOperationId());
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [changing, setChanging] = useState(false);
  const closed = status === "closed";

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await customerMutate(`/tickets/${ticketId}/messages`, csrfToken, { operationId: operationId.current, text: body });
      operationId.current = newOperationId();
      setText("");
      toast.success("پیام شما ارسال شد.");
      window.dispatchEvent(new Event("swift:ticket-sync"));
      router.refresh();
    } catch (sendError) {
      setError(ticketErrorMessage(sendError));
    } finally {
      setSending(false);
    }
  }

  async function setStatus(next: "closed" | "open") {
    setChanging(true);
    try {
      await customerMutate(`/tickets/${ticketId}/status`, csrfToken, { status: next });
      toast.success(next === "closed" ? "تیکت بسته شد." : "تیکت دوباره باز شد.");
      router.refresh();
    } catch (changeError) {
      toast.error(ticketErrorMessage(changeError));
    } finally {
      setChanging(false);
      setConfirmClose(false);
    }
  }

  return (
    <div className="space-y-4">
      {closed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-sm text-muted-foreground">این تیکت بسته شده است.</p>
          <Button size="sm" variant="outline" disabled={changing} onClick={() => void setStatus("open")}>{changing ? "…" : "بازگشایی تیکت"}</Button>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="reply" className="text-sm font-medium">پیام جدید</label>
          <Textarea id="reply" rows={4} maxLength={MAX_LENGTH} value={text} onChange={(event) => setText(event.target.value)} dir="auto" placeholder="پاسخ یا توضیح بیشتر خود را بنویسید." />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmClose(true)} disabled={changing}>بستن تیکت</Button>
            <Button type="submit" disabled={sending || !text.trim()}>{sending ? "در حال ارسال…" : "ارسال"}</Button>
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </form>
      )}

      <AlertDialog open={confirmClose} onOpenChange={(open) => { if (!changing) setConfirmClose(open); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>بستن تیکت {ticketId}؟</AlertDialogTitle>
            <AlertDialogDescription>بعد از بستن نمی‌توانید پیام جدیدی بفرستید، اما تا ۷ روز می‌توانید آن را دوباره باز کنید.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changing}>انصراف</AlertDialogCancel>
            <AlertDialogAction disabled={changing} onClick={(event) => { event.preventDefault(); void setStatus("closed"); }}>
              {changing ? "در حال بستن…" : "بستن تیکت"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
