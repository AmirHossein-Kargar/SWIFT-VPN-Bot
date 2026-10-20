import { adminApiGet } from "@/lib/adminApi.server";
import type { CustodyLocalInvoice, CustodyOverview, PagedResult } from "@/lib/types";
import { CustodyView } from "@/components/custody/custody-view";

export const dynamic = "force-dynamic";

export default async function CustodyPage() {
  const [overview, transactions] = await Promise.all([
    adminApiGet<CustodyOverview>("/custody/overview"),
    adminApiGet<PagedResult<CustodyLocalInvoice>>("/custody/transactions", { page: 1, pageSize: 15 }),
  ]);

  return <CustodyView overview={overview} transactions={transactions.items} />;
}
