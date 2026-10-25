import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABELS, STATUS_VARIANTS, formatTicketDateTime, type TicketMessage, type TicketStatus } from "@/lib/tickets";

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}

const ATTACHMENT_BASE = "/api/admin/tickets/attachments";

function senderLabel(message: TicketMessage, actorId: string): string {
  if (message.author === "customer") return "Customer";
  if (!message.adminId) return "Support";
  return message.adminId === actorId ? "You" : `Admin ${message.adminId}`;
}

function deliveryLabel(message: TicketMessage): { text: string; tone: string } | null {
  if (message.author !== "admin" || !message.delivery) return null;
  if (message.delivery === "failed") return { text: "Customer notification failed", tone: "text-destructive" };
  if (message.delivery === "pending") return { text: "Notifying customer…", tone: "text-muted-foreground" };
  return { text: "Customer notified", tone: "text-muted-foreground" };
}

/**
 * The conversation as chat bubbles: customer on the left, support on the right.
 * Message text is rendered as plain text nodes (React escapes it, and
 * `whitespace-pre-wrap` keeps line breaks), never as HTML. `dir="auto"` lets a
 * customer's message follow its own script without changing the panel layout.
 * Attachments load through an authorized, same-origin endpoint, so the browser
 * never sees a Telegram file URL.
 */
export function MessageList({ messages, actorId }: { messages: TicketMessage[]; actorId: string }) {
  if (!messages.length) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No messages in this ticket yet.</p>;
  }
  return (
    <ol className="space-y-3">
      {messages.map((message) => {
        const fromSupport = message.author === "admin";
        const delivery = deliveryLabel(message);
        return (
          <li key={message.id} className={cn("flex", fromSupport ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] sm:max-w-[75%]", fromSupport ? "items-end" : "items-start", "flex flex-col gap-1")}>
              <div
                className={cn(
                  "rounded-2xl px-3.5 py-2 text-sm shadow-sm",
                  fromSupport
                    ? "rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm border border-border bg-muted text-foreground"
                )}
              >
                {message.attachment?.kind === "photo" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${ATTACHMENT_BASE}/${message.id}`}
                    alt="Photo attachment"
                    loading="lazy"
                    className="mb-2 max-h-72 rounded-lg border border-border/60"
                  />
                ) : null}
                {message.attachment?.kind === "video" ? (
                  <video
                    src={`${ATTACHMENT_BASE}/${message.id}`}
                    controls
                    preload="none"
                    aria-label="Video attachment"
                    className="mb-2 max-h-72 rounded-lg border border-border/60"
                  />
                ) : null}
                {message.text ? <p className="whitespace-pre-wrap break-words" dir="auto">{message.text}</p> : null}
              </div>
              <p className="flex flex-wrap gap-x-2 px-1 text-xs text-muted-foreground">
                <span className="font-medium">{senderLabel(message, actorId)}</span>
                <time dateTime={message.createdAt}>{formatTicketDateTime(message.createdAt)}</time>
                {delivery ? <span className={delivery.tone}>{delivery.text}</span> : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
