import { adminApiGet } from "@/lib/adminApi.server";
import type { BroadcastSummary, PagedResult } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BroadcastComposer } from "@/components/broadcasts/broadcast-composer";
import { BroadcastsHistoryTable } from "@/components/broadcasts/broadcasts-history-table";

export const dynamic = "force-dynamic";

export default async function BroadcastsPage() {
  const history = await adminApiGet<PagedResult<BroadcastSummary>>("/broadcasts", { page: 1, pageSize: 10 });

  return (
    <div className="space-y-4">
      <BroadcastComposer />
      <Card>
        <CardHeader>
          <CardTitle>Recent broadcasts</CardTitle>
          <CardDescription>The 10 most recent sends.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <BroadcastsHistoryTable items={history.items} />
        </CardContent>
      </Card>
    </div>
  );
}
