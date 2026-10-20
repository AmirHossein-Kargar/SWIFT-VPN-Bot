import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminPayment, PagedResult } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { PaymentsFilters } from "@/components/payments/payments-filters";
import { PaymentsTable } from "@/components/payments/payments-table";
import { PaginationNav } from "@/components/shared/pagination-nav";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const search = first(params.search);
  const status = first(params.status) || "all";
  const provider = first(params.provider) || "all";
  const page = Number(first(params.page)) || 1;

  const result = await adminApiGet<PagedResult<AdminPayment>>("/payments", { search, status, provider, page, pageSize: 25 });

  return (
    <div className="space-y-4">
      <PaymentsFilters defaultSearch={search} status={status} provider={provider} />
      <Card>
        <CardContent className="p-0">
          <PaymentsTable items={result.items} />
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={result.pages} />
    </div>
  );
}
