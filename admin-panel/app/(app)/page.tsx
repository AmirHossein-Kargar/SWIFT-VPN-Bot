import { Users, UserCheck, Wallet, Clock, AlertTriangle, ShoppingCart } from "lucide-react";

import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminPayment, DashboardMetrics, PagedResult } from "@/lib/types";
import { MetricCard } from "@/components/dashboard/metric-card";
import { RevenueChart } from "@/components/dashboard/revenue-chart";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatToman, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [dashboard, recentPayments] = await Promise.all([
    adminApiGet<DashboardMetrics>("/dashboard"),
    adminApiGet<PagedResult<AdminPayment>>("/payments", { page: 1, pageSize: 5 }),
  ]);

  const { metrics } = dashboard;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label="Total users" value={formatNumber(metrics.totalUsers)} icon={Users} hint={`${formatNumber(metrics.newUsersToday)} new today`} />
        <MetricCard label="Active users (30d)" value={formatNumber(metrics.activeUsers)} icon={UserCheck} />
        <MetricCard label="Revenue this month" value={formatToman(metrics.revenue.month)} icon={Wallet} hint={`${formatToman(metrics.revenue.today)} today`} />
        <MetricCard
          label="Pending payments"
          value={formatNumber(metrics.pendingPayments)}
          icon={Clock}
          tone={metrics.pendingPayments > 0 ? "warning" : "default"}
        />
        <MetricCard
          label="Failed payments"
          value={formatNumber(metrics.failedPayments)}
          icon={AlertTriangle}
          tone={metrics.failedPayments > 0 ? "destructive" : "default"}
          hint={`${(metrics.failedPaymentRate * 100).toFixed(1)}% of recent activity`}
        />
        <MetricCard label="Orders this month" value={formatNumber(metrics.orders.month)} icon={ShoppingCart} hint={`${formatToman(metrics.averageOrderValueMonth)} average order`} />
      </div>

      <RevenueChart data={dashboard.charts.revenue} />

      <Card>
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
          <CardDescription>The five most recent payments and top-ups across all providers.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentPayments.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    No transactions yet.
                  </TableCell>
                </TableRow>
              ) : (
                recentPayments.items.map((payment) => (
                  <TableRow key={payment.key}>
                    <TableCell>{payment.providerLabel}</TableCell>
                    <TableCell>{payment.userId}</TableCell>
                    <TableCell>{formatToman(payment.amount)}</TableCell>
                    <TableCell>
                      <PaymentStatusBadge status={payment.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(payment.createdAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
