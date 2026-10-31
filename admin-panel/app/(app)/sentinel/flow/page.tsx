import { adminApiGet } from "@/lib/adminApi.server";
import type { LiveFeed, SentinelFlow } from "@/lib/sentinel";
import { LiveFlowView } from "@/components/sentinel/live-flow-view";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function SentinelFlowPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const range = first(params.range) || "24h";
  const filters = { provider: first(params.provider) || "all", stage: "", minAmount: first(params.minAmount), maxAmount: first(params.maxAmount), userId: first(params.userId) };
  const [flow, feed] = await Promise.all([
    adminApiGet<SentinelFlow>("/sentinel/flow", { range, provider: filters.provider }),
    adminApiGet<LiveFeed>("/sentinel/live", { provider: filters.provider, minAmount: filters.minAmount, maxAmount: filters.maxAmount, userId: filters.userId, limit: 100 }),
  ]);
  return <LiveFlowView key={JSON.stringify(filters)} flow={flow} feed={feed} range={range} filters={filters} />;
}
