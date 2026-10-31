import { ProgressLink } from "@/components/shared/progress-link";
import type { Metadata } from "next";

import { customerApiGet } from "@/lib/customerApi.server";
import type { TicketSummary } from "@/lib/tickets";
import { CUSTOMER_COPY, formatCustomerDate } from "@/lib/customerTickets";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CustomerStatusBadge } from "@/components/support/customer-thread";
import { CustomerLiveRefresh } from "@/components/support/customer-live-refresh";

export const metadata: Metadata = { title: "تیکت‌های من" };
export const dynamic = "force-dynamic";

export default async function SupportHomePage() {
  const { tickets } = await customerApiGet<{ tickets: TicketSummary[] }>("/tickets");

  return (
    <div className="space-y-4">
      <CustomerLiveRefresh />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">تیکت‌های من</h1>
        <ProgressLink pendingLabel="در حال بارگذاری" href="/support/new" className={buttonVariants({ size: "sm" })}>تیکت جدید</ProgressLink>
      </div>

      {tickets.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">{CUSTOMER_COPY.noTickets}</p>
            <ProgressLink pendingLabel="در حال بارگذاری" href="/support/new" className={buttonVariants({ variant: "outline" })}>ثبت اولین تیکت</ProgressLink>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {tickets.map((ticket) => (
            <li key={ticket.ticketId}>
              <ProgressLink pendingLabel="در حال بارگذاری" href={`/support/${ticket.ticketId}`} className="block rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium" dir="auto">{ticket.subject}</span>
                  <span className="flex items-center gap-2">
                    {ticket.unread > 0 ? <Badge variant="warning">پاسخ جدید</Badge> : null}
                    <CustomerStatusBadge status={ticket.status} />
                  </span>
                </div>
                <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                  <span dir="ltr" className="font-mono">{ticket.ticketId}</span>
                  <span>ایجاد: {formatCustomerDate(ticket.createdAt)}</span>
                  <span>آخرین بروزرسانی: {formatCustomerDate(ticket.lastMessageAt)}</span>
                </p>
              </ProgressLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
