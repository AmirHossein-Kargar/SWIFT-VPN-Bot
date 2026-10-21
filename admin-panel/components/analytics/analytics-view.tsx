import { Download } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { AnalyticsChartLazy, KpiTabs, RangeSelect } from "@/components/analytics/analytics-islands";
import type { AnalyticsKpi, AnalyticsReport } from "@/lib/types";
import { formatDate, formatNumber, formatToman } from "@/lib/utils";

const KPI_LABEL: Record<string, string> = {
  users_total: "Total users",
  users_new: "New users",
  users_active: "Active users",
  services_active: "Active services",
  services_activated: "Services activated",
  services_expiring_7d: "Expiring within 7 days",
  payment_attempts: "Payment attempts",
  payments_successful: "Successful payments",
  payment_success_rate: "Success rate",
  payments_failed: "Failed payments",
  payments_cancelled: "Cancelled payments",
  payments_review: "Needs review",
  buyers_unique: "Unique buyers",
  buyer_retention: "Buyer retention",
  topups_gross: "Gross top-ups",
  topups_count: "Top-up count",
  topups_average: "Average top-up",
  refunds_reversals: "Refunds / reversals",
  refunds_reversals_count: "Refund count",
  topups_net: "Net top-ups",
  wallet_balance_total: "Total wallet balance",
  sales_gross: "Gross sales",
  sales_refunded: "Refunded sales",
  sales_net: "Net sales",
  sales_average_order: "Average order value",
};

function formatKpiValue(kpi: AnalyticsKpi): string {
  if (kpi.value == null) return "—";
  if (kpi.unit === "toman") return formatToman(kpi.value);
  if (kpi.unit === "ratio") return `${Math.round(kpi.value * 100)}%`;
  return formatNumber(kpi.value);
}

function KpiCard({ kpi, definition }: { kpi: AnalyticsKpi; definition?: string }) {
  const trend = kpi.change.state;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle title={definition}>{KPI_LABEL[kpi.id] ?? kpi.id}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{formatKpiValue(kpi)}</p>
        {trend !== "unavailable" ? (
          <p className={`mt-1 text-xs ${trend === "up" ? "text-success" : trend === "down" ? "text-destructive" : "text-muted-foreground"}`}>
            {kpi.change.pct != null ? `${kpi.change.pct > 0 ? "+" : ""}${Math.round(kpi.change.pct * 100)}%` : "No change"} vs previous period
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No comparable baseline</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AnalyticsView({ report, range }: { report: AnalyticsReport; range: string }) {
  const groups: Record<AnalyticsKpi["group"], AnalyticsKpi[]> = { operational: [], financial: [], sales: [] };
  for (const kpi of report.kpis) groups[kpi.group].push(kpi);
  const panel = (group: AnalyticsKpi["group"]) => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups[group].map((kpi) => <KpiCard key={kpi.id} kpi={kpi} definition={report.definitions[kpi.id]} />)}
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Analytics</CardTitle>
            <CardDescription>{formatDate(report.range.from)} – {formatDate(report.range.to)} · Asia/Tehran</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <RangeSelect range={range} />
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/admin/analytics/export.csv?range=${encodeURIComponent(range)}`}>
                <Download className="h-4 w-4" />
                Export CSV
              </a>
            </Button>
          </div>
        </CardHeader>
      </Card>

      <KpiTabs panels={{ operational: panel("operational"), financial: panel("financial"), sales: panel("sales") }} />

      <Card>
        <CardHeader>
          <CardTitle>Top-ups &amp; sales over time</CardTitle>
          <CardDescription>Wallet top-ups credited vs. service purchases completed, per {report.granularity.label}.</CardDescription>
        </CardHeader>
        <CardContent className="h-64">
          <AnalyticsChartLazy series={report.series} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Top-ups by provider</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Provider</TableHead><TableHead>Amount</TableHead><TableHead>Count</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {report.distributions.providers.length === 0 ? (
                  <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No top-ups in this period.</TableCell></TableRow>
                ) : (
                  report.distributions.providers.map((p) => (
                    <TableRow key={p.provider}>
                      <TableCell className="font-medium">{p.provider}</TableCell>
                      <TableCell>{formatToman(p.amount)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatNumber(p.count)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Top plans</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Plan</TableHead><TableHead>Purchases</TableHead><TableHead>Revenue</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {report.distributions.plans.length === 0 ? (
                  <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No completed purchases in this period.</TableCell></TableRow>
                ) : (
                  report.distributions.plans.map((plan) => (
                    <TableRow key={plan.planId}>
                      <TableCell className="font-medium">{plan.name}</TableCell>
                      <TableCell className="text-muted-foreground">{formatNumber(plan.count)}</TableCell>
                      <TableCell>{formatToman(plan.amount)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {report.unavailable.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Not measurable from stored data</CardTitle>
            <CardDescription>These metrics are deliberately not shown rather than estimated.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {report.unavailable.map((item) => <li key={item.id}>{item.reason}</li>)}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
