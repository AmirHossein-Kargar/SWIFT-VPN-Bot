import type { Metadata } from "next";

import { adminApiGet } from "@/lib/adminApi.server";
import { TICKET_STATUSES, type AdminTicketPage } from "@/lib/tickets";
import { TicketWorkspace } from "@/components/tickets/ticket-workspace";

export const metadata: Metadata = { title: "Support tickets" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const TICKET_ID = /^T-[A-HJ-NP-Z2-9]{6}$/;
const PAGE_SIZE = 30;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

/**
 * Inbox + conversation. The server only seeds the first list render from the
 * URL (filters, page, selected ticket); everything after that, including the
 * open conversation and its read state, is loaded and kept live by the client.
 */
export default async function TicketsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const q = first(params.q).slice(0, 40);
  const status = TICKET_STATUSES.includes(first(params.status) as never) ? first(params.status) : "";
  const unread = first(params.unread) === "1";
  const page = Math.max(1, Number(first(params.page)) || 1);
  const selected = first(params.t);

  let list: AdminTicketPage | null = null;
  try {
    list = await adminApiGet<AdminTicketPage>("/tickets", { q, status, unread: unread ? "1" : undefined, page, pageSize: PAGE_SIZE });
  } catch {
    list = null; // the client retries and shows the error state
  }

  return <TicketWorkspace initial={{ q, status, unread, page, selectedId: TICKET_ID.test(selected) ? selected : null, list }} />;
}
