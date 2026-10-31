import Link from "next/link";
import { notFound } from "next/navigation";

import { adminApiGet } from "@/lib/adminApi.server";
import { AdminApiError } from "@/lib/types";
import { OrderTraceView } from "@/components/reliability/order-trace";
import type { OrderTrace } from "@/lib/reliability";

export const dynamic = "force-dynamic";

export default async function ReliabilityOrderTracePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trace = await adminApiGet<OrderTrace>(`/reliability/orders/${encodeURIComponent(id)}`).catch((error) => {
    if (error instanceof AdminApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  return (
    <div className="space-y-4">
      <Link href="/reliability/orders" className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">All orders</Link>
      <OrderTraceView trace={trace} />
    </div>
  );
}
