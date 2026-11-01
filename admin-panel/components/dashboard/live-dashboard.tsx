"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock, ShoppingCart, UserCheck, Users, Wallet } from "lucide-react";

import { AnimatedNumber } from "@/components/dashboard/animated-number";
import { MetricCard } from "@/components/dashboard/metric-card";
import { RevenueCard } from "@/components/dashboard/revenue-card";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { ChangeFlash } from "@/components/shared/change-flash";
import { ProgressLink } from "@/components/shared/progress-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { adminGet } from "@/lib/adminApi.client";
import { pulseFreshness, type Freshness } from "@/lib/dashboard-pulse";
import type { DashboardActivity, DashboardPulse, PulseComponentState } from "@/lib/types";
import { cn, formatDateTime, formatNumber, formatToman } from "@/lib/utils";

const POLL_MS = 30_000;

const STATE_DOT: Record<PulseComponentState, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  failed: "bg-destructive",
  stale: "bg-muted-foreground",
  unknown: "bg-muted-foreground",
};
const STATE_VARIANT: Record<PulseComponentState, "success" | "warning" | "destructive" | "outline"> = {
  healthy: "success",
  degraded: "warning",
  failed: "destructive",
  stale: "outline",
  unknown: "outline",
};

function LiveIndicator({ freshness }: { freshness: Freshness }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="dashboard-freshness" data-state={freshness.state}>
      <span aria-hidden="true" className={cn("dash-live-dot", freshness.state === "live" ? "dash-live-dot-on" : freshness.state === "paused" ? "bg-muted-foreground" : "bg-warning")} />
      {freshness.label}
    </p>
  );
}

function HealthStrip({ health }: { health: DashboardPulse["health"] }) {
  const healthy = health.components.filter((item) => item.state === "healthy").length;
  return (
    <Card data-testid="dashboard-health">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle>System status</CardTitle>
          <CardDescription>
            {health.components.length ? `${healthy} of ${health.components.length} checks passing. ${health.reason}` : health.reason}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {health.openIncidents > 0 ? <Badge variant="destructive">{formatNumber(health.openIncidents)} open</Badge> : null}
          <ChangeFlash value={health.state}><Badge variant={STATE_VARIANT[health.state]}>{health.state}</Badge></ChangeFlash>
        </div>
      </CardHeader>
      {health.components.length ? (
        <CardContent>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
            {health.components.map((component) => (
              <li key={component.id} className="flex min-w-0 items-center gap-2 text-sm" title={component.reason}>
                <span aria-hidden="true" className={cn("dash-state-dot", STATE_DOT[component.state])} />
                <span className="truncate">{component.label}</span>
                <span className="sr-only">: {component.state}</span>
              </li>
            ))}
          </ul>
          <ProgressLink href="/reliability" className="mt-3 inline-block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">Open the Service Reliability Center</ProgressLink>
        </CardContent>
      ) : null}
    </Card>
  );
}

function ActivityRow({ item }: { item: DashboardActivity }) {
  return (
    <li className="dash-activity-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-2 text-sm">
      <span className="truncate font-medium">{item.title}</span>
      <span className="text-end">{item.amount != null ? formatToman(item.amount) : "—"}</span>
      <span className="truncate text-xs text-muted-foreground">{item.kind === "order" ? "Order" : "Payment"} · {item.userId} · {formatDateTime(item.at)}</span>
      <span className="justify-self-end"><PaymentStatusBadge status={item.kind === "order" ? item.status.replace(/_/g, " ") : item.status} /></span>
    </li>
  );
}

/**
 * The dashboard, kept current by asking the server. Everything that moves here moves because a value from the server changed:
 * numbers count to the new figure, a changed status flashes once, and a new order slides into the list. Nothing is simulated,
 * and when the data stops being fresh the label says so instead of the page carrying on looking alive.
 */
export function LiveDashboard({ initial }: { initial: DashboardPulse }) {
  const [pulse, setPulse] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(() => Date.parse(initial.generatedAt));
  const inFlight = useRef(false);

  useEffect(() => {
    async function refresh() {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      try {
        setPulse(await adminGet<DashboardPulse>("/dashboard/pulse"));
        setFailed(false);
      } catch {
        // The last figures stay on screen, labelled with their age. A failure must not read as "nothing happened".
        setFailed(true);
      } finally {
        inFlight.current = false;
      }
    }
    const onVisibility = () => {
      setHidden(document.hidden);
      if (!document.hidden) void refresh();
    };
    setHidden(document.hidden);
    setNow(Date.now());
    const poll = setInterval(() => void refresh(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const { metrics } = pulse;
  const freshness = pulseFreshness({ generatedAt: pulse.generatedAt, now, failed, hidden, pollMs: POLL_MS });
  const toman = (value: number) => formatToman(value);
  const count = (value: number) => formatNumber(value);

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><LiveIndicator freshness={freshness} /></div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Total users" value={<ChangeFlash value={metrics.totalUsers}><AnimatedNumber value={metrics.totalUsers} format={count} /></ChangeFlash>} icon={Users} hint={`${formatNumber(metrics.newUsersToday)} new today`} />
        <MetricCard label="Active users (30d)" value={<ChangeFlash value={metrics.activeUsers}><AnimatedNumber value={metrics.activeUsers} format={count} /></ChangeFlash>} icon={UserCheck} />
        <MetricCard label="Revenue this month" value={<ChangeFlash value={metrics.revenue.month}><AnimatedNumber value={metrics.revenue.month} format={toman} /></ChangeFlash>} icon={Wallet} hint={`${formatToman(metrics.revenue.today)} today`} />
        <MetricCard label="Pending payments" value={<ChangeFlash value={metrics.pendingPayments}><AnimatedNumber value={metrics.pendingPayments} format={count} /></ChangeFlash>} icon={Clock} tone={metrics.pendingPayments > 0 ? "warning" : "default"} />
        <MetricCard label="Failed payments" value={<ChangeFlash value={metrics.failedPayments}><AnimatedNumber value={metrics.failedPayments} format={count} /></ChangeFlash>} icon={AlertTriangle} tone={metrics.failedPayments > 0 ? "destructive" : "default"} hint={`${(metrics.failedPaymentRate * 100).toFixed(1)}% of recent activity`} />
        <MetricCard label="Orders this month" value={<ChangeFlash value={metrics.orders.month}><AnimatedNumber value={metrics.orders.month} format={count} /></ChangeFlash>} icon={ShoppingCart} hint={`${formatToman(metrics.averageOrderValueMonth)} average order`} />
      </div>

      <HealthStrip health={pulse.health} />

      <RevenueCard data={pulse.charts.revenue} />

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>The latest payments and orders, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {pulse.activity.length ? (
            <ul className="divide-y divide-border" aria-live="polite" aria-relevant="additions">
              {pulse.activity.map((item) => <ActivityRow key={item.id} item={item} />)}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No transactions yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
