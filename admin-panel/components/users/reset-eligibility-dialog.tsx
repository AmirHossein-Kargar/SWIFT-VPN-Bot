"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminUser } from "@/lib/types";

export function ResetEligibilityDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (reason.trim().length < 5 || reason.trim().length > 240) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminMutate(`/users/${user.telegramId}/test-eligibility`, "POST", csrfToken, {
        operationId: newOperationId(),
        reason: reason.trim(),
      });
      toast.success(`Test-service eligibility reset for ${user.telegramId}.`);
      onOpenChange(false);
      setReason("");
      router.refresh();
    } catch (mutationError) {
      setError(mutationError instanceof AdminApiError ? mutationError.message : "The request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset test-service eligibility</DialogTitle>
          <DialogDescription>{user.name ?? user.username ?? user.telegramId} will be allowed to claim one more free test service.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reset-reason">Reason</Label>
          <Textarea id="reset-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is eligibility being reset?" />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            Reset eligibility
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
