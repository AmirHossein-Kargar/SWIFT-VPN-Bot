// Shared by the admin ticket pages and the customer support area. Persian is
// the language of every customer-facing surface, so labels live here once.
export type TicketStatus = "open" | "pending" | "resolved" | "closed";

export interface TicketSummary {
  ticketId: string;
  subject: string;
  status: TicketStatus;
  channel: "telegram" | "web";
  createdAt: string;
  lastMessageAt: string;
  lastMessageBy: "customer" | "admin";
  messageCount: number;
  closedAt: string | null;
  unread: number;
  /** Admin view only. */
  userTelegramId?: string;
  closedBy?: "customer" | "admin" | null;
}

export interface TicketMessage {
  id: string;
  author: "customer" | "admin";
  text: string;
  attachment: { kind: "photo" | "video" } | null;
  createdAt: string;
}

export interface TicketDetail {
  ticket: TicketSummary;
  messages: TicketMessage[];
  /** Id of the last message returned; the live poller continues from here. */
  cursor?: string | null;
}

export interface AdminTicketPage {
  tickets: TicketSummary[];
  total: number;
  page: number;
  pageSize: number;
  needsAttention: number;
}

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "باز",
  pending: "در انتظار پاسخ مشتری",
  resolved: "حل‌شده",
  closed: "بسته",
};

export const STATUS_VARIANTS: Record<TicketStatus, "success" | "warning" | "default" | "muted"> = {
  open: "success",
  pending: "warning",
  resolved: "default",
  closed: "muted",
};

export const TICKET_STATUSES: TicketStatus[] = ["open", "pending", "resolved", "closed"];

const dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tehran" });

export function formatTicketDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormat.format(date);
}

/** Server messages for tickets are Persian and safe to show; only fall back for unknown shapes. */
export function ticketErrorMessage(error: unknown, fallback = "درخواست انجام نشد. دوباره تلاش کنید."): string {
  if (error instanceof Error && error.message && /[؀-ۿ]/.test(error.message)) return error.message;
  if (error instanceof TypeError) return "ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید.";
  return fallback;
}
