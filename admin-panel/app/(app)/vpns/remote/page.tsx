import { ProgressLink } from "@/components/shared/progress-link";
import { PaginationNav } from "@/components/shared/pagination-nav";

import { adminApiGet } from "@/lib/adminApi.server";
import { AdminApiError, type ProviderOverview, type RemoteClients } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime, formatNumber, formatToman } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "outline"> = {
  active: "success",
  on_hold: "outline",
  disabled: "warning",
  limited: "destructive",
  expired: "destructive",
};

function ProviderAccountCard({ overview }: { overview: ProviderOverview | null }) {
  const account = overview?.account ?? null;
  if (!account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provider account</CardTitle>
          <CardDescription>WizardXray did not answer, so nothing is shown rather than an old figure.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const locations = overview?.hosts ?? null;
  const enabled = locations?.filter((host) => !host.disabled) ?? [];
  const facts: [string, string][] = [
    ["Balance", account.balance != null ? formatToman(account.balance) : "—"],
    ["Per GB", formatToman(account.prices.perGb)],
    ["Per day", formatToman(account.prices.perDay)],
    ["Unlimited per day", account.limits.unlimitedEnabled ? formatToman(account.prices.unlimitedPerDay) : "Off for this account"],
    ["Test service", account.limits.testEnabled ? `${formatNumber(account.limits.testsUsed ?? 0)} of ${formatNumber(account.limits.maxTests ?? 0)} used` : "Off for this account"],
    ["Services", `${formatNumber(account.services.active ?? 0)} active of ${formatNumber(account.services.total ?? 0)}`],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider account</CardTitle>
        <CardDescription>Read from WizardXray {overview ? formatDateTime(overview.fetchedAt) : ""}. Prices{account.prices.custom ? " are custom to this account and" : ""} apply to what the provider charges this bot, not to what customers pay.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="text-sm">
          <p className="text-muted-foreground">Locations in every subscription link</p>
          {locations === null ? (
            <p>Could not be read.</p>
          ) : enabled.length ? (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {enabled.map((host, index) => <li key={`${host.inbound}-${index}`}><Badge variant="outline">{host.remark ?? host.inbound}</Badge></li>)}
            </ul>
          ) : (
            <p className="text-warning">WizardXray lists no enabled location.</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function traffic(row: RemoteClients["items"][number]): string {
  if (row.unlimited) return row.usedGb != null ? `${formatNumber(row.usedGb)} GB used · Unlimited` : "Unlimited";
  if (row.trafficGb == null) return "—";
  return `${row.usedGb != null ? `${formatNumber(row.usedGb)} / ` : ""}${formatNumber(row.trafficGb)} GB`;
}

export default async function RemoteClientsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  let data: RemoteClients | null = null;
  let failure: string | null = null;
  const [overview] = await Promise.all([
    adminApiGet<ProviderOverview>("/provider/account").catch(() => null),
    adminApiGet<RemoteClients>("/vpns-remote/clients", { page: page ?? 1, pageSize: 50 }).then(
      (value) => { data = value; },
      (error) => { failure = error instanceof AdminApiError ? error.message : "The provider could not be reached."; },
    ),
  ]);
  const clients = data as RemoteClients | null;

  return (
    <div className="space-y-4">
      <nav aria-label="VPN sections" className="flex gap-2">
        <ProgressLink href="/vpns" className={buttonVariants({ variant: "outline", size: "sm" })}>Local services</ProgressLink>
        <ProgressLink href="/vpns/remote" aria-current="page" className={buttonVariants({ variant: "default", size: "sm" })}>Remote clients</ProgressLink>
        <ProgressLink href="/products" className={buttonVariants({ variant: "outline", size: "sm" })}>Service catalog</ProgressLink>
      </nav>
      <ProviderAccountCard overview={overview} />
      <Card>
        <CardHeader>
          <CardTitle>Remote clients (WizardXray)</CardTitle>
          <CardDescription>
            Read-only, nearest expiry first{clients?.total != null ? `, ${formatNumber(clients.total)} in all` : ""}. Fetched {clients ? formatDateTime(clients.fetchedAt) : "—"}. This is the provider&apos;s stored
            copy, so usage can be minutes old; open a service from Local services for its live state and to act on it.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {failure ? (
            <div className="space-y-2 p-4 text-sm" role="alert">
              <p className="text-destructive">{failure}</p>
              <p className="text-muted-foreground">Nothing is shown rather than showing possibly stale provider state. Reload to retry.</p>
            </div>
          ) : !clients?.items.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">The provider returned no clients.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Client</TableHead><TableHead>Status</TableHead><TableHead>Traffic</TableHead><TableHead>Expires</TableHead><TableHead>Local account</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {clients.items.map((row, index) => (
                  <TableRow key={`${row.username ?? "client"}-${index}`}>
                    <TableCell className="break-all font-mono text-xs">{row.username ?? "—"}{row.test ? <Badge variant="muted" className="ms-2">test</Badge> : null}</TableCell>
                    <TableCell><Badge variant={STATUS_VARIANT[row.status ?? ""] ?? "outline"}>{row.status ?? "unknown"}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{traffic(row)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.expiresAt)}</TableCell>
                    <TableCell>{row.knownLocally ? <Badge variant="success">linked</Badge> : <Badge variant="warning">not in bot database</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {clients?.pages ? <PaginationNav page={clients.page} pages={clients.pages} /> : null}
    </div>
  );
}
