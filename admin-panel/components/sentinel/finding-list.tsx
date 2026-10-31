import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { ClassificationBadge, ReviewBadge, SeverityBadge } from "@/components/sentinel/labels";
import { DIRECTION_LABEL, type FindingSummary } from "@/lib/sentinel";
import { formatDateTime, formatToman } from "@/lib/utils";

/** A list of rows rather than a table: it needs no sideways scroll on a phone. */
export function FindingList({ items }: { items: FindingSummary[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((finding) => (
        <li key={finding.id}>
          <Link href={`/sentinel/reconciliation/${finding.id}`} className="mf-finding-row" data-severity={finding.severity}>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <SeverityBadge severity={finding.severity} />
                <ClassificationBadge classification={finding.classification} />
                {finding.state === "cleared" ? <span className="text-xs font-medium text-muted-foreground">Cleared</span> : <ReviewBadge review={finding.review} />}
              </span>
              <span className="mt-1.5 block font-medium">{finding.title}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {finding.user ?? "unknown customer"} · {finding.subject} · first seen {formatDateTime(finding.firstDetectedAt)}
              </span>
            </span>
            <span className="shrink-0 text-right">
              {finding.amountToman > 0 ? (
                <>
                  <span className="block text-sm font-semibold tabular-nums">{formatToman(finding.amountToman)}</span>
                  <span className="block text-xs text-muted-foreground">{DIRECTION_LABEL[finding.direction]}</span>
                </>
              ) : null}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
