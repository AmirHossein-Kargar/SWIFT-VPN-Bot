import { adminApiGet } from "@/lib/adminApi.server";
import type { FindingDetail } from "@/lib/sentinel";
import { FindingDetailView } from "@/components/sentinel/finding-detail";

export const dynamic = "force-dynamic";

export default async function SentinelFindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const finding = await adminApiGet<FindingDetail>(`/sentinel/findings/${encodeURIComponent(id)}`);
  return <FindingDetailView finding={finding} />;
}
