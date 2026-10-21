import type { Metadata } from "next";

import { adminApiGet } from "@/lib/adminApi.server";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationNav } from "@/components/shared/pagination-nav";
import { formatDateTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Referrals" };
export const dynamic = "force-dynamic";

interface ReferralItem {
  telegramId: string;
  referralCode: string | null;
  referredByTelegramId: string | null;
  createdAt: string | null;
}

interface ReferralPage {
  items: ReferralItem[];
  page: number;
  pageSize: number;
  total: number;
  trackingAvailable: boolean;
}

export default async function ReferralsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const raw = Array.isArray(params.page) ? params.page[0] : params.page;
  const page = Number(raw) || 1;
  const result = await adminApiGet<ReferralPage>("/referrals", { page, pageSize: 25 });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-0">
          {!result.trackingAvailable ? (
            <div className="space-y-1 py-12 text-center text-sm text-muted-foreground">
              <p>No referral records yet.</p>
              <p className="text-xs">Referral codes are issued as users start using the updated bot; historical accounts appear as soon as they interact.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Referral code</TableHead>
                  <TableHead>Referred by</TableHead>
                  <TableHead>Registered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.map((item) => (
                  <TableRow key={item.telegramId}>
                    <TableCell className="font-mono text-xs">{item.telegramId}</TableCell>
                    <TableCell className="font-mono text-xs">{item.referralCode ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{item.referredByTelegramId ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{item.createdAt ? formatDateTime(item.createdAt) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={pages} />
    </div>
  );
}
