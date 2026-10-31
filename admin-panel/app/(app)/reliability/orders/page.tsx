import { Route } from "lucide-react";

import { adminApiGet } from "@/lib/adminApi.server";
import type { OrderList } from "@/lib/reliability";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { OrderRows } from "@/components/reliability/order-rows";
import { OrderSearch } from "@/components/reliability/order-search";
import { formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function ReliabilityOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const userId = first(params.userId);
  const result = await adminApiGet<OrderList>("/reliability/orders", { userId });
  const overdue = result.rows.filter((row) => row.overdue).length;

  return (
    <div className="space-y-4">
      <OrderSearch userId={userId} />
      <p className="text-sm text-muted-foreground">
        {result.scope === "customer"
          ? `${formatNumber(result.rows.length)} recent ${result.rows.length === 1 ? "order" : "orders"} for this customer.`
          : `${formatNumber(result.rows.length)} unresolved ${result.rows.length === 1 ? "order" : "orders"}, ${formatNumber(overdue)} past the limit for their state. Oldest first${result.truncated ? "; only the oldest 50 of each kind are shown" : ""}.`}
      </p>
      <Card>
        <CardContent className="px-3 pb-3 pt-3">
          {result.rows.length ? <OrderRows rows={result.rows} /> : <EmptyState icon={Route} title={result.scope === "customer" ? "No orders found" : "No unresolved orders"} hint={result.scope === "customer" ? "This customer has no orders." : "Every order has reached an end state. Enter an order id to trace a finished one."} />}
        </CardContent>
      </Card>
    </div>
  );
}
