"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import {
  MAX_MESSAGE_LENGTH,
  NEXT_STATUSES,
  STATUS_LABELS,
  TICKET_STATUSES,
  isDefinitiveFailure,
  ticketErrorMessage,
  type TicketStatus,
} from "@/lib/tickets";

const DRAFT_PREFIX = "swift:ticket-draft:";

function readDraft(ticketId: string): string {
  try { return window.sessionStorage.getItem(DRAFT_PREFIX + ticketId) ?? ""; } catch { return ""; }
}
function writeDraft(ticketId: string, value: string) {
  try {
    if (value) window.sessionStorage.setItem(DRAFT_PREFIX + ticketId, value);
    else window.sessionStorage.removeItem(DRAFT_PREFIX + ticketId);
  } catch { /* storage unavailable: the draft is simply not remembered */ }
}

/**
 * Status dropdown. The saved status is the only truth: the control shows what
 * the server last confirmed, success is announced only after the server
 * accepted the change, and a failure leaves the value untouched. Closing is
 * final, so it asks for confirmation first.
 */
export function TicketStatusControl({
  ticketId,
  status,
  onChanged,
}: {
  ticketId: string;
  status: TicketStatus;
  onChanged: (status: TicketStatus) => void;
}) {
  const { csrfToken } = useAdminSession();
  const change = useOperationId();
  const [changing, setChanging] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const reachable = new Set<TicketStatus>([status, ...NEXT_STATUSES[status]]);

  async function apply(next: TicketStatus) {
    setChanging(true);
    try {
      const result = await adminMutate<{ status: TicketStatus; changed: boolean | null }>(`/tickets/${ticketId}/status`, "POST", csrfToken, { operationId: change.operationId, status: next });
      change.rotate();
      onChanged(result.status);
      if (result.changed === false) toast.info(`The ticket was already ${STATUS_LABELS[result.status].toLowerCase()}.`);
      else toast.success(result.status === "closed" ? "Ticket closed." : `Ticket status set to “${STATUS_LABELS[result.status]}”.`);
    } catch (error) {
      // A definitive rejection will never succeed with the same key; an unknown outcome (network) keeps it so a retry cannot double-apply.
      if (isDefinitiveFailure(error)) change.rotate();
      toast.error(ticketErrorMessage(error, "The status could not be changed."));
    } finally {
      setChanging(false);
      setConfirmClose(false);
    }
  }

  return (
    <>
      <Select
        value={status}
        disabled={changing || status === "closed"}
        onValueChange={(value) => {
          const next = value as TicketStatus;
          if (next === status) return;
          if (next === "closed") setConfirmClose(true);
          else void apply(next);
        }}
      >
        <SelectTrigger className="h-8 w-[10.5rem] text-xs" aria-label="Ticket status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TICKET_STATUSES.map((value) => (
            <SelectItem key={value} value={value} disabled={!reachable.has(value)}>{STATUS_LABELS[value]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <AlertDialog open={confirmClose} onOpenChange={(open) => { if (!open && !changing) setConfirmClose(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close ticket {ticketId}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nobody can send messages to a closed ticket and it cannot be reopened. The full history stays available here, and the customer is notified and can open a new ticket if they still need help.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changing}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={changing} onClick={(event) => { event.preventDefault(); void apply("closed"); }}>
              {changing ? "Closing…" : "Close ticket"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Message composer. Enter sends, Shift+Enter inserts a newline (and Enter is
 * left alone while an IME composition is active). The text stays in the box
 * until the server accepts it, so a failed send never loses a reply, and the
 * same operationId is reused for retries after an unknown outcome so a reply
 * can never be delivered twice. An unsent draft survives a page refresh.
 */
export function TicketComposer({
  ticketId,
  disabled,
  onSent,
  onRejected,
}: {
  ticketId: string;
  disabled: boolean;
  onSent: (result: { status: TicketStatus | null }) => void;
  onRejected: () => void;
}) {
  const { csrfToken } = useAdminSession();
  const reply = useOperationId();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setText(readDraft(ticketId));
    setError(null);
  }, [ticketId]);

  // Grow with the content up to a cap, then scroll.
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);

  function update(value: string) {
    setText(value);
    writeDraft(ticketId, value);
  }

  async function send() {
    const body = text.trim();
    if (!body || sending || disabled) return;
    setSending(true);
    setError(null);
    try {
      const result = await adminMutate<{ status: TicketStatus | null; delivered: boolean | null; replayed?: boolean }>(
        `/tickets/${ticketId}/reply`,
        "POST",
        csrfToken,
        { operationId: reply.operationId, text: body }
      );
      reply.rotate();
      update("");
      if (result.delivered === false) {
        toast.warning("Reply saved, but the Telegram notification could not be sent. The customer will see it when they open the ticket.");
      }
      onSent({ status: result.status });
    } catch (sendError) {
      if (isDefinitiveFailure(sendError)) {
        reply.rotate();
        onRejected();
      }
      setError(ticketErrorMessage(sendError, "The reply could not be sent."));
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="flex items-end gap-2">
        <label htmlFor="ticket-reply" className="sr-only">Reply to customer</label>
        <Textarea
          ref={area}
          id="ticket-reply"
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          value={text}
          disabled={disabled}
          onChange={(event) => update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          dir="auto"
          placeholder={disabled ? "This ticket is closed." : "Write a reply… (Enter to send, Shift+Enter for a new line)"}
          className="max-h-40 min-h-[2.5rem] resize-none"
        />
        <Button type="submit" disabled={disabled || sending || !text.trim()}>{sending ? "Sending…" : "Send"}</Button>
      </div>
      <div className="flex items-center justify-between gap-2 px-0.5 text-xs">
        <span className="text-destructive" role="alert">{error}</span>
        {text.length > MAX_MESSAGE_LENGTH - 500 ? (
          <span className={text.length > MAX_MESSAGE_LENGTH - 100 ? "text-warning" : "text-muted-foreground"}>
            {text.length.toLocaleString("en-US")} / {MAX_MESSAGE_LENGTH.toLocaleString("en-US")}
          </span>
        ) : null}
      </div>
    </form>
  );
}
