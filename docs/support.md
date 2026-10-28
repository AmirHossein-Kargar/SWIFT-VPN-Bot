# Support tickets

One ticket system, three entry points: the Telegram bot, the customer web area and the admin panel.
**The admin panel's ticket inbox (`/panel/tickets`) is the only place conversations are read and
answered.** Everything is stored in MongoDB (`SupportTicket`, `SupportTicketMessage`); sessions and
rate limits reuse the existing Redis. There is no external helpdesk.

## Lifecycle

```
open ⇄ pending_customer → closed   (closed is final)
```

| Status | Meaning | Set by |
| --- | --- | --- |
| `open` | Waiting for support | A new ticket; any customer message |
| `pending_customer` | Support replied, waiting for the customer | An admin reply (or the admin dropdown) |
| `closed` | Finished. Read-only history | An admin, or the customer closing their own ticket |

These three values are the only statuses. The admin status filter, the admin status dropdown, the
API and the database all use exactly this set (`models/SupportTicket.js` → `TICKET_STATUSES`).
Tickets written before this simplification may still carry `pending` / `resolved`: every reader
treats them as `pending_customer` / `closed`, and the bot rewrites them once at start-up
(`migrateLegacyTicketStatuses`, idempotent, non-fatal).

### Closed-ticket policy

A closed ticket stays closed. It is enforced in the service layer (`services/support/tickets.js`), so
it holds for every entry point (bot, web area, panel, stale buttons, retried requests):

- Nobody can post to a closed ticket: customers get the Persian "ticket is closed, open a new one"
  notice (`ticket_closed`, HTTP 409); admins get the English equivalent.
- Nobody can reopen it. A customer's reopen attempt (an old `sup_reopen:` button, or
  `POST /api/support/tickets/:id/status {"status":"open"}`) returns `reopen_not_allowed` (409). Admins
  cannot reopen either. A message arriving never changes the status of a closed ticket.
- To get further help the customer creates a **new** ticket (the bot and the customer area offer it
  from the closed notice). Editing an old Telegram message does nothing: the bot does not subscribe
  to edits, and a redelivered update is absorbed by its `dedupeKey`.
- The full history stays readable in the panel.
- Closing is **idempotent**: closing an already-closed ticket succeeds with `changed: false`, does not
  notify the customer again and does not rewrite `closedAt` / `closedBy`.
- Close vs message races are resolved by a conditional update (`status ∉ closed`) taken *before* the
  message is written: a message is either accepted (stored, counted, ordered before the close) or
  rejected with nothing written. Nothing is ever deleted, so an accepted message cannot later
  disappear. The order is: reserve (touches only `updatedAt`) → insert the message → apply
  status / last-message fields → settle `messageCount` and unread. A failed insert therefore changes
  nothing. If the process dies after the insert, a retry of the same message re-applies the status
  while it is still the newest message, and opening the ticket in the panel or the customer area
  repairs it from `lastMessageId` (tickets stored before that field existed are not repaired this
  way). `messageCount` is derived from the stored rows, so it is repaired by any later message.
- Audit fields on close: `closedAt`, `closedBy` (`admin` | `customer`), `closedByAdminId`; the panel
  action is also recorded in the audit log (`TICKET_STATUS`, `TICKET_REPLY`).

> **Conflict with an appeal/reopen workflow.** Some businesses want customers to be able to appeal a
> closure. That is intentionally *not* implemented. If it is needed, add a separate controlled flow
> (for example a customer "request review" that creates a linked new ticket, or an admin-only reopen
> with a mandatory reason and audit entry) instead of relaxing the rule above.

## Customers

**Telegram.** The support button opens one menu message (edited in place, never a "loading…"
placeholder): title, description, *ثبت تیکت جدید*, *تیکت‌های من*, and *ارتباط مستقیم با پشتیبانی*
only when `SUPPORT_CONTACT` holds a valid account. *ثبت تیکت جدید* shows the terms notice, the
instruction and the supported file types (text, photo, video); a *قوانین و شرایط استفاده* button
appears only if `SUPPORT_TERMS_URL` is an https URL. The first message creates the ticket; later
messages join it. Admin replies arrive as a short notification with a *مشاهده تیکت* button (the reply
itself is read inside the ticket, the bot shows the latest three messages). Closing asks for one
confirmation tap because it cannot be undone.

All customer-facing wording is in `messages/supportCopy.js` (Persian); the customer web area has
its own copy in `admin-panel/lib/customerTickets.ts`.

**Web.** `/panel/support`. Sign-in is only through the bot (the *مشاهده در پنل وب* button mints a
one-time 5-minute link, `#code=` fragment). Customer sessions use their own Redis keys and cookie and
can never satisfy an admin check. The web area supports text; photos/videos sent from Telegram are
viewable there.

## Administrators: the ticket inbox

`/panel/tickets` is a two-pane messaging layout (one pane at a time on a phone). The whole admin
panel is English-only (labels, statuses, errors, dates); customer messages are shown exactly as sent.

- **Inbox:** search (ticket id, Telegram id, subject), status filter, "Unread only", unread badges
  per ticket and in total, paging. Filters, page and the open ticket are in the URL
  (`?status=…&t=T-XXXXXX`), so refresh, back/forward and shared links restore the view. Old
  `/tickets/T-XXXXXX` links redirect there.
- **Conversation:** customer bubbles on the left, support on the right, each with sender and time;
  support messages show whether the customer's Telegram notification went out. The newest 40
  messages load first and **Load earlier messages** fetches older pages (cursor = message id, no
  gaps or duplicates, reading position kept). The view follows new messages only while the admin is
  at the bottom; otherwise a *N new messages* button appears.
- **Composer:** Enter sends, Shift+Enter adds a line, text stays in the box until the server accepts
  it, and an unsent draft survives a refresh (per ticket, `sessionStorage`). Each reply carries an
  `operationId`, reused on retry after an unknown outcome, so it can never be delivered twice.
- **Status dropdown:** the same Radix/shadcn `Select` as the other filters, with the canonical
  values; unreachable options are disabled. Success is announced only after the server accepted the
  change, and the control always shows the server's saved value. Closing asks for confirmation.
  Closed tickets show a banner (who/when) and a disabled composer.
- **Attachments:** customer photos/videos are viewable; they are streamed by the server from Telegram
  (the bot-token URL never reaches a browser) with `nosniff` and a `sandbox` CSP. Limits at intake:
  photo/video only, at most 20 MB (Telegram's bot download limit), text up to 3,500 characters.
  Replies from the panel are text-only.

There is no separate "support agent" role: any allow-listed admin (`ADMINS` / admin registry) can
manage tickets, like the rest of the panel.

## Live updates

The panel uses authenticated **polling**, reusing the mechanism that was already there, because the
app is one Express process behind Railway's proxy where long-lived connections are not guaranteed and
a plain `GET` needs no extra infrastructure or dependency.

| What | Endpoint | Interval |
| --- | --- | --- |
| Inbox | `GET /api/admin/tickets?…` | 5 s |
| Open conversation | `GET /api/admin/tickets/:id/updates?after=<lastMessageId>&markRead=1` | 3 s |
| Older history | `GET /api/admin/tickets/:id/messages?before=<oldestMessageId>&limit=` | on demand |

- Polling runs only while the tab is visible, never overlaps itself, catches up immediately when the
  tab returns or the network comes back, and backs off (up to 30 s) while failing; the header shows
  *Live* / *Reconnecting…* / *Paused*.
- Persisted messages are authoritative. The cursor is the last message `_id`; replaying it returns the
  same rows and the client merges by id, so retries, a reply echoed by the next poll, or overlapping
  pages never render twice. Order is insertion order (`_id`), the same for every reader.
- Every poll is an ordinary request with the session cookie, so authorization is re-checked each
  time. A session that expires or is revoked starts returning 401: polling stops and the panel
  returns to sign-in. Admin sessions have a fixed lifetime (`ADMIN_SESSION_TTL_SECONDS`); neither
  polling nor closing a ticket extends it.
- Read state is written only when something is unread and the ticket is on screen, compare-and-set on
  the message count, so a message arriving mid-poll stays unread.
- Not guaranteed: sub-second delivery, or delivery to a hidden/asleep tab.

## The admin group (deprecated for support)

Conversations are **no longer copied to the admin group**: no message text, subject, name, username or
Telegram id is posted there, and replying in the group no longer answers customers.

- Replying to (or sending `/close`, `/resolve`, … as a reply to) an *old* ticket copy from an
  allow-listed admin gets a short pointer to the panel and changes nothing. Replies from non-admins,
  and replies to other messages, are handled exactly as before, so payment and manual-fulfilment
  group workflows are untouched.
- Optional: `SUPPORT_GROUP_ALERTS=1` posts one content-free heads-up per **new** ticket (ticket id and
  a panel link only). Off by default.
- Customer closures are no longer announced in the group.

## Safety properties

- Ownership is enforced in the service layer on every customer read/write; another customer's ticket
  answers 404 exactly like a missing one, and customer sessions can never reach admin endpoints.
- Duplicate Telegram updates / repeated requests are absorbed by a unique per-message `dedupeKey`; a
  retry of an already-accepted message succeeds even if the ticket has since been closed.
- Persistence happens before delivery: a Telegram failure never loses a message. Failed
  notifications are flagged (`delivery: failed`) and shown to the admin.
- Message text is rendered as plain text in the web UI (`dir="auto"`, never HTML) and HTML-escaped in
  Telegram. List and live endpoints return no message text beyond what the admin asked for, and
  customers never receive sender ids or delivery state.
- Admin API errors are English (`SupportError` carries both texts; the admin service layer always
  surfaces the English one, also inside audited actions).
- Logs record event names, error types and status codes only, never message text or file ids.

## Ticket creation and recovery

Creating a ticket is two writes (the ticket, then its first message) and MongoDB cannot make them
atomic, so a new ticket is **hidden until it is complete** (`services/support/tickets.js` →
`createTicket`):

1. The ticket is inserted with `provisional: true` and `createKey` = the creating event's
   `dedupeKey` (`tg:<chat>:<message>` from Telegram, `web:<telegramId>:<operationId>` from the web area).
2. The open-ticket cap is verified (next section).
3. The first message is stored under its own unique `dedupeKey`.
4. One conditional update (`provisional: false`, `unreadForAdmin: 1`, `messageCount`,
   `lastMessageId`) makes the ticket visible. Only the call whose update matches reports "created",
   so the confirmation and the optional group alert happen once.

Until step 4 the ticket does not exist for anyone: customer and admin lists, counts, lookups, replies,
status changes and customer attachment downloads all exclude `provisional` tickets (its message ids
are never handed out, so the admin attachment route, which is keyed by message id, cannot reach
them either). Tickets stored before this change have no `provisional` field and count as visible.

**Deduplication and index.** `createKey` has a unique, sparse index named `idx_ticket_create_key`
(`{ createKey: 1 }`; sparse, so older tickets without the field do not conflict). Duplicate or
concurrent deliveries of the same event collide on it and converge on the first ticket; the message's
own unique `dedupeKey` independently allows only one first message. Without the index, duplicates
still cannot produce two messages or two visible tickets, but concurrent twins may all get a
retryable error until it exists.

**Start-up.** `connectDB` creates the indexes with `createIndexes()` for every model (production runs
with `autoIndex` off). If that fails the start-up is aborted (`INDEX_INIT`, logged by `bot.js`, exit
code 1) and Telegram polling never starts. The HTTP port is bound earlier, for `/health`, but the
ticket APIs need a Redis-backed session and Redis connects only after MongoDB and its indexes are
ready, so they answer 503 or 401 until then.

**Recovery.** Nothing has to be run by hand:

- *Retry of the same event* (same `dedupeKey`): the ticket is found through `createKey`, finished
  (cap verified again, first message stored without duplicating, ticket made visible) and answered
  with the same ticket id. A first message whose ticket no longer exists is deleted (by its `_id`) and
  the create restarts.
- *Failed message write:* if no message exists for the hidden ticket, it is deleted immediately
  (best effort).
- *Process crash:* the hidden ticket stays invisible. It counts towards its owner's cap for at most
  60 s (`PROVISIONAL_GRACE_MS`). After that, the owner's next create sweeps up to ten such tickets:
  one without a message is deleted; one whose message did land is made visible if the cap allows it
  and deleted otherwise (its create was never acknowledged to the customer).
- *Twins racing a failed create* can get `ticket_unavailable` (503, "try again"); the retry converges
  on one ticket and one message. A create slower than 60 s can lose to that sweep in the same way.

## Open-ticket cap

A customer can have at most 5 non-closed tickets (`MAX_OPEN_TICKETS_PER_USER`, hidden tickets
included). A create beyond that is refused with `too_many_open_tickets` (429); closing a ticket
frees a slot. Tickets cannot be reopened, so closing never needs a cap check.

How it holds under concurrent creates, without transactions:

- Every path that makes a hidden ticket visible (the creator, a twin's retry, the sweep above) first
  counts the owner's non-closed tickets **after** that ticket was inserted, and withdraws the ticket
  if the count exceeds 5. Take the visible ticket whose count started last: every other visible
  ticket was inserted before its own, earlier-started count, so all of them are in that count, and
  the total cannot exceed 5.
- A ticket is withdrawn only by its own failed check (or by the sweep / cleanup above), never by
  another creator's decision.
- Colliding creators may all back off in the same round. A creator retries up to 6 rounds, each after
  a short random pause (under 25 ms × the round number), before being refused. Under a burst the cap
  can therefore refuse slightly early; it does not admit too many.
- The count is pinned to the `userTelegramId_1` index. That key never changes, so concurrent updates to
  other indexed fields cannot make the scan miss a ticket. If the index is missing MongoDB rejects the
  hint and a plain count is used.

Assumptions: reads go to the primary (the app sets no read preference; do not add `readPreference=`
to the connection string); acknowledged writes are not rolled back by a failover; every creator runs
this version (next section). Tickets inserted by hand are outside the guarantee.

## Deployment: single-version cutover

Deploy this change as a **single-version cutover**: stop every instance of the previous version
before the new one starts. Do not run old and new together (no rolling or overlapping deploy). That
has not been shown to be safe, and the code argues against it:

- The previous version (`b8b5923` and earlier) uses `open / pending / resolved / closed`, lets a
  customer reopen a closed ticket for 7 days (`CUSTOMER_REOPEN_WINDOW_MS`) and reopens a `resolved`
  ticket on a customer reply. Running next to this version it can reopen tickets that are final here,
  and it does not know `pending_customer`, which this version writes.
- It lists every ticket it finds, hidden (`provisional`) ones included, and creates tickets without
  `createKey` and with a plain count-then-insert cap check that is not atomic, so neither the
  deduplication nor the cap guarantee above holds while it runs.

Sequence: back up `supporttickets` and `supportticketmessages` → stop the old instance(s) (if your
platform overlaps deployments, switch that off for this release) → start the new version. At start-up
it builds the indexes (fatal on failure), rewrites legacy statuses once (`pending` → `pending_customer`,
`resolved` → `closed`; idempotent, non-fatal, logged as `Support tickets migrated` when it changed
anything) and only then starts Telegram polling. This is not a zero-downtime procedure: the bot is
unavailable between the old instance stopping and the new one finishing start-up.

Checks afterwards (mongosh):

- `db.supporttickets.getIndexes()` lists `idx_ticket_create_key` with `unique: true, sparse: true`.
- `db.supporttickets.countDocuments({ provisional: true })` is normally 0. Tickets younger than 60 s
  are expected while customers are creating tickets; older leftovers are cleared by the owner's next
  create or by the retry of the same event.

Rolling back: no reverse migration exists. After the status rewrite the previous version would meet
`pending_customer`, which it does not know, and it would list `provisional` tickets as empty tickets.
Going back therefore needs a manual status rewrite that this repository does not provide, and
deleting the hidden tickets first (`db.supporttickets.deleteMany({ provisional: true })`; they were
never acknowledged to a customer). Prefer fixing forward.

## Operations

- Required: Redis (sessions, rate limits). `WEBHOOK_BASE_URL` (https) enables the web sign-in button
  and the group-alert link; without it the bot omits them.
- Optional: `SUPPORT_CONTACT` (direct-contact button), `SUPPORT_TERMS_URL` (terms button, https only),
  `SUPPORT_GROUP_ALERTS` (new-ticket heads-up in `GROUP_ID`).
- Collections `supporttickets` / `supportticketmessages` (models `SupportTicket` /
  `SupportTicketMessage`). Data changes from the earlier version: the one-time status rewrite, the
  new fields `provisional`, `createKey` and `lastMessageId` on tickets, and the index
  `idx_ticket_create_key`. `groupMessageIds` on old messages is kept so old group copies can still be
  recognised; nothing writes it any more.

## Deleting tickets

Closed tickets become **deletable 72 hours after `closedAt`** (the timestamp `changeStatus` stores when a ticket is closed; creation and last-message times never count). Eligibility is a permission only; nothing is ever deleted automatically.

- Legacy closed tickets with no `closedAt` are never deletable (the closing time is not guessed). The startup migration backfills `closedAt` only for old `resolved` tickets, from `updatedAt`; other gaps need a manual `closedAt` fix before those tickets qualify.
- Closing is final, so a "reopened" ticket cannot exist; any ticket that is not closed is refused.
- **Single / bulk delete** (any allowlisted admin): `DELETE /api/admin/tickets/:ticketId` and `POST /api/admin/tickets/bulk-delete` (`ticketIds`, at most 20). The ticket row is removed with a conditional delete that re-checks eligibility atomically, then its messages. The response lists deleted, skipped (with reason) and failed tickets. Audit actions: `TICKET_DELETE`, `TICKET_BULK_DELETE` (ids only, never message text).
- **Clear All Ticket History** (primary owner only): `POST /api/admin/tickets/clear-history` with `confirmation: "CLEAR ALL TICKET HISTORY"`. Deletes every ticket (open included) and its messages in batches of 200, only those created before the run started; `complete: false` is returned if anything remains after a failure, and running it again resumes. Audit action `TICKET_HISTORY_CLEAR`. Users, payments, wallets, subscriptions, admins and audit logs are never touched.
- Panel: closed ticket header shows **Delete**; the inbox has **Select to delete** and, for the owner, **Clear All Ticket History**.
