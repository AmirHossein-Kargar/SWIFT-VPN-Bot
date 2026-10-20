import { adminApiGet } from "@/lib/adminApi.server";
import type { MockTestRunReport } from "@/lib/types";
import { MockTestsPanel } from "@/components/mock-tests/mock-tests-panel";

export const dynamic = "force-dynamic";

export default async function MockTestsPage() {
  const runs = await adminApiGet<MockTestRunReport[]>("/mock-tests", { limit: 20 });
  return <MockTestsPanel initialRuns={runs} />;
}
