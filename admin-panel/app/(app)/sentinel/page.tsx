import { adminApiGet } from "@/lib/adminApi.server";
import type { SentinelOverview } from "@/lib/sentinel";
import { OverviewView } from "@/components/sentinel/overview-view";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SentinelOverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const range = typeof params.range === "string" ? params.range : "7d";
  const overview = await adminApiGet<SentinelOverview>("/sentinel/overview", { range });
  return <OverviewView overview={overview} />;
}
