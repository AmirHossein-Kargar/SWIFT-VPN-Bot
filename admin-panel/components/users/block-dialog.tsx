"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminUser } from "@/lib/types";

export function BlockDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(blocked: boolean, reasonValue?: string) {
    setSubmitting(true);
    setError(null);
    try {
      await adminMutate(`/users/${user.telegramId}/${blocked ? "block" : "unblock"}`, "POST", csrfToken, {
        operationId: newOperationId(),
        ...(reasonValue ? { reason: reasonValue } : {}),
      });
      toast.success(blocked ? `${user.telegramId} blocked.` : `${user.telegramId} unblocked.`);
      onOpenChange(false);
      setReason("");
      router.refresh();
    } catch (mutationError) {
      setError(mutationError instanceof AdminApiError ? mutationError.message : "The request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (user.isBanned) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unblock this user?</AlertDialogTitle>
            <AlertDialogDescription>{user.name ?? user.username ?? user.telegramId} will regain full access to the bot.</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={submitting} onClick={(event) => { event.preventDefault(); submit(false); }}>
              Unblock
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Block this user?</DialogTitle>
          <DialogDescription>{user.name ?? user.username ?? user.telegramId} will lose access to the bot until unblocked.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="block-reason">Reason</Label>
          <Textarea id="block-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this user being blocked?" />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={submitting}
            onClick={() => {
              if (reason.trim().length < 5 || reason.trim().length > 240) {
                setError("Reason must be between 5 and 240 characters.");
                return;
              }
              submit(true, reason.trim());
            }}
          >
            Block user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
