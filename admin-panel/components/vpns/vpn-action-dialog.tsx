"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";

export type VpnAction = "disable" | "revoke" | "extend-time" | "increase-traffic";

const COPY: Record<VpnAction, { title: string; description: string; confirmLabel: string; destructive: boolean }> = {
  disable: { title: "Disable this service?", description: "The user loses access until it is re-enabled.", confirmLabel: "Disable", destructive: true },
  revoke: { title: "Revoke this service?", description: "This permanently removes the VPN service from WizardXray and the user's account. This cannot be undone.", confirmLabel: "Revoke", destructive: true },
  "extend-time": { title: "Extend subscription", description: "Add days to the current expiry date.", confirmLabel: "Extend", destructive: false },
  "increase-traffic": { title: "Increase traffic", description: "Add gigabytes to the current traffic allowance.", confirmLabel: "Increase", destructive: false },
};

export function VpnActionDialog({
  clientId,
  action,
  open,
  onOpenChange,
  onDone,
}: {
  clientId: string;
  action: VpnAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { csrfToken } = useAdminSession();
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[action];
  const needsAmount = action === "extend-time" || action === "increase-traffic";

  function reset() {
    setReason("");
    setAmount("");
    setError(null);
  }

  async function submit() {
    if (reason.trim().length < 5 || reason.trim().length > 240) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    const amountValue = Number(amount);
    if (needsAmount && (!Number.isFinite(amountValue) || amountValue <= 0)) {
      setError(action === "extend-time" ? "Enter a whole number of days." : "Enter a traffic amount in GB (e.g. 10 or 2.5).");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminMutate(`/vpns/${clientId}/actions`, "POST", csrfToken, {
        operationId: newOperationId(),
        action,
        reason: reason.trim(),
        ...(action === "extend-time" ? { days: Math.round(amountValue) } : {}),
        ...(action === "increase-traffic" ? { gig: amountValue } : {}),
      });
      toast.success(`${copy.confirmLabel} succeeded for ${clientId}.`);
      onOpenChange(false);
      reset();
      onDone();
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
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {clientId} · {copy.description}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {needsAmount ? (
            <div className="space-y-1.5">
              <Label htmlFor="vpn-action-amount">{action === "extend-time" ? "Days to add" : "GB to add"}</Label>
              <Input
                id="vpn-action-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder={action === "extend-time" ? "30" : "10"}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="vpn-action-reason">Reason</Label>
            <Textarea id="vpn-action-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this action being taken?" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant={copy.destructive ? "destructive" : "default"} onClick={submit} disabled={submitting}>
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
