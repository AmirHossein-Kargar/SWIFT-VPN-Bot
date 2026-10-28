import Link from "next/link";

import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminProductPage } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PaginationNav } from "@/components/shared/pagination-nav";
import { ProductsFilters } from "@/components/products/products-filters";
import { ProductsTable } from "@/components/products/products-table";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filters = {
    search: first(params.search),
    status: first(params.status) || "current",
    duration: first(params.duration) || "all",
    sort: first(params.sort) || "order",
    order: first(params.order) === "desc" ? "desc" : "asc",
  };
  const page = Number(first(params.page)) || 1;

  let result: AdminProductPage | null = null;
  let failure: string | null = null;
  try {
    result = await adminApiGet<AdminProductPage>("/products", {
      ...filters,
      duration: filters.duration === "all" ? undefined : filters.duration,
      page,
      pageSize: 20,
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : "The catalog could not be loaded.";
  }

  return (
    <div className="space-y-4">
      <nav aria-label="VPN sections" className="flex gap-2">
        <Link href="/vpns" className={buttonVariants({ variant: "outline", size: "sm" })}>Local services</Link>
        <Link href="/vpns/remote" className={buttonVariants({ variant: "outline", size: "sm" })}>Remote clients</Link>
        <Link href="/products" aria-current="page" className={buttonVariants({ variant: "default", size: "sm" })}>Service catalog</Link>
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>Service catalog</CardTitle>
          <CardDescription>
            The plans customers can buy in the Telegram bot and on the storefront. Changes apply to new purchases only; existing orders and
            active VPN services keep the terms they were sold with.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProductsFilters {...filters} />
          {result ? (
            <>
              <ProductsTable items={result.items} total={result.total} filteredTotal={result.filteredTotal} sort={filters.sort} order={filters.order} status={filters.status} />
              <PaginationNav page={result.page} pages={result.pages} />
            </>
          ) : (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
              <p className="font-medium">Could not load the service catalog.</p>
              <p className="mt-1 text-muted-foreground">{failure}</p>
              <Link href="/products" className={buttonVariants({ variant: "outline", size: "sm", className: "mt-3" })}>Try again</Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
