import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, CircleCheck, Hourglass, ShieldAlert, Undo2, Wallet } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricCard } from "@/components/dashboard/metric-card";
import { ActivityChartLazy } from "@/components/sentinel/activity-chart-lazy";
import { FindingList } from "@/components/sentinel/finding-list";
import { RangePicker } from "@/components/sentinel/range-picker";
import { SEVERITIES, SEVERITY_LABEL, formatSpan, type SentinelOverview } from "@/lib/sentinel";
import { formatNumber, formatToman } from "@/lib/utils";

const plural = (count: number, noun: string) => `${formatNumber(count)} ${noun}${count === 1 ? "" : "s"}`;

function headline(overview: SentinelOverview) {
  const findings = overview.findings;
  if (!findings) return { tone: "warn", title: "Findings are unavailable right now", detail: "The numbers below may be incomplete." };
  const { confirmed, probable } = findings.byClassification;
  if (confirmed > 0) return { tone: "bad", title: `${formatNumber(confirmed)} confirmed ${confirmed === 1 ? "inconsistency" : "inconsistencies"}`, detail: "The records contradict each other. Each one explains what to check." };
  if (probable > 0) return { tone: "warn", title: `${formatNumber(probable)} ${probable === 1 ? "record needs" : "records need"} a look`, detail: "Probable anomalies: a legitimate explanation is possible." };
  if (overview.sync?.health === "never_run") return { tone: "idle", title: "Waiting for the first check", detail: "Nothing has been reconciled yet." };
  return { tone: "ok", title: "Ledger and records agree", detail: "No confirmed or probable anomaly among the wallets checked so far." };
}

export function OverviewView({ overview }: { overview: SentinelOverview }) {
  const state = headline(overview);
  const findings = overview.findings;
  const activity = overview.activity;
  const exposure = findings?.exposure;
  const severityTotal = findings ? SEVERITIES.reduce((sum, key) => sum + findings.bySeverity[key], 0) : 0;

  return (
    <div className="space-y-4">
      <section className="mf-surface mf-hero" aria-labelledby="mf-state">
        <div className="relative z-10 min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reconciliation health</p>
          <h2 id="mf-state" className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{state.title}</h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">{state.detail}</p>
          <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
            <div>
              <dt className="text-xs text-muted-foreground">Owed to customers</dt>
              <dd className="text-lg font-semibold tabular-nums">{exposure ? formatToman(exposure.owedToCustomers) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Excess in wallets</dt>
              <dd className="text-lg font-semibold tabular-nums">{exposure ? formatToman(exposure.excessInWallets) : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Customers affected</dt>
              <dd className="text-lg font-semibold tabular-nums">{exposure ? formatNumber(exposure.affectedUsers) : "—"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Open findings only. One payment counts once, however many findings describe it.
            {findings?.exposureTruncated ? " Too many findings to total exactly; this is a lower bound." : ""}
          </p>
        </div>
        <div className="mf-vault" data-tone={state.tone} aria-hidden>
          <span className="mf-vault-plate" />
          <span className="mf-vault-plate" />
          <span className="mf-vault-plate" />
          <span className="mf-vault-plate" />
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Financial activity</h2>
        <RangePicker range={overview.range} />
      </div>

      {overview.degraded.length ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
          Some figures could not be loaded ({overview.degraded.join(", ")}). They are shown as blank rather than zero.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Credited to wallets" icon={ArrowDownLeft} value={activity ? formatToman(activity.totals.inflow.amount) : "—"} hint={activity ? plural(activity.totals.inflow.count, "top-up") : undefined} tone="success" />
        <MetricCard label="Consumed by orders" icon={ArrowUpRight} value={activity ? formatToman(activity.totals.consumed.amount) : "—"} hint={activity ? `${formatNumber(activity.totals.consumed.count)} delivered` : undefined} />
        <MetricCard label="Refunded" icon={Undo2} value={activity ? formatToman(activity.totals.refunded.amount) : "—"} hint={activity ? plural(activity.totals.refunded.count, "order") : undefined} />
        <MetricCard label="Held right now" icon={Wallet} value={overview.held ? formatToman(overview.held.amount) : "—"} hint={overview.held ? `${plural(overview.held.count, "order")} in progress` : undefined} tone={overview.held?.count ? "warning" : "default"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-foreground">Money in and out</CardTitle>
            <CardDescription>Wallet credits against money consumed by delivered orders, {overview.timeZone.replace("_", " ")} time.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ActivityChartLazy data={activity?.series ?? []} bucket={overview.bucket} />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-foreground">Open findings</CardTitle>
              <CardDescription>{findings ? `${formatNumber(severityTotal)} open, by severity` : "Unavailable"}</CardDescription>
            </CardHeader>
            <CardContent>
              {severityTotal ? (
                <ul className="space-y-2">
                  {SEVERITIES.filter((key) => findings?.bySeverity[key]).map((key) => (
                    <li key={key}>
                      <Link href={`/sentinel/reconciliation?severity=${key}`} className="flex items-center gap-3 rounded-md text-sm hover:underline">
                        <span className="w-16 shrink-0 text-muted-foreground">{SEVERITY_LABEL[key]}</span>
                        <span className="mf-bar flex-1" data-severity={key} aria-hidden>
                          <span style={{ width: `${Math.max(6, ((findings?.bySeverity[key] ?? 0) / severityTotal) * 100)}%` }} />
                        </span>
                        <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{formatNumber(findings?.bySeverity[key] ?? 0)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><CircleCheck className="h-4 w-4 text-success" aria-hidden />Nothing open.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-foreground">Processing time</CardTitle>
              <CardDescription>Median and 95th percentile in this range</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-muted-foreground"><ShieldAlert className="h-4 w-4" aria-hidden />Confirmation to credit</span>
                <span className="font-semibold tabular-nums">{formatSpan(overview.latency?.credit.p50Ms ?? null)} / {formatSpan(overview.latency?.credit.p95Ms ?? null)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-muted-foreground"><Hourglass className="h-4 w-4" aria-hidden />Reservation to delivery</span>
                <span className="font-semibold tabular-nums">{formatSpan(overview.latency?.fulfilment.p50Ms ?? null)} / {formatSpan(overview.latency?.fulfilment.p95Ms ?? null)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground">Recently detected</CardTitle>
        </CardHeader>
        <CardContent>
          {overview.recentFindings.length ? <FindingList items={overview.recentFindings} /> : <p className="text-sm text-muted-foreground">No open findings.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
