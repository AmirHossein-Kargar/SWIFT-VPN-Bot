import { ProgressLink } from "@/components/shared/progress-link";
import { ArrowRight } from "lucide-react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { customerApiGet } from "@/lib/customerApi.server";
import { AdminApiError } from "@/lib/types";
import type { TicketDetail } from "@/lib/tickets";
import { formatCustomerDate } from "@/lib/customerTickets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerStatusBadge } from "@/components/support/customer-thread";
import { CustomerLiveThread } from "@/components/support/customer-live-thread";
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
      <ProgressLink pendingLabel="در حال بارگذاری" href="/support" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:underline"><ArrowRight className="size-4" aria-hidden="true" />بازگشت به تیکت‌های من</ProgressLink>
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base" dir="auto">{ticket.subject}</CardTitle>
            <CustomerStatusBadge status={ticket.status} />
          </div>
          <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            <span dir="ltr" className="font-mono">{ticket.ticketId}</span>
            <span>ایجاد: {formatCustomerDate(ticket.createdAt)}</span>
            <span>آخرین بروزرسانی: {formatCustomerDate(ticket.lastMessageAt)}</span>
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <CustomerLiveThread
            ticketId={ticket.ticketId}
            endpoint={`/api/support/tickets/${encodeURIComponent(ticket.ticketId)}/updates`}
            attachmentBase="/api/support/attachments"
            initialMessages={messages}
            initialCursor={detail.cursor ?? null}
            initialStatus={ticket.status}
            initialMessageCount={ticket.messageCount}
          />
          <CustomerTicketActions ticketId={ticket.ticketId} status={ticket.status} />
        </CardContent>
      </Card>
    </div>
  );
}
