"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminGet, adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import type { AdminUser, UserDetail } from "@/lib/types";

export function ResetEligibilityDialog({
  user,
  testService: providedTestService,
  open,
  onOpenChange,
  onDone,
}: {
  user: AdminUser;
  testService?: UserDetail["testService"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { csrfToken } = useAdminSession();
  const { operationId, rotate } = useOperationId();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Opened from the table row there is no detail loaded yet, so read the
  // current state here: the admin should see it (and an in-flight warning)
  // before confirming. The server re-checks it regardless.
  const [loadedTestService, setLoadedTestService] = useState<UserDetail["testService"] | null>(null);
  const [stateUnavailable, setStateUnavailable] = useState(false);
  const testService = providedTestService ?? loadedTestService ?? undefined;
  useEffect(() => {
    if (!open || providedTestService) return;
    let cancelled = false;
    setStateUnavailable(false);
    adminGet<UserDetail>(`/users/${encodeURIComponent(user.telegramId)}`)
      .then((detail) => { if (!cancelled) setLoadedTestService(detail.testService); })
      .catch(() => { if (!cancelled) setStateUnavailable(true); });
    return () => { cancelled = true; };
  }, [open, providedTestService, user.telegramId]);
  const label = user.name ?? (user.username ? `@${user.username}` : user.telegramId);

  async function handleSubmit() {
    if (reason.trim().length < 5 || reason.trim().length > 240) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await adminMutate<{ alreadyEligible?: boolean }>(`/users/${user.telegramId}/test-eligibility`, "POST", csrfToken, { operationId, reason: reason.trim() });
      toast.success(result?.alreadyEligible ? `${label} was already eligible; nothing changed.` : `${label} can request one more test service from the bot.`);
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
          <DialogTitle>Restore test-service eligibility</DialogTitle>
          <DialogDescription>
            Lets {label} request one more free test service from the bot. Nothing is created now — the user still has to request it, and the normal checks apply.
          </DialogDescription>
        </DialogHeader>
        {testService ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            Current state: {testService.eligible ? "already eligible" : testService.inFlight ? `in progress (${testService.status})` : testService.received ? "test already received" : testService.status ?? "unknown"}
          </p>
        ) : null}
        {!testService && !stateUnavailable ? <p className="text-sm text-muted-foreground">Checking current test-service state…</p> : null}
        {stateUnavailable ? <p className="text-sm text-muted-foreground">Could not read the current state; the server will still validate the request.</p> : null}
        {testService?.inFlight ? (
          <p className="text-sm text-warning">A test service is being provisioned or awaits review; the server will refuse this until it is resolved.</p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="reset-reason">Reason (kept in the audit log)</Label>
          <Textarea id="reset-reason" maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is eligibility being restored?" />
        </div>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} loading={submitting}>{submitting ? "Saving…" : "Restore eligibility"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
