import { adminApiGet } from "@/lib/adminApi.server";
import type { TransactionDetail } from "@/lib/sentinel";
import { TransactionDetailView } from "@/components/sentinel/transaction-detail";

export const dynamic = "force-dynamic";

export default async function SentinelTransactionPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // The segment arrives percent-encoded and the API path needs it encoded once.
  const transaction = await adminApiGet<TransactionDetail>(`/sentinel/transactions/${encodeURIComponent(decodeURIComponent(key))}`);
  return <TransactionDetailView transaction={transaction} />;
}
