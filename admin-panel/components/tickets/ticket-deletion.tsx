"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import {
  CLEAR_HISTORY_PHRASE,
  formatTicketDateTime,
  isDefinitiveFailure,
  ticketErrorMessage,
  type BulkDeleteResult,
  type ClearHistoryResult,
  type TicketSummary,
} from "@/lib/tickets";

/** Why a ticket can or cannot be deleted right now, in words an admin can act on. */
export function deletionNote(ticket: Pick<TicketSummary, "status" | "closedAt" | "deletable" | "deletableAt">): string {
  if (ticket.deletable) return "Closed more than 72 hours ago, so it can be deleted.";
  if (ticket.status !== "closed") return "Only closed tickets can be deleted. This one is still active.";
  if (!ticket.closedAt) return "This ticket has no recorded closing time, so it cannot be deleted.";
  return `A ticket can be deleted 72 hours after it was closed. This one becomes deletable ${formatTicketDateTime(ticket.deletableAt)}.`;
}

/** Delete button + confirmation for the open ticket. Disabled (with the reason) until the ticket is eligible. */
export function TicketDeleteControl({ ticket, onDeleted }: { ticket: TicketSummary; onDeleted: () => void }) {
  const { csrfToken } = useAdminSession();
  const op = useOperationId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ticket.status !== "closed") return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await adminMutate(`/tickets/${ticket.ticketId}`, "DELETE", csrfToken, { operationId: op.operationId });
      op.rotate();
      toast.success(`Ticket ${ticket.ticketId} deleted.`);
      setOpen(false);
      onDeleted();
    } catch (failure) {
      if (isDefinitiveFailure(failure)) op.rotate();
      setError(ticketErrorMessage(failure, "The ticket could not be deleted."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!ticket.deletable}
        title={deletionNote(ticket)}
        onClick={() => { setError(null); setOpen(true); }}
      >
        <Trash2 /> Delete
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete ticket {ticket.ticketId}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p dir="auto" className="font-medium text-foreground">{ticket.subject}</p>
                <p>Customer <span className="font-mono">{ticket.userTelegramId}</span> · {ticket.messageCount} message{ticket.messageCount === 1 ? "" : "s"} · closed {formatTicketDateTime(ticket.closedAt)}</p>
                <p>{deletionNote(ticket)}</p>
                <p>This permanently deletes the ticket and its whole conversation. It cannot be undone. The deletion is recorded in the audit log.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => { event.preventDefault(); void confirm(); }}
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Confirmation for deleting the selected tickets. The server re-checks every ticket and reports what it skipped. */
export function BulkDeleteDialog({
  ticketIds,
  open,
  onOpenChange,
  onDone,
}: {
  ticketIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (result: BulkDeleteResult) => void;
}) {
  const { csrfToken } = useAdminSession();
  const op = useOperationId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (busy || ticketIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adminMutate<BulkDeleteResult>("/tickets/bulk-delete", "POST", csrfToken, { operationId: op.operationId, ticketIds });
      op.rotate();
      const problems = result.skipped.length + result.failed.length;
      if (problems === 0) toast.success(`${result.deleted} ticket${result.deleted === 1 ? "" : "s"} deleted.`);
      else toast.warning(`${result.deleted} deleted, ${result.skipped.length} skipped, ${result.failed.length} failed.${result.skipped[0] ? ` ${result.skipped[0].message}` : ""}`);
      onOpenChange(false);
      onDone(result);
    } catch (failure) {
      if (isDefinitiveFailure(failure)) op.rotate();
      setError(ticketErrorMessage(failure, "The tickets could not be deleted."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {ticketIds.length} selected ticket{ticketIds.length === 1 ? "" : "s"}?</AlertDialogTitle>
          <AlertDialogDescription>
            Only tickets closed more than 72 hours ago are deleted; the server checks each one again and skips any that no longer qualify. Deleted tickets and their conversations cannot be recovered.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="max-h-24 overflow-y-auto font-mono text-xs text-muted-foreground">{ticketIds.join(", ")}</p>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy || ticketIds.length === 0}
            onClick={(event) => { event.preventDefault(); void confirm(); }}
          >
            {busy ? "Deleting…" : `Delete ${ticketIds.length}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Owner-only "Clear All Ticket History": its own danger button, warning and typed confirmation. */
export function ClearHistoryControl({ onCleared }: { onCleared: () => void }) {
  const { csrfToken } = useAdminSession();
  const op = useOperationId();
  const [open, setOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = phrase === CLEAR_HISTORY_PHRASE;

  async function confirm() {
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      const result = await adminMutate<ClearHistoryResult>("/tickets/clear-history", "POST", csrfToken, { operationId: op.operationId, confirmation: phrase });
      op.rotate();
      onCleared();
      if (result.complete) {
        toast.success(`Ticket history cleared: ${result.deletedTickets} ticket${result.deletedTickets === 1 ? "" : "s"} and ${result.deletedMessages} message${result.deletedMessages === 1 ? "" : "s"} removed.`);
        setOpen(false);
        setPhrase("");
      } else {
        // Never present a partial run as done: keep the dialog open so it can be run again.
        setError(`Only part of the history was cleared (${result.deletedTickets} tickets removed${result.remaining == null ? "" : `, ${result.remaining} remaining`}). Run it again to finish.`);
      }
    } catch (failure) {
      if (isDefinitiveFailure(failure)) op.rotate();
      setError(ticketErrorMessage(failure, "The ticket history could not be cleared."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => { setError(null); setPhrase(""); setOpen(true); }}>
        <Trash2 /> Clear All Ticket History
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
        <AlertDialogContent className="border-destructive/60">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Clear All Ticket History</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p className="font-medium text-foreground">This permanently deletes every support ticket and every message, including tickets that are still open and the 72-hour rule does not apply.</p>
                <p>Customers, subscriptions, payments, wallets, admin accounts and audit logs are not affected. This cannot be undone.</p>
                <p>Type <span className="font-mono font-semibold text-foreground">{CLEAR_HISTORY_PHRASE}</span> to confirm.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" spellCheck={false} aria-label="Confirmation phrase" placeholder={CLEAR_HISTORY_PHRASE} disabled={busy} />
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy || !matches}
              onClick={(event) => { event.preventDefault(); void confirm(); }}
            >
              {busy ? "Clearing…" : "Clear everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
