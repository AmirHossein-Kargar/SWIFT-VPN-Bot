"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CircleCheck, CloudOff, List, Network } from "lucide-react";

import { EventRow } from "@/components/reliability/event-row";
import { useFeed } from "@/components/reliability/feed-provider";
import { KpiGrid } from "@/components/reliability/kpi-grid";
import { NodeInspector } from "@/components/reliability/node-inspector";
import { RangeSwitch } from "@/components/reliability/range-switch";
import { StatusCore } from "@/components/reliability/status-core";
import { Topology, TopologyLegend, TopologyList } from "@/components/reliability/topology";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CONNECTION_LABEL, SEVERITIES, SEVERITY_LABEL, SEVERITY_VARIANT, STATE_LABEL, staleView, type ComponentHealth, type ComponentId, type HealthState, type IncidentBrief, type RangeName, type Snapshot } from "@/lib/reliability";
import { cn, formatNumber } from "@/lib/utils";

const HEADLINE: Record<HealthState, string> = {
  healthy: "Operating normally",
  degraded: "Something needs attention",
  failed: "The service is failing",
  stale: "Monitoring has gone quiet",
  unknown: "Health cannot be established",
};

const VIEW_KEY = "reliability-topology-view";

function readView(): "diagram" | "list" {
  try { return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "diagram"; } catch { return "diagram"; }
}

function Hero({ snapshot }: { snapshot: Snapshot }) {
  const { overall, incidents, components } = snapshot;
  const unverified = overall.unverified.map((id) => components.find((item) => item.id === id)?.label ?? id);
  return (
    <section className="mf-surface mf-hero rf-hero" aria-labelledby="rf-state" data-testid="overall" data-state={overall.state}>
      <div className="relative z-10 min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Overall service health: {STATE_LABEL[overall.state]}</p>
        <h2 id="rf-state" className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{HEADLINE[overall.state]}</h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">{overall.reason}</p>
        {unverified.length ? <p className="mt-2 max-w-xl text-xs text-muted-foreground">No recent evidence for: {unverified.join(", ")}.</p> : null}
        <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <dt className="text-xs text-muted-foreground">Open incidents</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatNumber(incidents.openCount)}</dd>
          </div>
          {SEVERITIES.filter((severity) => incidents.bySeverity[severity] > 0).map((severity) => (
            <div key={severity}>
              <dt className="text-xs text-muted-foreground">{SEVERITY_LABEL[severity]}</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatNumber(incidents.bySeverity[severity])}</dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-muted-foreground">Working with evidence</dt>
            <dd className="text-lg font-semibold tabular-nums">{components.filter((item) => item.state === "healthy").length} of {components.length}</dd>
          </div>
        </dl>
      </div>
      <StatusCore components={components} overall={overall.state} />
    </section>
  );
}

function IncidentRows({ incidents, active, onHighlight }: { incidents: IncidentBrief[]; active: string | null; onHighlight: (incident: IncidentBrief | null) => void }) {
  if (!incidents.length) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><CircleCheck className="h-4 w-4 text-success" aria-hidden />No open incidents.</p>;
  }
  return (
    <ul className="space-y-1">
      {incidents.map((incident) => (
        <li key={incident.id} className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={active === incident.id}
            onClick={() => onHighlight(active === incident.id ? null : incident)}
            className="mf-finding-row min-w-0 flex-1 rounded-md text-left aria-pressed:bg-accent"
            data-severity={incident.severity}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2"><Badge variant={SEVERITY_VARIANT[incident.severity]}>{SEVERITY_LABEL[incident.severity]}</Badge></span>
              <span className="mt-1 block text-sm font-medium">{incident.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{incident.affectedOrders ? `${formatNumber(incident.affectedOrders)} ${incident.affectedOrders === 1 ? "order" : "orders"} affected. ` : ""}{incident.summary}</span>
            </span>
          </button>
          <Link href={`/reliability/incidents/${incident.id}`} className="inline-flex shrink-0 items-center rounded-md px-2 py-2 text-xs font-medium text-primary underline-offset-4 hover:underline [@media(pointer:coarse)]:min-h-10">Open</Link>
        </li>
      ))}
    </ul>
  );
}

const selectSnapshot = (state: { snapshot: Snapshot | null }) => state.snapshot;
const selectEvents = (state: { events: Snapshot["recentEvents"] }) => state.events;
const selectConnection = (state: { connection: keyof typeof CONNECTION_LABEL }) => state.connection;

export function CommandCenter() {
  const received = useFeed(selectSnapshot);
  const events = useFeed(selectEvents);
  const connection = useFeed(selectConnection);
  const snapshot = useMemo(() => (received ? staleView(received, connection) : null), [received, connection]);
  const [range, setRange] = useState<RangeName>("1h");
  const [node, setNode] = useState<ComponentId | null>(null);
  const [incident, setIncident] = useState<IncidentBrief | null>(null);
  const [view, setView] = useState<"diagram" | "list">("diagram");

  useEffect(() => setView(readView()), []);

  const chooseView = useCallback((next: "diagram" | "list") => {
    setView(next);
    try { window.localStorage.setItem(VIEW_KEY, next); } catch { /* a remembered preference is optional */ }
  }, []);

  const select = useCallback((id: ComponentId | null) => { setIncident(null); setNode(id); }, []);
  const highlightIncident = useCallback((next: IncidentBrief | null) => { setNode(null); setIncident(next); }, []);
  const selection = useMemo(() => ({ node, path: incident?.path ?? null }), [node, incident]);

  if (!snapshot) {
    return (
      <div className="mf-surface flex flex-col items-center gap-2 px-6 py-16 text-center" role="status" data-testid="no-data">
        <CloudOff className="h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{connection === "connecting" ? "Connecting to the monitor" : "The monitor could not be reached"}</p>
        <p className="max-w-sm text-sm text-muted-foreground">Nothing can be said about the service until it answers. This page keeps trying.</p>
      </div>
    );
  }

  const selected: ComponentHealth | undefined = node ? snapshot.components.find((item) => item.id === node) : undefined;
  const degradedConnection = !["live", "connecting", "polling"].includes(connection);
  const recent = events.filter((event) => event.severity !== "debug").slice(0, 30);

  return (
    <div className="space-y-4">
      {degradedConnection ? (
        <p className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status" data-testid="connection-banner">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          {CONNECTION_LABEL[connection].detail}
        </p>
      ) : null}

      <div className={cn(degradedConnection && "rf-stale")}>
        <Hero snapshot={snapshot} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Signals</h2>
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      <KpiGrid snapshot={snapshot} range={range} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="rf-topology-title" className="mf-surface min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="rf-topology-title" className="text-sm font-semibold">Service topology</h2>
              <p className="text-xs text-muted-foreground">The real components and links of this process. Dots show traffic measured in the last 15 minutes.</p>
            </div>
            <div className="hidden gap-1 md:inline-flex" role="group" aria-label="Topology view">
              <button type="button" aria-pressed={view === "diagram"} onClick={() => chooseView("diagram")} className="rf-toggle"><Network className="h-3.5 w-3.5" aria-hidden />Diagram</button>
              <button type="button" aria-pressed={view === "list"} onClick={() => chooseView("list")} className="rf-toggle"><List className="h-3.5 w-3.5" aria-hidden />List</button>
            </div>
          </div>
          {snapshot.edges.length ? (
            <>
              <div className={cn("hidden", view === "diagram" && "md:block")}><Topology components={snapshot.components} edges={snapshot.edges} selection={selection} onSelect={select} /></div>
              <div className={cn(view === "diagram" && "md:hidden")}><TopologyList components={snapshot.components} edges={snapshot.edges} selection={selection} onSelect={select} /></div>
              <div className="mt-3"><TopologyLegend edges={snapshot.edges} /></div>
            </>
          ) : (
            <TopologyList components={snapshot.components} edges={snapshot.edges} selection={selection} onSelect={select} />
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          {selected ? <NodeInspector component={selected} snapshot={snapshot} onSelect={select} /> : null}
          <Card className="min-w-0 flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-foreground">Open incidents</CardTitle>
                <Link href="/reliability/incidents" className="text-xs font-medium text-primary underline-offset-4 hover:underline [@media(pointer:coarse)]:min-h-10">All incidents</Link>
              </div>
              <CardDescription className="text-xs">Choose one to light up what it can affect.</CardDescription>
            </CardHeader>
            <CardContent className="max-h-80 overflow-y-auto"><IncidentRows incidents={snapshot.incidents.open} active={incident?.id ?? null} onHighlight={highlightIncident} /></CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-foreground">Recent operational events</CardTitle>
            <Link href="/reliability/events" className="text-xs font-medium text-primary underline-offset-4 hover:underline [@media(pointer:coarse)]:min-h-10">All events</Link>
          </div>
        </CardHeader>
        <CardContent className="max-h-96 overflow-y-auto px-3 pb-3" data-testid="recent-events">
          {recent.length ? <ul className={cn("space-y-0.5", degradedConnection && "opacity-70")}>{recent.map((event) => <EventRow key={event.id} event={event} />)}</ul> : <p className="px-2 py-6 text-center text-sm text-muted-foreground">No events recorded since this process started.</p>}
        </CardContent>
      </Card>

      <div className="sr-only">
        <table>
          <caption>Components and their state</caption>
          <thead><tr><th>Component</th><th>State</th><th>Why</th></tr></thead>
          <tbody>{snapshot.components.map((item) => <tr key={item.id}><th scope="row">{item.label}</th><td>{STATE_LABEL[item.state]}</td><td>{item.reason}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
