import Link from "next/link";
import type { Metadata } from "next";

import { adminApiGet } from "@/lib/adminApi.server";
import { formatTicketDate, type AdminTicketPage } from "@/lib/tickets";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationNav } from "@/components/shared/pagination-nav";
import { TicketsFilters } from "@/components/tickets/tickets-filters";
import { TicketStatusBadge } from "@/components/tickets/ticket-thread";

export const metadata: Metadata = { title: "تیکت‌ها" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const q = first(params.q);
  const status = first(params.status);
  const unread = first(params.unread) === "1";
  const page = Number(first(params.page)) || 1;

  const result = await adminApiGet<AdminTicketPage>("/tickets", { q, status, unread: unread ? "1" : undefined, page, pageSize: 20 });
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));

  return (
    <div className="space-y-4" dir="rtl" lang="fa">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">تیکت‌های پشتیبانی</h1>
        {result.needsAttention > 0 ? <Badge variant="warning">{result.needsAttention.toLocaleString("fa-IR")} تیکت نیازمند پاسخ</Badge> : null}
      </div>
      <TicketsFilters defaultQuery={q} defaultStatus={status} defaultUnread={unread} />
      <Card>
        <CardContent className="p-0">
          {result.tickets.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">تیکتی با این مشخصات یافت نشد.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">شماره</TableHead>
                  <TableHead className="text-right">موضوع</TableHead>
                  <TableHead className="text-right">وضعیت</TableHead>
                  <TableHead className="text-right">مشتری</TableHead>
                  <TableHead className="text-right">آخرین پیام</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.tickets.map((ticket) => (
                  <TableRow key={ticket.ticketId}>
                    <TableCell className="font-mono text-xs" dir="ltr">
                      <Link className="underline-offset-2 hover:underline" href={`/tickets/${ticket.ticketId}`}>{ticket.ticketId}</Link>
                    </TableCell>
                    <TableCell className="max-w-xs truncate" dir="auto">
                      {ticket.unread > 0 ? <span className="me-2 inline-block h-2 w-2 rounded-full bg-primary align-middle" role="img" aria-label="پیام خوانده‌نشده" /> : null}
                      {ticket.subject}
                    </TableCell>
                    <TableCell><TicketStatusBadge status={ticket.status} /></TableCell>
                    <TableCell className="font-mono text-xs" dir="ltr">{ticket.userTelegramId}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTicketDate(ticket.lastMessageAt)}</TableCell>
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
