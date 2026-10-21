"use client";

import dynamic from "next/dynamic";
import { useRouter, usePathname } from "next/navigation";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { stripBasePath } from "@/lib/basePath";
import type { AnalyticsReport } from "@/lib/types";

export const ANALYTICS_RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "prevMonth", label: "Previous month" },
];

export const AnalyticsChartLazy = dynamic(() => import("@/components/analytics/analytics-chart"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export function RangeSelect({ range }: { range: string }) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  return (
    <Select value={range} onValueChange={(value) => router.push(`${pathname}?range=${value}`)}>
      <SelectTrigger className="w-44" aria-label="Date range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ANALYTICS_RANGES.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Tab switching is the only client behavior; the KPI cards are passed in pre-rendered from the server. */
export function KpiTabs({ panels }: { panels: Record<AnalyticsReport["kpis"][number]["group"], React.ReactNode> }) {
  return (
    <Tabs defaultValue="operational">
      <TabsList>
        <TabsTrigger value="operational">Operational</TabsTrigger>
        <TabsTrigger value="financial">Financial</TabsTrigger>
        <TabsTrigger value="sales">Sales</TabsTrigger>
      </TabsList>
      <TabsContent value="operational">{panels.operational}</TabsContent>
      <TabsContent value="financial">{panels.financial}</TabsContent>
      <TabsContent value="sales">{panels.sales}</TabsContent>
    </Tabs>
  );
}
