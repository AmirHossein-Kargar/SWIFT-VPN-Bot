"use client";

import { useRouter, usePathname } from "next/navigation";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Download } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { stripBasePath } from "@/lib/basePath";
import type { AnalyticsKpi, AnalyticsReport } from "@/lib/types";
import { formatDate, formatNumber, formatToman } from "@/lib/utils";

const RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "prevMonth", label: "Previous month" },
];

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

function KpiCard({ kpi }: { kpi: AnalyticsKpi }) {
  const trend = kpi.change.state;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{KPI_LABEL[kpi.id] ?? kpi.id}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{formatKpiValue(kpi)}</p>
        {trend !== "unavailable" ? (
          <p className={`mt-1 text-xs ${trend === "up" ? "text-success" : trend === "down" ? "text-destructive" : "text-muted-foreground"}`}>
            {kpi.change.pct != null ? `${kpi.change.pct > 0 ? "+" : ""}${Math.round(kpi.change.pct * 100)}%` : "flat"} vs previous period
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">No comparable baseline</p>
        )}
      </CardContent>
    </Card>
  );
}

export function AnalyticsView({ report, range }: { report: AnalyticsReport; range: string }) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());

  function setRange(value: string) {
    router.push(`${pathname}?range=${value}`);
  }

  const groups: Record<AnalyticsKpi["group"], AnalyticsKpi[]> = { operational: [], financial: [], sales: [] };
  for (const kpi of report.kpis) groups[kpi.group].push(kpi);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Analytics</CardTitle>
            <CardDescription>{formatDate(report.range.from)} – {formatDate(report.range.to)} · Asia/Tehran</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={range} onValueChange={setRange}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/admin/analytics/export.csv?range=${range}`}>
                <Download className="h-4 w-4" />
                Export CSV
              </a>
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Tabs defaultValue="operational">
        <TabsList>
          <TabsTrigger value="operational">Operational</TabsTrigger>
          <TabsTrigger value="financial">Financial</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
        </TabsList>
        {(["operational", "financial", "sales"] as const).map((group) => (
          <TabsContent key={group} value={group}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {groups[group].map((kpi) => (
                <KpiCard key={kpi.id} kpi={kpi} />
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>Top-ups &amp; sales over time</CardTitle>
          <CardDescription>Wallet top-ups credited vs. service purchases completed, per {report.granularity.label}.</CardDescription>
        </CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={report.series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="topupsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(0 0% 9%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(0 0% 9%)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(0 0% 55%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(0 0% 55%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="hsl(0 0% 89%)" />
              <XAxis
                dataKey="start"
                tickFormatter={(value) => formatDate(value)}
                tick={{ fill: "hsl(0 0% 45%)", fontSize: 11 }}
                axisLine={{ stroke: "hsl(0 0% 89%)" }}
                tickLine={false}
                minTickGap={32}
              />
              <Tooltip
                contentStyle={{ background: "hsl(0 0% 100%)", border: "1px solid hsl(0 0% 89%)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "hsl(0 0% 45%)" }}
                itemStyle={{ color: "hsl(0 0% 9%)" }}
                formatter={(value: number, name: string) => [formatToman(value), name === "topups" ? "Top-ups" : "Sales"]}
                labelFormatter={(value) => formatDate(value)}
              />
              <Area type="monotone" dataKey="topups" stroke="hsl(0 0% 9%)" strokeWidth={2} fill="url(#topupsFill)" />
              <Area type="monotone" dataKey="sales" stroke="hsl(0 0% 55%)" strokeWidth={2} fill="url(#salesFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top-ups by provider</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.distributions.providers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No top-ups in this period.</TableCell>
                  </TableRow>
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
          <CardHeader>
            <CardTitle>Top plans</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Purchases</TableHead>
                  <TableHead>Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.distributions.plans.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No completed purchases in this period.</TableCell>
                  </TableRow>
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
    </div>
  );
}
