import { adminApiGet } from "@/lib/adminApi.server";
import type { History } from "@/lib/reliability";
import { HistoryView } from "@/components/reliability/history-view";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ReliabilityHistoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const range = typeof params.range === "string" ? params.range : "1h";
  const history = await adminApiGet<History>("/reliability/history", { range });
  return <HistoryView key={history.range} initial={history} />;
}
