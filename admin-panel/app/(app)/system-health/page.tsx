import { adminApiGet } from "@/lib/adminApi.server";
import type { SystemHealth } from "@/lib/types";
import { HealthOverview } from "@/components/system-health/health-overview";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SystemHealthPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const fresh = params.fresh === "1";
  const health = await adminApiGet<SystemHealth>("/system/health", fresh ? { fresh: "1" } : undefined);

  return <HealthOverview health={health} />;
}
