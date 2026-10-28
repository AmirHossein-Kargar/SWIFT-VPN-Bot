// Support ticket types and the English admin-panel helpers. The Persian
// customer area keeps its own wording in lib/customerTickets.ts; nothing in the
// admin panel renders Persian UI text.
import { AdminApiError } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/** Canonical lifecycle, identical to the server (models/SupportTicket.js). */
export type TicketStatus = "open" | "pending_customer" | "closed";
export const TICKET_STATUSES: TicketStatus[] = ["open", "pending_customer", "closed"];

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
  closedByAdminId?: string | null;
  /** Admin view only: closed 72h+ ago, computed by the server. */
  deletable?: boolean;
  deletableAt?: string | null;
}

export type MessageDelivery = "pending" | "sent" | "failed";

export interface TicketMessage {
  id: string;
  author: "customer" | "admin";
  text: string;
  attachment: { kind: "photo" | "video"; fileSize?: number | null } | null;
  createdAt: string;
  /** Admin view only: who replied, and whether the customer's Telegram notification went out. */
  adminId?: string | null;
  delivery?: MessageDelivery | null;
}

export interface TicketDetail {
  ticket: TicketSummary;
  messages: TicketMessage[];
  /** Id of the newest message returned; live polling continues after it. */
  cursor?: string | null;
  /** Id of the oldest message returned; "load earlier" continues before it. */
  oldestCursor?: string | null;
  hasOlder?: boolean;
}

export interface TicketHistoryPage {
  messages: TicketMessage[];
  cursor: string | null;
  oldestCursor: string | null;
  hasOlder: boolean;
}

export interface TicketUpdates {
  ticket: TicketSummary;
  messages: TicketMessage[];
  cursor: string | null;
  hasMore: boolean;
}

export interface AdminTicketPage {
  tickets: TicketSummary[];
  total: number;
  page: number;
  pageSize: number;
  needsAttention: number;
  unreadTotal: number;
  /** Only the primary owner may clear the whole history. */
  canClearHistory?: boolean;
}

export interface BulkDeleteResult {
  requested: number;
  deleted: number;
  deletedIds: string[];
  skipped: { ticketId: string; reason: string; message: string }[];
  failed: { ticketId: string }[];
}

export interface ClearHistoryResult {
  complete: boolean;
  deletedTickets: number;
  deletedMessages: number;
  remaining: number | null;
  newerKept: number | null;
  errorCode: string | null;
}

export const CLEAR_HISTORY_PHRASE = "CLEAR ALL TICKET HISTORY";

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "Open",
  pending_customer: "Awaiting customer",
  closed: "Closed",
};

export const STATUS_VARIANTS: Record<TicketStatus, "success" | "warning" | "muted"> = {
  open: "success",
  pending_customer: "warning",
  closed: "muted",
};

/** Mirrors ADMIN_TRANSITIONS in services/support/tickets.js. The server enforces it; this only decides which options are offered. */
export const NEXT_STATUSES: Record<TicketStatus, TicketStatus[]> = {
  open: ["pending_customer", "closed"],
  pending_customer: ["open", "closed"],
  closed: [],
};

export const MAX_MESSAGE_LENGTH = 3500;

export function formatTicketDateTime(value: string | null | undefined): string {
  return formatDateTime(value);
}

const KNOWN_CODES: Record<string, string> = {
  ticket_closed: "This ticket is closed and cannot receive new messages.",
  reopen_not_allowed: "Closed tickets cannot be reopened. The customer can open a new ticket.",
  ticket_not_found: "Ticket not found.",
  owner_only: "Only the primary owner can clear the ticket history.",
  confirmation_required: "The confirmation phrase does not match.",
  delete_failed: "The ticket could not be deleted. Try again.",
  invalid_transition: "This status change is not allowed.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  csrf_token_invalid: "Your session needs to be refreshed. Reload the page and try again.",
  unauthorized: "Your session has expired. Sign in again.",
  audit_unavailable: "The audit log is unavailable, so the action was not performed. Try again shortly.",
  idempotency_conflict: "This operation was already submitted. Reload the ticket to see its current state.",
  action_in_progress: "This operation is already in progress or needs manual review. Reload the ticket.",
};

// Arabic-script block (Persian). Built from code points so this file itself holds no Persian text.
const NON_ENGLISH = new RegExp(`[${String.fromCharCode(0x600)}-${String.fromCharCode(0x6ff)}]`);

/** Always English. API messages are used when they are; otherwise the error code, then a generic fallback. */
export function ticketErrorMessage(error: unknown, fallback = "The request failed. Try again."): string {
  if (error instanceof AdminApiError) {
    if (error.message && !NON_ENGLISH.test(error.message) && error.message !== "The request failed.") return error.message;
    return KNOWN_CODES[error.code] ?? fallback;
  }
  if (error instanceof TypeError) return "Could not reach the server. Check your connection and try again.";
  return fallback;
}

/** Whether a failure is a definitive server answer (safe to start a new operation) rather than an unknown outcome. */
export function isDefinitiveFailure(error: unknown): boolean {
  return error instanceof AdminApiError && error.status >= 400 && error.status < 500;
}
