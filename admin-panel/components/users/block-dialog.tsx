"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import type { AdminUser } from "@/lib/types";

// What a block actually does, as enforced by services/users/accessGate.js.
const BLOCK_SCOPE = [
  "The bot ignores their messages and button presses in private chat and replies with a blocked notice.",
  "They cannot buy, top up, request a test service or press “I paid”.",
  "Existing VPN services keep working until they expire — blocking does not revoke them.",
  "Payments already in flight are still verified and credited by the payment webhooks.",
];

export function BlockDialog({ user, open, onOpenChange, onDone }: { user: AdminUser; open: boolean; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const { csrfToken } = useAdminSession();
  const { operationId, rotate } = useOperationId();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = user.name ?? (user.username ? `@${user.username}` : user.telegramId);
  const blocking = !user.isBanned;

  async function submit() {
    if (blocking && (reason.trim().length < 5 || reason.trim().length > 240)) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminMutate(`/users/${user.telegramId}/${blocking ? "block" : "unblock"}`, "POST", csrfToken, {
        operationId,
        ...(blocking ? { reason: reason.trim() } : {}),
      });
      toast.success(blocking ? `${label} is blocked.` : `${label} is unblocked.`);
      rotate();
      setReason("");
      onOpenChange(false);
      onDone?.();
    } catch (mutationError) {
      setError(describeError(mutationError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{blocking ? `Block ${label}?` : `Unblock ${label}?`}</DialogTitle>
          <DialogDescription>{blocking ? "What blocking does:" : "They regain normal access to the bot immediately."}</DialogDescription>
        </DialogHeader>
        {blocking ? (
          <>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {BLOCK_SCOPE.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <div className="space-y-1.5">
              <Label htmlFor="block-reason">Reason (kept in the audit log)</Label>
              <Textarea id="block-reason" maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this user being blocked?" />
            </div>
          </>
        ) : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button variant={blocking ? "destructive" : "default"} loading={submitting} onClick={submit}>
            {submitting ? "Saving…" : blocking ? "Block user" : "Unblock user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
