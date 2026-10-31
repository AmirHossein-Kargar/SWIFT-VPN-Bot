import Link from "next/link";
import { ChevronRight, ShieldCheck } from "lucide-react";

import { adminApiGet } from "@/lib/adminApi.server";
import { SEVERITIES, SEVERITY_LABEL, SEVERITY_VARIANT, type IncidentPage, type Snapshot } from "@/lib/reliability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { PaginationNav } from "@/components/shared/pagination-nav";
import { Age } from "@/components/reliability/age";
import { UrlFilters } from "@/components/sentinel/url-filters";
import { formatDateTime, formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function ReliabilityIncidentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const state = first(params.state) || "open";
  const severity = first(params.severity);
  const component = first(params.component);
  const page = Number(first(params.page)) || 1;
  const [result, snapshot] = await Promise.all([
    adminApiGet<IncidentPage>("/reliability/incidents", { state, severity, component, page, pageSize: 25 }),
    adminApiGet<Snapshot>("/reliability/snapshot").catch(() => null),
  ]);
  const labels = new Map((snapshot?.components ?? []).map((item) => [item.id, item.label]));

  return (
    <div className="space-y-4">
      <UrlFilters
        filters={[
          { kind: "select", name: "state", label: "Incident state", value: state, width: "w-36", options: [{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }, { value: "all", label: "Open and resolved" }] },
          { kind: "select", name: "severity", label: "Severity", value: severity || "all", width: "w-36", options: [{ value: "all", label: "All severities" }, ...SEVERITIES.map((value) => ({ value, label: SEVERITY_LABEL[value] }))] },
          { kind: "select", name: "component", label: "Component", value: component || "all", options: [{ value: "all", label: "All components" }, ...(snapshot?.components ?? []).map((item) => ({ value: item.id, label: item.label }))] },
        ]}
      />
      <p className="text-sm text-muted-foreground">{formatNumber(result.total)} {result.total === 1 ? "incident" : "incidents"}. A problem that continues is one row, however many checks saw it.{result.degraded.length ? " The incident history is unavailable, so only those in memory are listed." : ""}</p>
      <Card>
        <CardContent className="p-0">
          {result.items.length ? (
            <ul className="divide-y divide-border px-4" data-testid="incident-list">
              {result.items.map((incident) => (
                <li key={incident.id}>
                  <Link href={`/reliability/incidents/${incident.id}`} className="mf-finding-row" data-severity={incident.state === "resolved" ? undefined : incident.severity}>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={SEVERITY_VARIANT[incident.severity]}>{SEVERITY_LABEL[incident.severity]}</Badge>
                        <Badge variant={incident.state === "open" ? "outline" : "success"}>{incident.state === "open" ? "Open" : "Resolved"}</Badge>
                        {incident.reopenCount ? <span className="text-xs text-muted-foreground">Reopened {incident.reopenCount} {incident.reopenCount === 1 ? "time" : "times"}</span> : null}
                      </span>
                      <span className="mt-1.5 block font-medium">{incident.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {labels.get(incident.component) ?? incident.component} · first seen {formatDateTime(incident.firstDetectedAt)}{incident.affectedOrders ? ` · ${formatNumber(incident.affectedOrders)} orders` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground"><Age at={incident.resolvedAt ?? incident.lastDetectedAt} className="block" /></span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={ShieldCheck} title={state === "open" ? "No open incidents" : "Nothing here"} hint="No incident matches. This means no rule fired, which is not proof of health: the command center shows what has evidence." />
          )}
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={result.pages} />
    </div>
  );
}
