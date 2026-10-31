import Link from "next/link";
import { notFound } from "next/navigation";

import { adminApiGet } from "@/lib/adminApi.server";
import { AdminApiError } from "@/lib/types";
import { IncidentView } from "@/components/reliability/incident-view";
import type { IncidentDetail, Snapshot } from "@/lib/reliability";

export const dynamic = "force-dynamic";

export default async function ReliabilityIncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incident = await adminApiGet<IncidentDetail>(`/reliability/incidents/${encodeURIComponent(id)}`).catch((error) => {
    if (error instanceof AdminApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const snapshot = await adminApiGet<Snapshot>("/reliability/snapshot").catch(() => null);
  const labels = Object.fromEntries((snapshot?.components ?? []).map((item) => [item.id, item.label]));
  return (
    <div className="space-y-4">
      <Link href="/reliability/incidents" className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">All incidents</Link>
      <IncidentView incident={incident} labels={labels} />
    </div>
  );
}
