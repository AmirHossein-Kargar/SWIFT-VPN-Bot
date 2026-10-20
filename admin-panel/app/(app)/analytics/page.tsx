import { adminApiGet } from "@/lib/adminApi.server";
import type { AnalyticsReport } from "@/lib/types";
import { AnalyticsView } from "@/components/analytics/analytics-view";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const range = first(params.range) || "30d";

  const report = await adminApiGet<AnalyticsReport>("/analytics/report", { range });

  return <AnalyticsView report={report} range={range} />;
}
