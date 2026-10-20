import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminUser, PagedResult } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { UsersFilters } from "@/components/users/users-filters";
import { UsersTable } from "@/components/users/users-table";
import { PaginationNav } from "@/components/shared/pagination-nav";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const search = first(params.search);
  const activity = first(params.activity) || "all";
  const paying = first(params.paying) || "all";
  const blocked = first(params.blocked) || "all";
  const sort = first(params.sort) || "registered";
  const page = Number(first(params.page)) || 1;

  const result = await adminApiGet<PagedResult<AdminUser>>("/users", { search, activity, paying, blocked, sort, page, pageSize: 25 });

  return (
    <div className="space-y-4">
      <UsersFilters defaultSearch={search} activity={activity} paying={paying} blocked={blocked} sort={sort} />
      <Card>
        <CardContent className="p-0">
          <UsersTable items={result.items} />
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={result.pages} />
    </div>
  );
}
