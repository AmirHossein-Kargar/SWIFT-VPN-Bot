"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CustomerThread } from "@/components/support/customer-thread";
import type { TicketMessage, TicketStatus } from "@/lib/tickets";
import { cn } from "@/lib/utils";

/** Dispatched by the reply form so the thread refreshes immediately instead of waiting for the next tick. */
export const CUSTOMER_TICKET_SYNC_EVENT = "swift:ticket-sync";

const POLL_MS = 4_000;
const MAX_BACKOFF_MS = 30_000;

interface UpdatesResponse {
  ticket: { status: TicketStatus; messageCount: number; lastMessageAt: string };
  messages: TicketMessage[];
  cursor: string | null;
  hasMore: boolean;
}

type Connection = "live" | "reconnecting" | "paused";

/** Merge by id (de-duplicates repeated or overlapping polls) and keep server insertion order. */
export function mergeMessages(current: TicketMessage[], incoming: TicketMessage[]): TicketMessage[] {
  if (!incoming.length) return current;
  const known = new Set(current.map((message) => message.id));
  const fresh = incoming.filter((message) => !known.has(message.id));
  return fresh.length ? [...current, ...fresh] : current;
}

/**
 * Customer conversation that keeps itself current by authenticated polling
 * (about every 4s while the tab is visible; hidden tabs pause and catch up on
 * return). Every poll re-checks the customer session and ticket ownership on
 * the server, so a revoked session stops receiving updates.
 */
export function CustomerLiveThread({
  ticketId,
  endpoint,
  attachmentBase,
  initialMessages,
  initialCursor,
  initialStatus,
  initialMessageCount,
}: {
  ticketId: string;
  endpoint: string;
  attachmentBase: string;
  initialMessages: TicketMessage[];
  initialCursor: string | null;
  initialStatus: TicketStatus;
  initialMessageCount: number;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [connection, setConnection] = useState<Connection>("live");
  const cursor = useRef<string | null>(initialCursor);
  const known = useRef({ status: initialStatus, count: initialMessageCount });
  const failures = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  // The server component re-renders after our own sends and status changes: fold its snapshot in (by id), never replace.
  useEffect(() => {
    setMessages((current) => mergeMessages(current, initialMessages));
    if (initialCursor && (!cursor.current || initialCursor > cursor.current)) cursor.current = initialCursor;
    known.current = { status: initialStatus, count: Math.max(known.current.count, initialMessageCount) };
  }, [initialMessages, initialCursor, initialStatus, initialMessageCount]);

  const schedule = useCallback((delay: number) => {
    if (stopped.current) return;
    if (timer.current) clearTimeout(timer.current);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    timer.current = setTimeout(() => void poll(), delay);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const poll = useCallback(async () => {
    if (stopped.current || inFlight.current) return;
    if (document.visibilityState === "hidden") { setConnection("paused"); return; } // resumed by visibilitychange
    inFlight.current = true;
    try {
      const params = new URLSearchParams({ markRead: "1" });
      if (cursor.current) params.set("after", cursor.current);
      const response = await fetch(`${endpoint}?${params}`, { headers: { accept: "application/json" }, cache: "no-store" });
      if (response.status === 401) { router.refresh(); return; } // session expired: let the server render the sign-in state
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error("poll failed");
      const data = body.data as UpdatesResponse;

      failures.current = 0;
      setConnection("live");
      if (data.messages.length) setMessages((current) => mergeMessages(current, data.messages));
      if (data.cursor) cursor.current = data.cursor;

      const changed = data.ticket.status !== known.current.status || data.ticket.messageCount !== known.current.count;
      known.current = { status: data.ticket.status, count: data.ticket.messageCount };
      // Status badge and the closed notice are server-rendered: refresh them only when something actually changed.
      if (changed) router.refresh();
      schedule(data.hasMore ? 200 : POLL_MS);
    } catch {
      failures.current += 1;
      setConnection("reconnecting");
      schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(failures.current, 4)));
    } finally {
      inFlight.current = false;
    }
  }, [endpoint, router, schedule]);

  useEffect(() => {
    stopped.current = false;
    void poll();
    const wake = () => { if (document.visibilityState === "visible") { failures.current = 0; void poll(); } };
    const sync = () => { failures.current = 0; void poll(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener(CUSTOMER_TICKET_SYNC_EVENT, sync);
    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener(CUSTOMER_TICKET_SYNC_EVENT, sync);
    };
  }, [poll]);

  return (
    <div className="space-y-2" data-ticket-id={ticketId}>
      <p
        className={cn("flex items-center gap-1.5 text-xs", connection === "reconnecting" ? "text-warning" : "text-muted-foreground")}
        role="status"
        aria-live="polite"
      >
        <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", connection === "live" ? "bg-success" : connection === "reconnecting" ? "bg-warning" : "bg-muted-foreground")} />
        {connection === "live" ? "به‌روزرسانی خودکار فعال است" : connection === "reconnecting" ? "ارتباط قطع شد؛ در حال تلاش مجدد…" : "به‌روزرسانی متوقف شد (تب پنهان است)"}
      </p>
      <CustomerThread messages={messages} attachmentBase={attachmentBase} />
    </div>
  );
}
