import Link from "next/link";

import { Age } from "@/components/reliability/age";
import { EVENT_SEVERITY_LABEL, type ReliabilityEvent } from "@/lib/reliability";
import { formatDateTime } from "@/lib/utils";

function target(event: ReliabilityEvent): string | null {
  if (event.incidentId) return `/reliability/incidents/${encodeURIComponent(event.incidentId)}`;
  if (event.orderKey?.startsWith("wallet:")) return `/reliability/orders/${encodeURIComponent(event.orderKey.slice("wallet:".length))}`;
  if (event.source === "records" && event.correlationId) return `/sentinel/transactions/${encodeURIComponent(event.correlationId)}`;
  return null;
}

/** One event. Its severity is written out as well as coloured, and a row with an investigation links to it. */
export function EventRow({ event, wide = false }: { event: ReliabilityEvent; wide?: boolean }) {
  const href = target(event);
  const content = (
    <>
      <span className="rf-event-mark" data-severity={event.severity} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{event.message}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {EVENT_SEVERITY_LABEL[event.severity]} · {event.type} · {event.component}{event.count > 1 ? ` · ${event.count} times` : ""}
          {wide && event.correlationId ? ` · ref ${event.correlationId}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-right text-xs text-muted-foreground">
        <Age at={event.at} className="block" />
        {wide ? <span className="hidden sm:block">{formatDateTime(event.at)}</span> : null}
      </span>
    </>
  );
  return (
    <li className="mf-feed-row" data-event-id={event.id}>
      {href
        ? <Link href={href} className="flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent">{content}</Link>
        : <div className="flex min-h-11 items-center gap-3 px-2 py-1.5">{content}</div>}
    </li>
  );
}
