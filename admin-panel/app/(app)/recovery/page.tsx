import { adminApiGet } from "@/lib/adminApi.server";
import type { RecoveryQueue } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecoveryTable } from "@/components/recovery/recovery-table";
import { PaginationNav } from "@/components/shared/pagination-nav";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function RecoveryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const page = Number(first(params.page)) || 1;

  const result = await adminApiGet<RecoveryQueue>("/recovery", { page, pageSize: 25 });
  const counts = Object.entries(result.counts);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Recovery queue</CardTitle>
          <CardDescription>
            Payments and provisioning steps that need a human look: paid-but-unfulfilled invoices, stalled provisioning, and refunds pending reconciliation.
          </CardDescription>
        </CardHeader>
        {counts.length > 0 ? (
          <CardContent className="flex flex-wrap gap-2 pt-0">
            {counts.map(([kind, count]) => (
              <Badge key={kind} variant="outline">
                {kind.replace(/-/g, " ")}: {count}
              </Badge>
            ))}
          </CardContent>
        ) : null}
      </Card>
      <Card>
        <CardContent className="p-0">
          <RecoveryTable items={result.items} />
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={result.pages} />
    </div>
  );
}
