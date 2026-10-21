import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { customerApiGet } from "@/lib/customerApi.server";
import { AdminApiError } from "@/lib/types";
import { formatTicketDate, type TicketDetail } from "@/lib/tickets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TicketStatusBadge, TicketThread } from "@/components/tickets/ticket-thread";
import { CustomerTicketActions } from "@/components/support/customer-ticket-actions";

export const metadata: Metadata = { title: "گفتگوی تیکت" };
export const dynamic = "force-dynamic";

export default async function CustomerTicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  let detail: TicketDetail;
  try {
    detail = await customerApiGet<TicketDetail>(`/tickets/${encodeURIComponent(ticketId)}`);
  } catch (error) {
    // Another customer's ticket answers 404 exactly like a missing one.
    if (error instanceof AdminApiError && error.status === 404) notFound();
    throw error;
  }
  const { ticket, messages } = detail;

  return (
    <div className="space-y-4">
      <Link href="/support" className="text-sm text-muted-foreground hover:underline">→ بازگشت به تیکت‌های من</Link>
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base" dir="auto">{ticket.subject}</CardTitle>
            <TicketStatusBadge status={ticket.status} />
          </div>
          <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            <span dir="ltr" className="font-mono">{ticket.ticketId}</span>
            <span>ایجاد: {formatTicketDate(ticket.createdAt)}</span>
            <span>آخرین بروزرسانی: {formatTicketDate(ticket.lastMessageAt)}</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <TicketThread messages={messages} attachmentBase="/api/support/attachments" viewer="customer" />
          <CustomerTicketActions ticketId={ticket.ticketId} status={ticket.status} />
        </CardContent>
      </Card>
    </div>
  );
}
