"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AlertTriangle, CircleSlash } from "lucide-react";

import { EventRow } from "@/components/reliability/event-row";
import { useFeed, useFeedStore } from "@/components/reliability/feed-provider";
import { Card, CardContent } from "@/components/ui/card";
import { stripBasePath } from "@/lib/basePath";
import { matchesFilters, mergeEvents, type EventFilters, type EventPage } from "@/lib/reliability";

const WINDOW_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000 };

/** The page the server returned, with live events merged in by id, so a reconnect or a repeat cannot show one event twice. */
export function EventTimeline({ page, filters, range, paged }: { page: EventPage; filters: EventFilters; range: string; paged: boolean }) {
  const store = useFeedStore();
  const connection = useFeed((state) => state.connection);
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [events, setEvents] = useState(page.events);
  const anchor = useRef(Date.now());

  useEffect(() => {
    if (paged) return;
    const since = anchor.current - (WINDOW_MS[range] ?? 3_600_000);
    return store.onEvents((incoming) => {
      const fitting = incoming.filter((event) => matchesFilters(event, { ...filters, since }));
      if (fitting.length) setEvents((current) => mergeEvents(current, fitting, 300));
    });
  }, [store, filters, range, paged]);

  const older = useMemo(() => {
    if (!page.nextBefore) return null;
    const next = new URLSearchParams(searchParams.toString());
    next.set("before", page.nextBefore);
    return `${pathname}?${next.toString()}`;
  }, [page.nextBefore, pathname, searchParams]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground" role="status">
        {events.length} {events.length === 1 ? "event" : "events"} listed. {paged ? "Older page; live events are not added here." : connection === "live" ? "New events appear here as they happen." : "Live updates are paused until the connection returns."}
      </p>
      {page.degraded.length ? (
        <p className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          Some sources did not answer, so this list may be incomplete: {page.degraded.join(", ")}.
        </p>
      ) : null}
      {page.truncated ? <p className="text-xs text-muted-foreground">Busy period: older order and payment stages may be missing here. Sentinel&apos;s Transactions lists them all.</p> : null}
      <Card>
        <CardContent className="p-3" data-testid="event-list">
          {events.length ? (
            <ul className="space-y-0.5">{events.map((event) => <EventRow key={event.id} event={event} wide />)}</ul>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <CircleSlash className="h-5 w-5" aria-hidden />
              Nothing matches in this window.
            </div>
          )}
        </CardContent>
      </Card>
      {older ? <Link href={older} className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">Older events</Link> : null}
    </div>
  );
}
