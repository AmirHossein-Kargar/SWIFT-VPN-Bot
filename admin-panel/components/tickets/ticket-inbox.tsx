"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { TicketStatusBadge } from "@/components/tickets/ticket-thread";
import { UserAvatar } from "@/components/users/user-avatar";
import { formatTicketDateTime, ticketCustomerName, type TicketSummary } from "@/lib/tickets";

/**
 * The ticket list. Rows are identified by customer and ticket ID, never by the
 * customer's first message. A row's unread dot is hidden for the ticket
 * currently open on screen (its unread count is being cleared by the
 * conversation), so the list never flags something the admin is already reading.
 */
export function TicketInbox({
  tickets,
  selectedId,
  loading,
  error,
  page,
  pages,
  total,
  onSelect,
  onPage,
  onRetry,
  selectMode = false,
  checked,
  onToggle,
}: {
  tickets: TicketSummary[] | null;
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  page: number;
  pages: number;
  total: number;
  onSelect: (ticketId: string) => void;
  onPage: (page: number) => void;
  onRetry: () => void;
  /** Bulk-delete selection; only tickets the server marked deletable can be ticked. */
  selectMode?: boolean;
  checked?: ReadonlySet<string>;
  onToggle?: (ticketId: string) => void;
}) {
  if (tickets === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
          </>
        ) : (
          <p>{loading ? "Loading tickets…" : "No tickets."}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <p className="border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning" role="alert">{error}</p> : null}
      {tickets.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">No tickets match these filters.</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" aria-label="Tickets">
          {tickets.map((ticket) => {
            const selected = ticket.ticketId === selectedId;
            const unread = selected ? 0 : ticket.unread;
            const customerName = ticketCustomerName(ticket);
            return (
              <li key={ticket.ticketId} className="flex items-stretch">
                {selectMode ? (
                  <label className="flex shrink-0 items-center pl-3" title={ticket.deletable ? undefined : "Only tickets closed more than 72 hours ago can be deleted."}>
                    <Checkbox
                      checked={checked?.has(ticket.ticketId) ?? false}
                      disabled={!ticket.deletable}
                      onCheckedChange={() => onToggle?.(ticket.ticketId)}
                      aria-label={`Select ticket ${ticket.ticketId}`}
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  onClick={() => onSelect(ticket.ticketId)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent",
                    selected && "bg-accent"
                  )}
                >
                  {ticket.userTelegramId ? <UserAvatar telegramId={ticket.userTelegramId} label={customerName ?? ticket.userTelegramId} size={40} /> : null}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className={cn("min-w-0 flex-1 truncate text-sm", unread > 0 ? "font-semibold" : "font-medium")} dir="auto" data-testid="ticket-row-name">{customerName ?? "Unknown customer"}</span>
                      {unread > 0 ? (
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground" aria-label={`${unread} unread`}>
                          {unread > 99 ? "99+" : unread}
                        </span>
                      ) : null}
                      <TicketStatusBadge status={ticket.status} />
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {ticket.userTelegramId ? <>ID <span className="font-mono">{ticket.userTelegramId}</span> · </> : null}
                      <span className="font-mono">{ticket.ticketId}</span>
                    </span>
                    <time className="truncate text-xs text-muted-foreground" dateTime={ticket.lastMessageAt} title={`Opened ${formatTicketDateTime(ticket.createdAt)}`}>Updated {formatTicketDateTime(ticket.lastMessageAt)}</time>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 ? (
        <div className="flex items-center justify-between gap-2 border-t border-border p-2 text-xs text-muted-foreground">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
          <span>Page {page} of {pages} · {total.toLocaleString("en-US")} tickets</span>
          <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}
