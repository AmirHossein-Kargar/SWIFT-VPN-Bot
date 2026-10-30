"use client";

import { useState } from "react";

import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";

/**
 * Confirmation for a destructive or financially sensitive action. It stays open with a spinner until the server has
 * answered and closes only on success; a failure stays here as an inline error, so a dismissed dialog never implies the
 * action happened. It cannot be dismissed mid-request, and a second click cannot start a second request.
 *
 * Callers report the outcome (the toast) themselves, after their own request resolves.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel = "Working…",
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!submitting) { setError(null); onOpenChange(next); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild><div>{description}</div></AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="animate-in fade-in-0 text-sm text-destructive" role="alert">{error}</p> : null}
        <AlertDialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => { setError(null); onOpenChange(false); }}>Cancel</Button>
          <Button variant={destructive ? "destructive" : "default"} loading={submitting} onClick={confirm}>
            {submitting ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
