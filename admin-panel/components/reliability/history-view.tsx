"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { HistoryChartLazy } from "@/components/reliability/history-chart-lazy";
import { RangeSwitch } from "@/components/reliability/range-switch";
import { useNavigate } from "@/components/shared/navigation-pending";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminGet } from "@/lib/adminApi.client";
import { stripBasePath } from "@/lib/basePath";
import { STATE_LABEL, formatCoverage, formatDuration, formatPercent, formatPercentile, type HealthState, type History, type HistoryPoint, type RangeName } from "@/lib/reliability";
import { formatDateTime, formatNumber } from "@/lib/utils";

const REFRESH_MS = 60_000;
const LEGEND: (HealthState | "none")[] = ["healthy", "degraded", "failed", "stale", "unknown", "none"];

/** One row per component, one cell per time bucket. A blank cell is a time nobody was measuring. */
function AvailabilityStrip({ history }: { history: History }) {
  return (
    <div className="space-y-1.5" data-testid="availability">
      {history.components.map((component) => (
        <div key={component.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <span className="truncate text-xs text-muted-foreground">{component.label}</span>
          <div className="rf-strip" role="img" aria-label={`${component.label}: availability over the window`}>
            {history.points.map((point) => {
              const state = point.health[component.id];
              return <span key={point.t} data-state={state ?? "none"} title={`${formatDateTime(point.t)}: ${state ? STATE_LABEL[state] : "not measured"}`} />;
            })}
          </div>
        </div>
      ))}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
        {LEGEND.map((state) => <li key={state} className="inline-flex items-center gap-1.5"><span className="rf-strip-key" data-state={state} aria-hidden />{state === "none" ? "Not measured" : STATE_LABEL[state]}</li>)}
      </ul>
    </div>
  );
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2"><CardTitle className="text-foreground">{title}</CardTitle><CardDescription className="text-xs">{description}</CardDescription></CardHeader>
      <CardContent><div className="h-44">{children}</div></CardContent>
    </Card>
  );
}

function DataTable({ points }: { points: HistoryPoint[] }) {
  return (
    <details className="rounded-md border border-border bg-card px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Table view</summary>
      <div className="mt-2 max-h-80 overflow-auto">
        <table className="w-full min-w-[32rem] text-left text-xs">
          <thead className="text-muted-foreground"><tr><th className="py-1 pr-3 font-medium">Bucket</th><th className="pr-3 font-medium">Handled</th><th className="pr-3 font-medium">Errors</th><th className="pr-3 font-medium">Timeouts</th><th className="pr-3 font-medium">P95</th><th className="font-medium">Provider P95</th></tr></thead>
          <tbody className="divide-y divide-border tabular-nums">
            {points.map((point) => (
              <tr key={point.t}>
                <th scope="row" className="py-1 pr-3 font-normal">{formatDateTime(point.t)}</th>
                <td className="pr-3">{point.requests == null ? "not measured" : formatNumber(point.requests)}</td>
                <td className="pr-3">{point.errors ?? "—"}</td>
                <td className="pr-3">{point.timeouts ?? "—"}</td>
                <td className="pr-3">{formatDuration(point.p95Ms)}</td>
                <td>{formatDuration(point.providerP95Ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Small multiples: throughput, failures and latency differ in scale, so each gets its own chart and axis. */
export function HistoryView({ initial }: { initial: History }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const [history, setHistory] = useState(initial);
  const metrics = history.metrics;

  useEffect(() => {
    const refresh = setInterval(async () => {
      if (document.hidden) return;
      try { setHistory(await adminGet<History>("/reliability/history", { range: initial.range })); } catch { /* the connection status reports it */ }
    }, REFRESH_MS);
    return () => clearInterval(refresh);
  }, [initial.range]);

  const covered = metrics?.coverage;
  const partial = covered ? covered.ratio < 0.995 : true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{covered ? formatCoverage(covered) : "No telemetry yet"}. Telemetry starts when this feature is deployed, and 24 hours of it are kept in view.</p>
        <RangeSwitch value={history.range} onChange={(range: RangeName) => navigate(`${pathname}?range=${range}`)} />
      </div>
      {partial ? (
        <p className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status" data-testid="coverage-note">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          Part of this window was not measured. Gaps in the charts mean no data, not zero.
        </p>
      ) : null}
      {metrics ? (
        <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="p-4"><dt className="text-xs text-muted-foreground">Handled</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(metrics.throughput.count)}</dd></Card>
          <Card className="p-4"><dt className="text-xs text-muted-foreground">Error rate</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{metrics.errors.rate == null ? `${formatNumber(metrics.errors.count)} errors` : formatPercent(metrics.errors.rate)}</dd></Card>
          <Card className="p-4"><dt className="text-xs text-muted-foreground">HTTP P50 / P95 / P99</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{metrics.latency.http.p50 ? `${formatPercentile(metrics.latency.http.p50)} / ${formatPercentile(metrics.latency.http.p95)} / ${formatPercentile(metrics.latency.http.p99)}` : `${formatNumber(metrics.latency.http.samples)} samples, too few`}</dd></Card>
          <Card className="p-4"><dt className="text-xs text-muted-foreground">Reservation to delivery</dt><dd className="mt-1 text-sm font-semibold tabular-nums">{metrics.orders?.fulfilment.p50 ? `${formatPercentile(metrics.orders.fulfilment.p50, { exact: true })} / ${formatPercentile(metrics.orders.fulfilment.p95, { exact: true })}` : `${formatNumber(metrics.orders?.fulfilment.samples ?? 0)} orders, too few`}</dd></Card>
        </dl>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Throughput" description="Requests, callbacks and Telegram updates per measured minute"><HistoryChartLazy points={history.points} metric="perMinute" unit="/min" /></ChartCard>
        <ChartCard title="Failures" description="5xx answers, failed and timed-out provider calls per bucket"><HistoryChartLazy points={history.points} metric="errors" unit="failures" tone="bad" /></ChartCard>
        <ChartCard title="P95 latency" description="HTTP and webhook handling. Blank with too few samples"><HistoryChartLazy points={history.points} metric="p95Ms" unit="ms" /></ChartCard>
      </div>
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-foreground">Component history</CardTitle><CardDescription className="text-xs">The worst state each component reached in each bucket.</CardDescription></CardHeader>
        <CardContent><AvailabilityStrip history={history} /></CardContent>
      </Card>
      <DataTable points={history.points} />
    </div>
  );
}
