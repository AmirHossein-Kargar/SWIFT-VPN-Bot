import { adminApiGet } from "@/lib/adminApi.server";
import type { AdminAccountRow } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AdminsTable } from "@/components/admins/admins-table";

export const dynamic = "force-dynamic";

export default async function AdminsPage() {
  const admins = await adminApiGet<AdminAccountRow[]>("/admins");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Admins</CardTitle>
          <CardDescription>
            Environment admins come from the <code className="rounded bg-muted px-1 py-0.5 text-xs">ADMINS</code> variable and cannot be removed here.
            Only the primary owner can add or remove database-backed admins.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <AdminsTable items={admins} />
        </CardContent>
      </Card>
    </div>
  );
}
