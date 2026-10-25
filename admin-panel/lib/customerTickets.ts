// Customer support area (/support). Persian is the language of every
// customer-facing surface, so the wording lives here, apart from the English
// admin panel helpers in lib/tickets.ts.
import type { TicketStatus } from "@/lib/tickets";

export const CUSTOMER_STATUS_LABELS: Record<TicketStatus, string> = {
  open: "باز",
  pending_customer: "در انتظار پاسخ شما",
  closed: "بسته",
};

export const CUSTOMER_STATUS_VARIANTS: Record<TicketStatus, "success" | "warning" | "muted"> = {
  open: "success",
  pending_customer: "warning",
  closed: "muted",
};

export const CUSTOMER_COPY = {
  closed: "این تیکت بسته شده است و امکان ارسال پیام در آن وجود ندارد. اگر همچنان به کمک نیاز دارید، لطفاً تیکت جدیدی ثبت کنید.",
  noMessages: "گفت‌وگو هنوز شروع نشده است. پیام خود را ارسال کنید تا تیم پشتیبانی بتواند راهنمایی‌تان کند.",
  noTickets: "هنوز تیکتی ثبت نکرده‌اید.",
} as const;

const dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tehran" });

export function formatCustomerDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormat.format(date);
}

/** Server messages for the customer area are Persian and safe to show; only fall back for unknown shapes. */
export function customerErrorMessage(error: unknown, fallback = "درخواست انجام نشد. دوباره تلاش کنید."): string {
  if (error instanceof Error && error.message && /[؀-ۿ]/.test(error.message)) return error.message;
  if (error instanceof TypeError) return "ارتباط با سرور برقرار نشد. اینترنت خود را بررسی کنید.";
  return fallback;
}
