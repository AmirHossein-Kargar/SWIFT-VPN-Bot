import { adminApiGet } from "@/lib/adminApi.server";
import type { AuditLogPage } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { PaginationNav } from "@/components/shared/pagination-nav";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const action = first(params.action);
  const actor = first(params.actor);
  const target = first(params.target);
  const page = Number(first(params.page)) || 1;
  const pageSize = 25;

  const result = await adminApiGet<AuditLogPage>("/audit", { action, actor, target, page, pageSize });
  const pages = Math.max(1, Math.ceil(result.total / pageSize));

  return (
    <div className="space-y-4">
      <AuditFilters defaultAction={action} defaultActor={actor} defaultTarget={target} />
      <Card>
        <CardContent className="p-0">
          <AuditTable items={result.items} />
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={pages} />
    </div>
  );
}
