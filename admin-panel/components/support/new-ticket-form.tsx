"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCustomerSession } from "@/components/support/customer-session";
import { customerMutate, newOperationId } from "@/lib/customerApi.client";
import { ticketErrorMessage } from "@/lib/tickets";

const MAX_TEXT = 3500;
const MAX_SUBJECT = 100;

export function NewTicketForm() {
  const { csrfToken } = useCustomerSession();
  const router = useRouter();
  // One id per form session: resubmitting after a timeout cannot create a second ticket.
  const operationId = useRef(newOperationId());
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await customerMutate<{ data: { ticket: { ticketId: string } } }>("/tickets", csrfToken, {
        operationId: operationId.current,
        subject: subject.trim(),
        text: text.trim(),
      });
      router.replace(`/support/${result.data.ticket.ticketId}`);
      router.refresh();
    } catch (submitError) {
      setError(ticketErrorMessage(submitError));
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="subject" className="text-sm font-medium">موضوع</label>
        <Input id="subject" value={subject} maxLength={MAX_SUBJECT} onChange={(event) => setSubject(event.target.value)} placeholder="مثلاً: اتصال سرویس برقرار نمی‌شود" dir="auto" required />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="message" className="text-sm font-medium">پیام</label>
        <Textarea id="message" rows={8} value={text} maxLength={MAX_TEXT} onChange={(event) => setText(event.target.value)} placeholder="مشکل خود را با جزئیات بنویسید." dir="auto" required />
        <p className="text-xs text-muted-foreground">{text.length.toLocaleString("fa-IR")} / {MAX_TEXT.toLocaleString("fa-IR")} — برای ارسال عکس یا فیلم، از ربات تلگرام استفاده کنید.</p>
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <Button type="submit" disabled={busy || !subject.trim() || !text.trim()}>{busy ? "در حال ثبت…" : "ثبت تیکت"}</Button>
    </form>
  );
}
