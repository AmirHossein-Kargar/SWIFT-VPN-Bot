import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { adminApiGet } from "@/lib/adminApi.server";
import { AdminApiError } from "@/lib/types";
import { formatTicketDate, type TicketDetail } from "@/lib/tickets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TicketStatusBadge, TicketThread } from "@/components/tickets/ticket-thread";
import { AdminTicketActions } from "@/components/tickets/admin-ticket-actions";

export const metadata: Metadata = { title: "جزئیات تیکت" };
export const dynamic = "force-dynamic";

export default async function TicketDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  let detail: TicketDetail;
  try {
    detail = await adminApiGet<TicketDetail>(`/tickets/${encodeURIComponent(ticketId)}`);
  } catch (error) {
    if (error instanceof AdminApiError && error.status === 404) notFound();
    throw error;
  }
  const { ticket, messages } = detail;

  return (
    <div className="mx-auto max-w-3xl space-y-4" dir="rtl" lang="fa">
      <Link href="/tickets" className="text-sm text-muted-foreground hover:underline">→ بازگشت به فهرست تیکت‌ها</Link>
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base" dir="auto">{ticket.subject}</CardTitle>
            <TicketStatusBadge status={ticket.status} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
            <div><dt>شماره</dt><dd className="font-mono" dir="ltr">{ticket.ticketId}</dd></div>
            <div><dt>مشتری (شناسه تلگرام)</dt><dd className="font-mono" dir="ltr">{ticket.userTelegramId}</dd></div>
            <div><dt>ایجاد</dt><dd>{formatTicketDate(ticket.createdAt)}</dd></div>
            <div><dt>آخرین پیام</dt><dd>{formatTicketDate(ticket.lastMessageAt)}</dd></div>
          </dl>
        </CardHeader>
        <CardContent className="space-y-6">
          <TicketThread messages={messages} attachmentBase="/api/admin/tickets/attachments" viewer="admin" />
          <AdminTicketActions ticketId={ticket.ticketId} status={ticket.status} />
        </CardContent>
      </Card>
    </div>
  );
}
