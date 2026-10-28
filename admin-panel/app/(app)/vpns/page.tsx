import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminVpn, PagedResult } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { VpnsFilters } from "@/components/vpns/vpns-filters";
import { VpnsTable } from "@/components/vpns/vpns-table";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
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
      <nav aria-label="VPN sections" className="flex gap-2">
        <Link href="/vpns" aria-current="page" className={buttonVariants({ variant: "default", size: "sm" })}>Local services</Link>
        <Link href="/vpns/remote" className={buttonVariants({ variant: "outline", size: "sm" })}>Remote clients</Link>
        <Link href="/products" className={buttonVariants({ variant: "outline", size: "sm" })}>Service catalog</Link>
      </nav>
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
