"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import { deletionReason } from "@/lib/paymentDeletion";
import { AdminApiError, type PaymentDeletionPreview, type PaymentDeletionResult } from "@/lib/types";

/**
 * Two-step permanent deletion. Step 1 asks the server which of the selected
 * records are deletable right now; the confirm button only enables when ALL
 * are. The server re-validates every record again when the delete is sent, so
 * nothing here (selection, counts, eligibility hints) is trusted.
 */
export function PaymentDeleteDialog({ keys, open, onOpenChange, onDone }: { keys: string[]; open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { csrfToken } = useAdminSession();
  const { operationId, rotate } = useOperationId();
  const [preview, setPreview] = useState<PaymentDeletionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setError(null);
    setLoading(true);
    adminMutate<PaymentDeletionPreview>("/payments/delete-preview", "POST", csrfToken, { keys })
      .then((data) => { if (!cancelled) setPreview(data); })
      .catch((previewError) => { if (!cancelled) setError(describeError(previewError)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, keys, csrfToken]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await adminMutate<PaymentDeletionResult>("/payments/delete", "POST", csrfToken, { operationId, keys, confirmCount: keys.length });
      if (result.skipped.length) toast.warning(`${result.deleted} deleted, ${result.skipped.length} skipped because they changed meanwhile.`);
      else toast.success(`${result.deleted} payment record${result.deleted === 1 ? "" : "s"} deleted.`);
      rotate();
      onOpenChange(false);
      onDone();
    } catch (deleteError) {
      const details = deleteError instanceof AdminApiError ? deleteError.details : undefined;
      if (details?.length) {
        setPreview((current) => current && {
          ...current,
          eligible: current.requested - details.length,
          ineligible: details.length,
          items: current.items.map((item) => {
            const blockedItem = details.find((detail) => detail.key === item.key);
            return blockedItem ? { ...item, eligible: false, code: blockedItem.code, reason: blockedItem.reason } : item;
          }),
        });
      }
      setError(describeError(deleteError));
    } finally {
      setSubmitting(false);
    }
  }

  const blocked = preview?.items.filter((item) => !item.eligible) ?? [];
  const canDelete = Boolean(preview) && blocked.length === 0 && !loading;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Delete {keys.length} payment record{keys.length === 1 ? "" : "s"}?</DialogTitle>
          <DialogDescription>
            This permanently removes the selected top-up records. Wallet balances, purchases and the audit log are not changed.
            A minimal tombstone is kept so a late provider notification is recorded and never credits a wallet.
          </DialogDescription>
        </DialogHeader>
        {loading ? <p className="text-sm text-muted-foreground" role="status">Checking eligibility…</p> : null}
        {preview && blocked.length === 0 ? (
          <p className="text-sm">All {preview.requested} selected records are eligible. Pending records must be older than {preview.minPendingAgeHours}h and past any provider expiry.</p>
        ) : null}
        {blocked.length ? (
          <div className="space-y-2 text-sm" role="alert">
            <p className="font-medium text-destructive">{blocked.length} selected record{blocked.length === 1 ? " is" : "s are"} not deletable, so nothing will be deleted:</p>
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {blocked.map((item) => (
                <li key={item.key} className="break-all text-muted-foreground"><span className="font-mono text-foreground">{item.key}</span> — {deletionReason(item.code)}</li>
              ))}
            </ul>
            <p className="text-muted-foreground">Close this dialog, deselect them and try again.</p>
          </div>
        ) : null}
        {error && !blocked.length ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" disabled={!canDelete || submitting} onClick={submit}>
            {submitting ? "Deleting…" : `Delete ${keys.length} record${keys.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
