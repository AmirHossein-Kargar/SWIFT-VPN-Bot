"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ConnectionStatus, useVisiblePolling } from "@/components/tickets/live-refresh";
import { LiveTicketThread } from "@/components/tickets/live-ticket-thread";
import { TicketInbox } from "@/components/tickets/ticket-inbox";
import { TicketsFilters, type InboxFilters } from "@/components/tickets/tickets-filters";
import { adminGet } from "@/lib/adminApi.client";
import { BASE_PATH } from "@/lib/basePath";
import { AdminApiError } from "@/lib/types";
import { TICKET_STATUSES, ticketErrorMessage, type AdminTicketPage, type TicketStatus, type TicketSummary } from "@/lib/tickets";
import { cn } from "@/lib/utils";

const LIST_POLL_MS = 5_000;
const PAGE_SIZE = 30;
const TICKET_ID = /^T-[A-HJ-NP-Z2-9]{6}$/;

export interface WorkspaceInitial {
  q: string;
  status: string;
  unread: boolean;
  page: number;
  selectedId: string | null;
  list: AdminTicketPage | null;
}

function cleanStatus(value: string | null): TicketStatus | "" {
  return TICKET_STATUSES.includes(value as TicketStatus) ? (value as TicketStatus) : "";
}

/** The URL is the source of truth for what is on screen, so a refresh or a shared link restores it. */
function urlFor(filters: InboxFilters, page: number, selectedId: string | null): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.unread) params.set("unread", "1");
  if (page > 1) params.set("page", String(page));
  if (selectedId) params.set("t", selectedId);
  const query = params.toString();
  return query ? `?${query}` : window.location.pathname;
}

function readLocation(): { filters: InboxFilters; page: number; selectedId: string | null } {
  const params = new URLSearchParams(window.location.search);
  const t = params.get("t");
  return {
    filters: { q: params.get("q") ?? "", status: cleanStatus(params.get("status")), unread: params.get("unread") === "1" },
    page: Math.max(1, Number(params.get("page")) || 1),
    selectedId: t && TICKET_ID.test(t) ? t : null,
  };
}

/**
 * Inbox + conversation, like a messaging app: the selected conversation on the left,
 * the list of tickets on the right (one at a time on a phone). All data
 * is fetched client-side from the admin API with the signed-in session, and
 * both the list and the open conversation keep themselves current by polling.
 */
export function TicketWorkspace({ initial }: { initial: WorkspaceInitial }) {
  const [filters, setFilters] = useState<InboxFilters>({ q: initial.q, status: cleanStatus(initial.status), unread: initial.unread });
  const [search, setSearch] = useState(initial.q);
  const [page, setPage] = useState(initial.page);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [list, setList] = useState<AdminTicketPage | null>(initial.list);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial.list === null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ filters, page });
  useEffect(() => { latest.current = { filters, page }; });

  const fetchList = useCallback(async () => {
    const { filters: current, page: currentPage } = latest.current;
    try {
      const data = await adminGet<AdminTicketPage>("/tickets", {
        q: current.q,
        status: current.status,
        unread: current.unread ? "1" : undefined,
        page: currentPage,
        pageSize: PAGE_SIZE,
      });
      // Ignore an answer to a query the admin has already changed.
      if (latest.current.filters !== current || latest.current.page !== currentPage) return { again: true };
      setList(data);
      setError(null);
      setLoading(false);
      return {};
    } catch (failure) {
      if (failure instanceof AdminApiError && failure.status === 401) {
        window.location.assign(`${BASE_PATH}/sign-in`);
        return { stop: true };
      }
      setError(ticketErrorMessage(failure, "The ticket list could not be refreshed."));
      setLoading(false);
      throw failure;
    }
  }, []);

  const { connection, trigger } = useVisiblePolling(fetchList, { intervalMs: LIST_POLL_MS });

  // Browser back/forward restores the filters and the open ticket.
  useEffect(() => {
    const onPop = () => {
      const next = readLocation();
      setFilters(next.filters);
      setSearch(next.filters.q);
      setPage(next.page);
      setSelectedId(next.selectedId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  // Any change to the query refetches immediately (the interval only keeps it fresh afterwards).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; } // the polling hook already fetches on mount
    trigger();
  }, [filters, page, trigger]);

  function navigate(nextFilters: InboxFilters, nextPage: number, nextSelected: string | null, mode: "push" | "replace") {
    const url = urlFor(nextFilters, nextPage, nextSelected);
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }

  function updateFilters(patch: Partial<InboxFilters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    setPage(1);
    navigate(next, 1, selectedId, "replace");
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => updateFilters({ q: value.trim() }), 300);
  }

  function select(ticketId: string | null) {
    setSelectedId(ticketId);
    navigate(filters, page, ticketId, "push");
  }

  function changePage(next: number) {
    setPage(next);
    navigate(filters, next, selectedId, "replace");
  }

  // Keep the row in step with what the conversation just learned (status, unread cleared) without waiting for the next list poll.
  const onTicketChange = useCallback((ticket: TicketSummary) => {
    setList((current) => (current
      ? { ...current, tickets: current.tickets.map((row) => (row.ticketId === ticket.ticketId ? { ...row, status: ticket.status, unread: ticket.unread, lastMessageAt: ticket.lastMessageAt, messageCount: ticket.messageCount } : row)) }
      : current));
  }, []);

  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <div className="flex h-[calc(100dvh-3.5rem-3rem)] min-h-[30rem] overflow-hidden rounded-lg border border-border bg-card">
      <section aria-label="Conversation" className={cn("min-h-0 min-w-0 flex-1 md:block", selectedId ? "block" : "hidden")}>
        {selectedId ? (
          <LiveTicketThread key={selectedId} ticketId={selectedId} onBack={() => select(null)} onTicketChange={onTicketChange} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <MessageSquareText className="h-8 w-8" aria-hidden />
            <p className="text-sm">Select a ticket to read and reply.</p>
          </div>
        )}
      </section>

      <section
        aria-label="Ticket inbox"
        className={cn("min-h-0 w-full flex-col border-border md:flex md:w-[22rem] md:shrink-0 md:border-l", selectedId ? "hidden" : "flex")}
      >
        <div className="space-y-3 border-b border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-base font-semibold">Support tickets</h1>
            <div className="flex items-center gap-2">
              {list && list.unreadTotal > 0 ? <Badge variant="warning">{list.unreadTotal.toLocaleString("en-US")} unread</Badge> : null}
              <ConnectionStatus connection={connection} />
            </div>
          </div>
          <TicketsFilters filters={filters} search={search} onSearchChange={onSearchChange} onChange={updateFilters} />
        </div>
        <TicketInbox
          tickets={list ? list.tickets : null}
          selectedId={selectedId}
          loading={loading}
          error={error}
          page={page}
          pages={pages}
          total={list?.total ?? 0}
          onSelect={select}
          onPage={changePage}
          onRetry={() => trigger()}
        />
      </section>
    </div>
  );
}
