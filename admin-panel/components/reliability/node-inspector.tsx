"use client";

import Link from "next/link";
import { X } from "lucide-react";

import { Age } from "@/components/reliability/age";
import { EventRow } from "@/components/reliability/event-row";
import { useFeed } from "@/components/reliability/feed-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EVIDENCE_LABEL, SEVERITY_VARIANT, STATE_LABEL, STATE_MEANING, STATE_VARIANT, type ComponentHealth, type ComponentId, type Snapshot } from "@/lib/reliability";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function Names({ ids, components, onSelect }: { ids: ComponentId[]; components: ComponentHealth[]; onSelect: (id: ComponentId) => void }) {
  if (!ids.length) return <span className="text-muted-foreground">None</span>;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {ids.map((id) => (
        <button key={id} type="button" onClick={() => onSelect(id)} className="rounded border border-border px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-accent [@media(pointer:coarse)]:min-h-8">
          {components.find((item) => item.id === id)?.label ?? id}
        </button>
      ))}
    </span>
  );
}

/** Everything known about one component, and how it is known. */
export function NodeInspector({ component, snapshot, onSelect }: { component: ComponentHealth; snapshot: Snapshot; onSelect: (id: ComponentId | null) => void }) {
  const events = useFeed((state) => state.events);
  const related = events.filter((event) => event.component === component.id).slice(0, 5);
  const incidents = snapshot.incidents.open.filter((incident) => incident.path.includes(component.id));
  const dependents = snapshot.components.filter((item) => item.dependsOn.includes(component.id)).map((item) => item.id);

  return (
    <aside className="rf-inspector" aria-label={`${component.label} details`} data-testid="inspector">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{component.label}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{component.role}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => onSelect(null)} aria-label="Close details"><X aria-hidden /></Button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Badge variant={STATE_VARIANT[component.state]}>{STATE_LABEL[component.state]}</Badge>
        <span className="text-xs text-muted-foreground">{STATE_MEANING[component.state]}</span>
      </div>
      <p className="mt-2 text-sm">{component.reason}</p>
      <dl className="mt-3 divide-y divide-border border-y border-border text-xs">
        <Row label="Evidence">{EVIDENCE_LABEL[component.evidence]}</Row>
        <Row label="Last checked"><Age at={component.checkedAt} fallback="Never" /></Row>
        <Row label="Last success"><Age at={component.lastSuccessAt} fallback="None seen" /></Row>
        {component.latencyMs != null ? <Row label="Latency">{component.latencyMs} ms</Row> : null}
        {component.details.map((row) => <Row key={row.label} label={row.label}>{row.value}</Row>)}
        <Row label="Depends on"><Names ids={component.dependsOn} components={snapshot.components} onSelect={onSelect} /></Row>
        <Row label="Needed by"><Names ids={dependents} components={snapshot.components} onSelect={onSelect} /></Row>
      </dl>
      {incidents.length ? (
        <div className="mt-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Related incidents</h4>
          <ul className="mt-1 space-y-1">
            {incidents.slice(0, 4).map((incident) => (
              <li key={incident.id}>
                <Link href={`/reliability/incidents/${incident.id}`} className="flex min-h-9 items-center gap-2 rounded-md px-1 text-sm hover:bg-accent">
                  <Badge variant={SEVERITY_VARIANT[incident.severity]}>{incident.severity}</Badge>
                  <span className="min-w-0 truncate">{incident.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-3">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent events</h4>
        {related.length ? <ul className="mt-1">{related.map((event) => <EventRow key={event.id} event={event} />)}</ul> : <p className="mt-1 text-sm text-muted-foreground">Nothing recorded for this component here.</p>}
      </div>
    </aside>
  );
}
