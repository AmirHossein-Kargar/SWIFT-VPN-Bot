import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_VARIANTS, formatTicketDate, type TicketMessage, type TicketStatus } from "@/lib/tickets";

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

/**
 * Chronological conversation. Message text is rendered as plain text nodes
 * (React escapes it; `whitespace-pre-wrap` keeps line breaks) — never as HTML.
 * Attachments load through an authorized, same-origin endpoint, so the browser
 * never sees a Telegram file URL.
 */
export function TicketThread({
  messages,
  attachmentBase,
  viewer,
}: {
  messages: TicketMessage[];
  attachmentBase: string;
  viewer: "customer" | "admin";
}) {
  if (!messages.length) {
    return <p className="py-8 text-center text-sm text-muted-foreground">هنوز پیامی ثبت نشده است.</p>;
  }
  return (
    <ol className="space-y-3" aria-label="گفتگوی تیکت">
      {messages.map((message) => {
        const mine = message.author === viewer;
        return (
          <li key={message.id} className={cn("flex", mine ? "justify-start" : "justify-end")}>
            <div
              className={cn(
                "max-w-[85%] rounded-lg border px-3 py-2 text-sm",
                mine ? "border-primary/30 bg-primary/10" : "border-border bg-muted/40"
              )}
            >
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {message.author === "admin" ? "پشتیبانی" : "مشتری"} · {formatTicketDate(message.createdAt)}
              </p>
              {message.attachment?.kind === "photo" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${attachmentBase}/${message.id}`}
                  alt="پیوست تصویری"
                  loading="lazy"
                  className="mb-2 max-h-72 rounded-md border border-border"
                />
              ) : null}
              {message.attachment?.kind === "video" ? (
                <video src={`${attachmentBase}/${message.id}`} controls preload="none" className="mb-2 max-h-72 rounded-md border border-border" />
              ) : null}
              {message.text ? <p className="whitespace-pre-wrap break-words" dir="auto">{message.text}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
