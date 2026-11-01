import { adminApiGet } from "@/lib/adminApi.server";
import type { DashboardPulse } from "@/lib/types";
import { LiveDashboard } from "@/components/dashboard/live-dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  return <LiveDashboard initial={await adminApiGet<DashboardPulse>("/dashboard/pulse")} />;
}
