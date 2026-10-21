"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

// recharts is the largest client dependency in the panel; load it after the
// KPI cards and tables instead of in the route's initial bundle.
const RevenueChart = dynamic(() => import("@/components/dashboard/revenue-chart"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export function RevenueChartLazy({ data }: { data: { date: string; value: number }[] }) {
  return <RevenueChart data={data} />;
}
