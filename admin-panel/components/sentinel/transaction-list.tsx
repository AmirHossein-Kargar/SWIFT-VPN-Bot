import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SeverityBadge } from "@/components/sentinel/labels";
import type { TransactionRow } from "@/lib/sentinel";
import { formatDateTime, formatToman } from "@/lib/utils";

export function TransactionList({ items }: { items: TransactionRow[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => (
        <li key={item.key}>
          <Link href={`/sentinel/transactions/${encodeURIComponent(item.key)}`} className="flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {item.label}
                <Badge variant="outline">{item.providerLabel}</Badge>
                <Badge variant="muted">{item.status.replace(/_/g, " ")}</Badge>
                {item.anomaly ? <SeverityBadge severity={item.anomaly.severity} /> : null}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {item.user ?? "unknown"} · {formatDateTime(item.createdAt)}{item.payCurrency ? ` · ${item.payCurrency}` : ""} · <span className="font-mono">{item.key.split(":").slice(1).join(":")}</span>
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold tabular-nums">{item.amount == null ? "—" : formatToman(item.amount)}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
