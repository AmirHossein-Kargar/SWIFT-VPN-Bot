import { ProgressLink } from "@/components/shared/progress-link";

import { adminApiGet } from "@/lib/adminApi.server";
import { AdminApiError } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface RemoteClients {
  source: string;
  fetchedAt: string;
  count: number;
  items: ({ username?: string; knownLocally: boolean } & Record<string, string | number | boolean | undefined>)[];
}

// The provider payload shape is not fixed, so only a few well-known columns are
// promoted; everything else the API already deemed safe is shown as key/value.
const PRIMARY = ["username", "status", "traffic", "usage", "expire", "expires_at", "days"];

export default async function RemoteClientsPage() {
  let data: RemoteClients | null = null;
  let failure: string | null = null;
  try {
    data = await adminApiGet<RemoteClients>("/vpns-remote/clients", { limit: 200 });
  } catch (error) {
    failure = error instanceof AdminApiError ? error.message : "The provider could not be reached.";
  }

  return (
    <div className="space-y-4">
      <nav aria-label="VPN sections" className="flex gap-2">
        <ProgressLink href="/vpns" className={buttonVariants({ variant: "outline", size: "sm" })}>Local services</ProgressLink>
        <ProgressLink href="/vpns/remote" aria-current="page" className={buttonVariants({ variant: "default", size: "sm" })}>Remote clients</ProgressLink>
        <ProgressLink href="/products" className={buttonVariants({ variant: "outline", size: "sm" })}>Service catalog</ProgressLink>
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>Remote clients (WizardXray)</CardTitle>
          <CardDescription>
            Live provider data, read-only. Fetched {data ? formatDateTime(data.fetchedAt) : "—"}; it is a snapshot and can be out of date
            the moment it loads. Manage a service from the Local services tab, which audits every action.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {failure ? (
            <div className="space-y-2 p-4 text-sm" role="alert">
              <p className="text-destructive">{failure}</p>
              <p className="text-muted-foreground">Nothing is shown rather than showing possibly stale provider state. Reload to retry.</p>
            </div>
          ) : !data?.items.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">The provider returned no clients.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Client</TableHead><TableHead>Local account</TableHead><TableHead>Details</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((row, index) => (
                  <TableRow key={`${row.username ?? "client"}-${index}`}>
                    <TableCell className="break-all font-mono text-xs">{row.username ?? "—"}</TableCell>
                    <TableCell>{row.knownLocally ? <Badge variant="success">linked</Badge> : <Badge variant="warning">not in bot database</Badge>}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {Object.entries(row)
                        .filter(([key]) => key !== "username" && key !== "knownLocally")
                        .sort(([a], [b]) => Number(PRIMARY.includes(b)) - Number(PRIMARY.includes(a)))
                        .slice(0, 8)
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(" · ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
