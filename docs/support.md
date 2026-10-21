# Support tickets

One ticket system, three entry points: the Telegram bot, the customer web area and the admin panel.
Everything is stored in MongoDB (`SupportTicket`, `SupportTicketMessage`); sessions and rate limits
reuse the existing Redis. There is no external helpdesk.

## Lifecycle

`open` (waiting for support) → `pending` (support replied) → `resolved` → `closed` → reopen → `open`.

- A support reply moves the ticket to `pending`; a customer message moves it back to `open`.
- Customers can close their own ticket and reopen it within 7 days. They cannot set other statuses.
- Admins follow the transition table in `services/support/tickets.js` (`closed` can only go to `open`).
- Neither side can post to a `closed` ticket. A customer can hold at most 5 non-closed tickets.

## Customers

**Telegram.** `🛠 پشتیبانی` opens one menu message (edited in place, never a "loading…" placeholder).
`🎫 تیکت جدید` starts a ticket; the next text/photo/video messages join it. `📂 تیکت‌های من` lists
the user's tickets. Replies arrive with `ادامه گفتگو / بستن تیکت / منوی اصلی` buttons.

**Web.** `/next-panel/support`. Sign-in is only through the bot (`🌐 مشاهده در پنل وب`): the bot mints
a one-time 5-minute code and shows it as a link (`#code=` fragment, never sent to the server in a
URL). There is deliberately no "send me a code" form, so the website cannot message arbitrary
Telegram users. Customer sessions use their own Redis keys and cookie
(`swift_customer_session`, scoped to `/api/support` and `/next-panel`) and can never satisfy an
admin check. The web area supports text; photos/videos sent from Telegram are viewable on the web.

## Administrators

- **Telegram admin group (`GROUP_ID`).** Every customer message is copied there with the ticket id.
  Reply (Telegram "Reply") to that copy to answer the customer — routing uses stored group message
  ids, so it survives restarts. Reply `/resolve`, `/pending`, `/close` or `/reopen` to change status.
  Only allow-listed admins in the admin group are honored; internal discussion is never forwarded.
- **Web `/next-panel/tickets`.** List with status filter, search (ticket id, Telegram id, subject),
  unread indicators and pagination; detail with the full conversation, reply and status controls.
  Replies and status changes are audited (`TICKET_REPLY`, `TICKET_STATUS`) and idempotent per
  `operationId`, so a double click never sends two replies. Closing asks for confirmation.

There is no separate "support agent" role: any allow-listed admin (`ADMINS` / admin registry) can
manage tickets, matching the rest of the panel.

## Safety properties

- Ownership is enforced in the service layer on every customer read/write; another customer's ticket
  answers 404 exactly like a missing one.
- Duplicate Telegram updates / repeated requests are absorbed by a unique per-message `dedupeKey`.
- Persistence happens before delivery: a Telegram failure never loses a message. Failed deliveries
  are flagged (`delivery: failed`) and the admin/customer is told.
- Message text is rendered as plain text in the web UI and HTML-escaped in Telegram.
- Attachments are streamed by the server from Telegram (the bot-token URL never reaches a browser)
  with `nosniff`, `sandbox` CSP and a media-type allowlist; downloads are owner-checked.
- Logs record event names, error types and status codes only — never message text or file ids.

## Operations

- Required: `GROUP_ID` (admin group) and Redis. `WEBHOOK_BASE_URL` (https) enables the web sign-in
  button; without it the bot simply omits that button.
- New collections `supportTickets` / `supportticketmessages` are created on first use with their
  indexes; nothing existing is altered.
