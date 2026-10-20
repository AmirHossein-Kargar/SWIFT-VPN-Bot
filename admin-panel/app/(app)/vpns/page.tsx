import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminVpn, PagedResult } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { VpnsFilters } from "@/components/vpns/vpns-filters";
import { VpnsTable } from "@/components/vpns/vpns-table";
import { PaginationNav } from "@/components/shared/pagination-nav";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function VpnsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const search = first(params.search);
  const status = first(params.status) || "all";
  const page = Number(first(params.page)) || 1;

  const result = await adminApiGet<PagedResult<AdminVpn>>("/vpns", { search, status, page, pageSize: 25 });

  return (
    <div className="space-y-4">
      <VpnsFilters defaultSearch={search} status={status} />
      <Card>
        <CardContent className="p-0">
          <VpnsTable items={result.items} />
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={result.pages} />
    </div>
  );
}
