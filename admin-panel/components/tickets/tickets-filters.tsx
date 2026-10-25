"use client";

import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STATUS_LABELS, TICKET_STATUSES, type TicketStatus } from "@/lib/tickets";

export interface InboxFilters {
  q: string;
  status: TicketStatus | "";
  unread: boolean;
}

const ALL = "all";

/**
 * Inbox filters. The status options are the canonical ticket statuses, the same
 * values (and labels) the conversation's status dropdown uses.
 */
export function TicketsFilters({
  filters,
  search,
  onSearchChange,
  onChange,
}: {
  filters: InboxFilters;
  /** Text currently typed in the search box (debounced into `filters.q` by the parent). */
  search: string;
  onSearchChange: (value: string) => void;
  onChange: (patch: Partial<InboxFilters>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Ticket ID, Telegram ID or subject"
          aria-label="Search tickets"
          className="pl-8"
          dir="auto"
        />
      </div>
      <div className="flex items-center gap-2">
        <Select value={filters.status || ALL} onValueChange={(value) => onChange({ status: value === ALL ? "" : (value as TicketStatus) })}>
          <SelectTrigger className="h-8 flex-1 text-xs" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {TICKET_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>{STATUS_LABELS[status]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={filters.unread}
            onChange={(event) => onChange({ unread: event.target.checked })}
          />
          Unread only
        </label>
      </div>
    </div>
  );
}
