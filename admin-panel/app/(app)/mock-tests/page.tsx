import type { Metadata } from "next";

import { adminApiGet } from "@/lib/adminApi.server";
import type { MockTestsListing } from "@/lib/types";
import { MockTestsPanel } from "@/components/mock-tests/mock-tests-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Mock tests" };

export default async function MockTestsPage() {
  // The endpoint returns a listing object ({ enabled, running, scenarios, items }),
  // not a bare array — passing it straight to the run table crashed the page.
  const listing = await adminApiGet<MockTestsListing>("/mock-tests", { limit: 20 });
  return <MockTestsPanel listing={listing} />;
}
