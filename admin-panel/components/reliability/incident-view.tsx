import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { EventRow } from "@/components/reliability/event-row";
import { OrderRows } from "@/components/reliability/order-rows";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SEVERITY_LABEL, SEVERITY_VARIANT, formatDuration, type IncidentDetail } from "@/lib/reliability";
import { formatDateTime, formatNumber } from "@/lib/utils";

/** The evidence for one incident, what it can affect, and where to look next. Every step reads or links; none acts. */
export function IncidentView({ incident, labels }: { incident: IncidentDetail; labels: Record<string, string> }) {
  const end = incident.resolvedAt ?? incident.lastDetectedAt;
  const lasted = new Date(end).getTime() - new Date(incident.firstDetectedAt).getTime();
  const name = (id: string) => labels[id] ?? id;

  return (
    <div className="space-y-4">
      <section className="mf-surface p-5" aria-labelledby="rf-incident-title" data-testid="incident">
        <div className="relative z-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={SEVERITY_VARIANT[incident.severity]}>{SEVERITY_LABEL[incident.severity]}</Badge>
            <Badge variant={incident.state === "open" ? "outline" : "success"}>{incident.state === "open" ? "Open" : "Resolved"}</Badge>
            {incident.escalatedAt ? <span className="text-xs text-muted-foreground">Escalated {formatDateTime(incident.escalatedAt)}</span> : null}
            {incident.reopenCount ? <span className="text-xs text-muted-foreground">Reopened {incident.reopenCount} {incident.reopenCount === 1 ? "time" : "times"}</span> : null}
          </div>
          <h2 id="rf-incident-title" className="mt-3 text-xl font-semibold tracking-tight">{incident.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{incident.summary}</p>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <div><dt className="text-xs text-muted-foreground">First detected</dt><dd className="text-sm font-semibold">{formatDateTime(incident.firstDetectedAt)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{incident.resolvedAt ? "Resolved" : "Last seen"}</dt><dd className="text-sm font-semibold">{formatDateTime(end)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Duration</dt><dd className="text-sm font-semibold tabular-nums">{formatDuration(lasted)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Times detected</dt><dd className="text-sm font-semibold tabular-nums">{formatNumber(incident.detections)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Orders affected</dt><dd className="text-sm font-semibold tabular-nums">{incident.affectedOrders == null ? "Not calculable" : formatNumber(incident.affectedOrders)}</dd></div>
          </dl>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Evidence</CardTitle><CardDescription className="text-xs">What the monitor saw, and where it read it.</CardDescription></CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-sm">
              {incident.evidence.map((item) => (
                <div key={`${item.label}:${item.value}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="min-w-0 text-right"><span className="break-words font-medium">{item.value}</span>{item.source ? <span className="ml-2 text-xs text-muted-foreground">{item.source}</span> : null}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Where to look next</CardTitle><CardDescription className="text-xs">Nothing here runs from this page. Each step only reads, or opens an existing audited tool.</CardDescription></CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {incident.nextSteps.map((step, index) => (
                <li key={step.text} className="flex gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums">{index + 1}</span>
                  <span>{step.text}{step.href ? <> <Link href={step.href} className="font-medium text-primary underline-offset-4 hover:underline">Open</Link></> : null}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-foreground">What it can affect</CardTitle><CardDescription className="text-xs">{name(incident.component)} and everything that depends on it, from the dependency map.</CardDescription></CardHeader>
        <CardContent>
          <ul className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="incident-path">
            {incident.affectedComponents.map((id, index) => (
              <li key={id} className="inline-flex items-center gap-1.5">
                {index === 1 ? <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : null}
                <span className="rounded-md border border-border px-2 py-0.5 data-[source=true]:border-primary data-[source=true]:font-medium" data-source={id === incident.component}>{name(id)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {incident.orders.length ? (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Affected orders</CardTitle><CardDescription className="text-xs">From the order records. Customer ids are masked.</CardDescription></CardHeader>
          <CardContent className="px-3 pb-3"><OrderRows rows={incident.orders} /></CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Lifecycle</CardTitle></CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {incident.timeline.map((item) => (
                <li key={`${item.at}:${item.kind}`} className="flex gap-3">
                  <span className="w-20 shrink-0 text-xs capitalize text-muted-foreground">{item.kind}</span>
                  <span className="min-w-0"><span className="block">{item.note}</span><span className="text-xs text-muted-foreground">{formatDateTime(item.at)}</span></span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Correlated events</CardTitle><CardDescription className="text-xs">Warnings and errors on affected components, around this time.</CardDescription></CardHeader>
          <CardContent className="px-3 pb-3">
            {incident.events.length ? <ul className="space-y-0.5">{incident.events.map((event) => <EventRow key={event.id} event={event} />)}</ul> : <p className="px-2 text-sm text-muted-foreground">No stored event matches.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
