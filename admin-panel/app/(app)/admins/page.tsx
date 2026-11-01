import { CircleCheck, Radio, ShieldBan, UserMinus } from "lucide-react";

import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminDirectoryData } from "@/lib/admin-directory";
import { formatNumber } from "@/lib/utils";
import { AdminDirectory } from "@/components/admins/admin-directory";
import { AdminFilters } from "@/components/admins/admin-filters";
import { MetricCard } from "@/components/dashboard/metric-card";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function AdminsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const search = first(params.search);
  const role = first(params.role) || "all";
  const status = first(params.status) || "all";

  const directory = await adminApiGet<AdminDirectoryData>("/admins/directory", { search, role, status });
  const { summary, presence } = directory;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Current admins" value={formatNumber(summary.active)} icon={CircleCheck} hint={`${formatNumber(summary.total)} on record`} tone="success" />
        <MetricCard label="Online now" value={summary.online === null ? "Unknown" : formatNumber(summary.online)} icon={Radio} hint={`Panel, last ${Math.round(presence.windowSeconds / 60)} min`} />
        <MetricCard label="Blocked in bot" value={formatNumber(summary.blocked)} icon={ShieldBan} hint="Flag on the bot account" tone={summary.blocked > 0 ? "warning" : "default"} />
        <MetricCard label="Removed" value={formatNumber(summary.removed)} icon={UserMinus} hint="No longer have access" />
      </div>

      <AdminDirectory directory={directory} filters={<AdminFilters defaultSearch={search} role={role} status={status} />} />
    </div>
  );
}
