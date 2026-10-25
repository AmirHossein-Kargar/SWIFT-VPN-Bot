import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Support ticket" };
export const dynamic = "force-dynamic";

/** Older links (/tickets/T-XXXXXX) open the same ticket in the inbox. */
export default async function TicketDetailRedirect({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  redirect(`/tickets?t=${encodeURIComponent(ticketId)}`);
}
