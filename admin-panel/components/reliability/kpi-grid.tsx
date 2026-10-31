"use client";

import { memo } from "react";
import Link from "next/link";
import { Activity, AlertOctagon, CheckCheck, Clock, Hourglass, RadioTower, Timer, TimerOff, type LucideIcon } from "lucide-react";

import { Age } from "@/components/reliability/age";
import { Sparkline } from "@/components/reliability/sparkline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ORDER_STATUS_LABEL, RANGES, formatCoverage, formatDuration, formatPercent, formatPercentile, formatRate, type Percentiles, type RangeName, type Snapshot, type WindowMetrics } from "@/lib/reliability";
import { cn, formatNumber } from "@/lib/utils";

function Kpi({ label, icon: Icon, value, unit, hint, source, tone = "default", children, href }: { label: string; icon: LucideIcon; value: string; unit?: string; hint: string; source: string; tone?: "default" | "warning" | "destructive" | "success"; children?: React.ReactNode; href?: string }) {
  const body = (
    <Card className={cn("metric-card flex h-full flex-col", href && "hover:bg-accent/40")}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle>{label}</CardTitle>
        <Icon className={cn("h-4 w-4 text-muted-foreground", tone === "warning" && "text-warning", tone === "destructive" && "text-destructive", tone === "success" && "text-success")} aria-hidden />
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}{unit ? <span className="ml-1 text-sm font-medium text-muted-foreground">{unit}</span> : null}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        <div className="mt-auto pt-2">
          {children}
          <p className="mt-1 text-[11px] text-muted-foreground">{source}</p>
        </div>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block h-full rounded-lg">{body}</Link> : body;
}

function LatencyLine({ name, stats, exact = false }: { name: string; stats: Percentiles; exact?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{name}</span>
      <span className="font-medium tabular-nums">{stats.p50 ? `${formatPercentile(stats.p50, { exact })} / ${formatPercentile(stats.p95, { exact })} / ${formatPercentile(stats.p99, { exact })}` : `${formatNumber(stats.samples)} ${stats.samples === 1 ? "sample" : "samples"}`}</span>
    </div>
  );
}

function LatencyCard({ metrics, range }: { metrics: WindowMetrics; range: string }) {
  const { webhook, providerCreate, http } = metrics.latency;
  const best = [webhook, http, providerCreate].find((item) => item.p95) ?? [webhook, http, providerCreate].find((item) => item.p50);
  return (
    <Kpi label="Processing latency" icon={Timer} value={best?.p95 ? formatPercentile(best.p95) : best?.p50 ? formatPercentile(best.p50) : "—"} hint={best?.p95 ? `P95 of ${formatNumber(best.samples)} requests, ${range}` : `Too few samples for percentiles, ${range}`} source="Measured in this process. Each row: P50 / P95 / P99">
      <div className="space-y-0.5">
        <LatencyLine name="Webhooks" stats={webhook} />
        <LatencyLine name="WizardXray create" stats={providerCreate} />
        <LatencyLine name="HTTP" stats={http} />
      </div>
    </Kpi>
  );
}

/** Every card says its window, its unit and where the number came from. A value too thin to mean anything is shown as a count. */
export const KpiGrid = memo(function KpiGrid({ snapshot, range }: { snapshot: Snapshot; range: RangeName }) {
  const metrics = snapshot.metrics?.[range];
  const label = RANGES.find((item) => item.value === range)?.long ?? range;
  const { orders } = snapshot;
  const cohort = metrics?.orders ?? null;
  const oldest = orders.oldest;
  const unreadOrders = !orders.available;

  if (!metrics) {
    return <p className="rounded-md border border-border bg-card px-3 py-6 text-center text-sm text-muted-foreground">No metrics yet. The first figures appear after the monitor has run.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="kpis">
      <Kpi label="Throughput" icon={Activity} value={formatRate(metrics.throughput.perMinute)} unit="/min" hint={`${formatNumber(metrics.throughput.count)} handled, ${label}`} source={`HTTP ${formatNumber(metrics.throughput.http)}, callbacks ${formatNumber(metrics.throughput.webhooks)}, Telegram ${formatNumber(metrics.throughput.telegramUpdates)}`}>
        <Sparkline values={metrics.throughput.spark} label={`Throughput trend, ${label}`} />
      </Kpi>
      <LatencyCard metrics={metrics} range={label} />
      <Kpi label="Error rate" icon={AlertOctagon} value={metrics.errors.rate == null ? formatNumber(metrics.errors.count) : formatPercent(metrics.errors.rate)} unit={metrics.errors.rate == null ? "errors" : undefined} hint={`${formatNumber(metrics.errors.count)} of ${formatNumber(metrics.errors.attempts)} attempts, ${label}`} source={`5xx answers and failed provider calls. ${formatNumber(metrics.errors.rejectedCallbacks)} rejected callbacks are not errors`} tone={metrics.errors.count ? "warning" : "default"}>
        <Sparkline values={metrics.errors.spark} tone="bad" label={`Error trend, ${label}`} />
      </Kpi>
      <Kpi label="Timeout rate" icon={TimerOff} value={metrics.timeouts.rate == null ? formatNumber(metrics.timeouts.count) : formatPercent(metrics.timeouts.rate)} unit={metrics.timeouts.rate == null ? "timeouts" : undefined} hint={`${formatNumber(metrics.timeouts.count)} of ${formatNumber(metrics.timeouts.attempts)} provider calls, ${label}`} source="Outbound provider clients" tone={metrics.timeouts.count ? "warning" : "default"} />
      <Kpi label="Stalled orders" icon={Hourglass} value={orders.overdueCount == null ? "—" : formatNumber(orders.overdueCount)} hint={unreadOrders ? "Order records could not be read" : `Past their limit, of ${formatNumber(orders.unresolved ?? 0)} unresolved now`} source={`WalletPurchase records${orders.truncated ? ", oldest 50 of each kind" : ""}`} tone={orders.overdueCount ? "destructive" : "default"} href="/reliability/orders" />
      <Kpi label="Fulfilment success" icon={CheckCheck} value={cohort ? (cohort.successRate == null ? `${formatNumber(cohort.delivered)}/${formatNumber(cohort.delivered + cohort.failed)}` : formatPercent(cohort.successRate)) : "—"} hint={cohort ? `${formatNumber(cohort.delivered)} delivered, ${formatNumber(cohort.failed)} failed, ${formatNumber(cohort.inFlight)} running, ${label}` : "Order records could not be read"} source={`Orders that reserved funds${cohort?.truncated ? "; newest 3,000 only" : ""}`} tone={cohort?.failed ? "warning" : "default"} />
      <Kpi label="Oldest unresolved" icon={Clock} value={oldest ? formatDuration(oldest.ageMs) : orders.available ? "None" : "—"} hint={oldest ? ORDER_STATUS_LABEL[oldest.status] ?? oldest.status : orders.available ? "Every order has reached an end state" : "Order records could not be read"} source="Time in its current state" tone={oldest?.overdue ? "destructive" : "default"} href={oldest ? `/reliability/orders/${encodeURIComponent(oldest.orderId)}` : undefined} />
      <Kpi label="Last telemetry" icon={RadioTower} value={snapshot.monitoring.tickMs == null ? "—" : formatDuration(snapshot.monitoring.tickMs)} unit={snapshot.monitoring.tickMs == null ? undefined : "last run"} hint={formatCoverage(metrics.coverage)} source={`Monitor runs every ${snapshot.monitoring.intervalSeconds} s`} tone={snapshot.monitoring.persistence.failures >= 3 ? "warning" : "default"}>
        <p className="text-xs text-muted-foreground">Updated <Age at={snapshot.monitoring.lastTickAt} fallback="never" />, saved <Age at={snapshot.monitoring.persistence.lastSuccessAt} fallback="not yet" /></p>
      </Kpi>
    </div>
  );
});
