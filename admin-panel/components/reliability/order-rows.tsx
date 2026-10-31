import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { ORDER_STATUS_LABEL, formatDuration, type OrderRow } from "@/lib/reliability";

/** Rows rather than a table, so a phone needs no sideways scroll. A customer id is masked here; the trace does not need it. */
export function OrderRows({ rows }: { rows: OrderRow[] }) {
  return (
    <ul className="divide-y divide-border" data-testid="order-rows">
      {rows.map((row) => (
        <li key={row.key}>
          <Link href={`/reliability/orders/${encodeURIComponent(row.orderId)}`} className="mf-finding-row" data-severity={row.overdue ? "high" : undefined}>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{ORDER_STATUS_LABEL[row.status] ?? row.status}</span>
              <span className="block truncate text-xs text-muted-foreground">{row.user ?? "unknown customer"} · {row.orderId}{row.errorCode ? ` · ${row.errorCode}` : ""}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm font-semibold tabular-nums">{formatDuration(row.ageMs)}</span>
              <span className="block text-xs text-muted-foreground">{row.overdue ? `limit ${formatDuration(row.limitMs)}` : "within limit"}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
