"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminSession } from "@/components/session-provider";
import { ConnectionStatus, useVisiblePolling } from "@/components/tickets/live-refresh";
import { MessageList, TicketStatusBadge } from "@/components/tickets/ticket-thread";
import { TicketComposer, TicketStatusControl } from "@/components/tickets/admin-ticket-actions";
import { adminGet } from "@/lib/adminApi.client";
import { BASE_PATH } from "@/lib/basePath";
import { AdminApiError } from "@/lib/types";
import {
  formatTicketDateTime,
  ticketErrorMessage,
  type TicketDetail,
  type TicketHistoryPage,
  type TicketMessage,
  type TicketStatus,
  type TicketSummary,
  type TicketUpdates,
} from "@/lib/tickets";

const POLL_MS = 3_000;
const PAGE = 40;
/** Distance from the bottom (px) within which the view counts as "following" the conversation. */
const FOLLOW_THRESHOLD = 80;

/** Merge by id: overlapping polls, a sent reply echoed by the next poll, or a double-loaded page never render twice. */
export function mergeById(current: TicketMessage[], incoming: TicketMessage[], position: "append" | "prepend" = "append"): TicketMessage[] {
  if (!incoming.length) return current;
  const known = new Set(current.map((message) => message.id));
  const fresh = incoming.filter((message, index) => !known.has(message.id) && incoming.findIndex((other) => other.id === message.id) === index);
  if (!fresh.length) return current;
  return position === "append" ? [...current, ...fresh] : [...fresh, ...current];
}

type Phase = "loading" | "ready" | "missing" | "failed";

/**
 * One ticket as a chat: history on top (newest page first, older pages on
 * demand), live updates appended by polling, and the composer at the bottom.
 * The server's stored messages are the only source of truth; connection loss
 * just delays updates, and every reconnect resumes from the last cursor.
 */
export function LiveTicketThread({
  ticketId,
  onBack,
  onTicketChange,
}: {
  ticketId: string;
  onBack: () => void;
  onTicketChange: (ticket: TicketSummary) => void;
}) {
  const { actorTelegramId } = useAdminSession();
  const [phase, setPhase] = useState<Phase>("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketSummary | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);

  const scroller = useRef<HTMLDivElement>(null);
  const newest = useRef<string | null>(null);
  const oldest = useRef<string | null>(null);
  const following = useRef(true);
  const restore = useRef<{ height: number } | null>(null);
  const ready = useRef(false);
  const onTicketChangeRef = useRef(onTicketChange);
  useEffect(() => { onTicketChangeRef.current = onTicketChange; });

  const scrollToBottom = useCallback(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    following.current = true;
    setUnseen(0);
  }, []);

  const signOut = useCallback(() => {
    window.location.assign(`${BASE_PATH}/sign-in`);
  }, []);

  const applyTicket = useCallback((next: TicketSummary) => {
    setTicket(next);
    onTicketChangeRef.current(next);
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    setFailure(null);
    ready.current = false;
    try {
      const detail = await adminGet<TicketDetail>(`/tickets/${encodeURIComponent(ticketId)}`, { limit: PAGE });
      newest.current = detail.cursor ?? null;
      oldest.current = detail.oldestCursor ?? null;
      following.current = true;
      setMessages(detail.messages);
      setHasOlder(Boolean(detail.hasOlder));
      applyTicket(detail.ticket);
      setPhase("ready");
      ready.current = true;
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) return signOut();
      if (error instanceof AdminApiError && error.status === 404) return setPhase("missing");
      setFailure(ticketErrorMessage(error, "The ticket could not be loaded."));
      setPhase("failed");
    }
  }, [ticketId, applyTicket, signOut]);

  useEffect(() => { void load(); }, [load]);

  const { connection, trigger } = useVisiblePolling(
    async () => {
      if (!ready.current) return { again: false };
      try {
        const data = await adminGet<TicketUpdates>(`/tickets/${encodeURIComponent(ticketId)}/updates`, {
          after: newest.current ?? undefined,
          markRead: "1",
        });
        if (data.cursor) newest.current = data.cursor;
        if (data.messages.length) {
          if (!following.current) setUnseen((count) => count + data.messages.filter((message) => message.author === "customer").length);
          setMessages((current) => mergeById(current, data.messages));
        }
        applyTicket(data.ticket);
        return { again: data.hasMore };
      } catch (error) {
        if (error instanceof AdminApiError && error.status === 401) { signOut(); return { stop: true }; }
        if (error instanceof AdminApiError && error.status === 404) { setPhase("missing"); return { stop: true }; }
        throw error;
      }
    },
    { intervalMs: POLL_MS, resetKey: ticketId }
  );

  // Keep the view where the admin is: follow new messages only when already at the bottom; after loading earlier ones, hold position.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (restore.current) {
      element.scrollTop += element.scrollHeight - restore.current.height;
      restore.current = null;
      return;
    }
    if (following.current) element.scrollTop = element.scrollHeight;
  }, [messages, phase]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD;
    following.current = atBottom;
    if (atBottom) setUnseen(0);
  }

  async function loadOlder() {
    if (loadingOlder || !oldest.current) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await adminGet<TicketHistoryPage>(`/tickets/${encodeURIComponent(ticketId)}/messages`, { before: oldest.current, limit: PAGE });
      if (scroller.current) restore.current = { height: scroller.current.scrollHeight };
      if (page.oldestCursor) oldest.current = page.oldestCursor;
      setHasOlder(page.hasOlder);
      setMessages((current) => mergeById(current, page.messages, "prepend"));
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) return signOut();
      setOlderError(ticketErrorMessage(error, "Earlier messages could not be loaded."));
    } finally {
      setLoadingOlder(false);
    }
  }

  const closed = ticket?.status === "closed";

  if (phase === "loading" || (phase === "ready" && !ticket)) {
    return (
      <div className="flex h-full flex-col gap-3 p-4" aria-busy="true" aria-label="Loading conversation">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-16 w-2/3" />
        <Skeleton className="h-12 w-1/2" />
      </div>
    );
  }
  if (phase === "missing" || phase === "failed" || !ticket) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">{phase === "missing" ? "This ticket does not exist." : failure}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>Back to inbox</Button>
          {phase === "failed" ? <Button size="sm" onClick={() => void load()}>Try again</Button> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-ticket-id={ticket.ticketId}>
      <header className="space-y-2 border-b border-border p-3 sm:p-4">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" className="-ml-2 shrink-0 md:hidden" onClick={onBack} aria-label="Back to inbox">
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold" dir="auto">{ticket.subject}</h2>
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span className="font-mono">{ticket.ticketId}</span>
              <span>Customer <span className="font-mono">{ticket.userTelegramId}</span></span>
              <span>{ticket.channel === "web" ? "Web" : "Telegram"}</span>
              <span>Opened {formatTicketDateTime(ticket.createdAt)}</span>
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <TicketStatusControl ticketId={ticket.ticketId} status={ticket.status} onChanged={(status: TicketStatus) => { setTicket((current) => (current ? { ...current, status } : current)); trigger(); }} />
            <ConnectionStatus connection={connection} />
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-4 sm:px-4" role="log" aria-label="Conversation" aria-live="polite" tabIndex={0}>
          {hasOlder ? (
            <div className="mb-4 flex flex-col items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? "Loading…" : "Load earlier messages"}
              </Button>
              {olderError ? <p className="text-xs text-destructive" role="alert">{olderError}</p> : null}
            </div>
          ) : null}
          <MessageList messages={messages} actorId={actorTelegramId} />
        </div>
        {unseen > 0 ? (
          <Button size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-lg" onClick={scrollToBottom}>
            <ArrowDown /> {unseen} new {unseen === 1 ? "message" : "messages"}
          </Button>
        ) : null}
      </div>

      <footer className="space-y-2 border-t border-border p-3 sm:p-4">
        {closed ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              This ticket was closed{ticket.closedAt ? ` on ${formatTicketDateTime(ticket.closedAt)}` : ""}
              {ticket.closedBy === "customer" ? " by the customer" : ticket.closedBy === "admin" ? " by support" : ""}. It is read-only and cannot be reopened; the customer can open a new ticket if they still need help.
            </span>
          </p>
        ) : null}
        <TicketComposer
          ticketId={ticket.ticketId}
          disabled={closed}
          onSent={() => { following.current = true; trigger(); }}
          onRejected={() => trigger()}
        />
      </footer>
    </div>
  );
}
