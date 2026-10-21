import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { RevenueChartLazy } from "@/components/dashboard/revenue-chart-lazy";

export function RevenueCard({ data }: { data: { date: string; value: number }[] }) {
  const hasRevenue = data.some((point) => point.value > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue, last 30 days</CardTitle>
        <CardDescription>Wallet top-ups actually credited to user wallets.</CardDescription>
      </CardHeader>
      <CardContent className="h-64">
        {hasRevenue ? (
          <RevenueChartLazy data={data} />
        ) : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            No credited top-ups in the last 30 days.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
