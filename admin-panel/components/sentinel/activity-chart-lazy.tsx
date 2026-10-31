"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

// recharts is the panel's largest client dependency: it loads after the numbers, never in the route's first bundle.
const ActivityChart = dynamic(() => import("@/components/sentinel/activity-chart"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export function ActivityChartLazy(props: { data: { t: string; inflow: number; consumed: number }[]; bucket: "hour" | "day" }) {
  return <ActivityChart {...props} />;
}
