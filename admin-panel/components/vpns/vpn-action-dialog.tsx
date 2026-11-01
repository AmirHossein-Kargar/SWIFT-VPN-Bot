"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminGet, adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError, type ProviderQuote } from "@/lib/types";
import { formatToman } from "@/lib/utils";

export type VpnAction = "disable" | "enable" | "revoke" | "extend-time" | "increase-traffic" | "renew";

const COPY: Record<VpnAction, { title: string; description: string; confirmLabel: string; destructive: boolean }> = {
  disable: { title: "Disable this service?", description: "The user loses access until it is re-enabled. Time and traffic are kept.", confirmLabel: "Disable", destructive: true },
  enable: { title: "Enable this service?", description: "The user regains access with the time and traffic it had.", confirmLabel: "Enable", destructive: false },
  revoke: { title: "Revoke this service?", description: "This permanently removes the VPN service from WizardXray and the user's account. WizardXray returns the unused value to the provider wallet, not to the customer. This cannot be undone.", confirmLabel: "Revoke", destructive: true },
  "extend-time": { title: "Extend subscription", description: "Add days to the current expiry date. This also reactivates a disabled service. The provider wallet is charged.", confirmLabel: "Extend", destructive: false },
  "increase-traffic": { title: "Increase traffic", description: "Add at least 1 GB to the current allowance. This also reactivates a disabled service. The provider wallet is charged.", confirmLabel: "Increase", destructive: false },
  renew: { title: "Renew this service", description: "Usage resets to zero and the days are added. The provider wallet is charged.", confirmLabel: "Renew", destructive: false },
};

/** The table in the document: what a renewal carries over depends on the conversion. Volume to unlimited loses the remainder. */
function renewalEffect(fromUnlimited: boolean, toUnlimited: boolean): string {
  if (toUnlimited && !fromUnlimited) return "The new period starts now. Remaining days and traffic of the current period are neither carried over nor refunded.";
  if (!toUnlimited && fromUnlimited) return "Remaining days are kept. Traffic becomes exactly the amount entered.";
  if (toUnlimited) return "Days are added to the current expiry.";
  return "Days are added to the current expiry, and the amount entered is added to the traffic left.";
}

export function VpnActionDialog({
  clientId,
  action,
  unlimited: serviceUnlimited = false,
  open,
  onOpenChange,
  onDone,
}: {
  clientId: string;
  action: VpnAction;
  unlimited?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { csrfToken } = useAdminSession();
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [renewDays, setRenewDays] = useState("");
  const [renewGig, setRenewGig] = useState("");
  const [renewUnlimited, setRenewUnlimited] = useState(serviceUnlimited);
  const [quote, setQuote] = useState<{ text: string; warn: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[action];
  const needsAmount = action === "extend-time" || action === "increase-traffic";
  const renewing = action === "renew";

  function reset() {
    setReason("");
    setAmount("");
    setRenewDays("");
    setRenewGig("");
    setRenewUnlimited(serviceUnlimited);
    setError(null);
  }

  // The provider's own quote for these terms, so the admin sees the real charge before confirming. A read: it buys nothing.
  useEffect(() => {
    if (!renewing) return;
    const days = Number(renewDays);
    const gig = Number(renewGig);
    setQuote(null);
    if (!Number.isSafeInteger(days) || days < 1 || (!renewUnlimited && (!Number.isFinite(gig) || gig < 0.5))) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      adminGet<ProviderQuote>("/provider/quote", { days, ...(renewUnlimited ? { unlimited: 1 } : { gig }) })
        .then((value) => { if (!cancelled) setQuote({ text: `WizardXray will charge ${formatToman(value.price)}${value.enough ? "." : ", which is more than the provider wallet holds."}`, warn: !value.enough }); })
        .catch((quoteError) => { if (!cancelled) setQuote({ text: quoteError instanceof AdminApiError ? quoteError.message : "The price could not be checked.", warn: true }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [renewing, renewDays, renewGig, renewUnlimited]);

  async function submit() {
    if (reason.trim().length < 5 || reason.trim().length > 240) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    const amountValue = Number(amount);
    if (needsAmount && (!Number.isFinite(amountValue) || amountValue <= 0)) {
      setError(action === "extend-time" ? "Enter a whole number of days." : "Enter a traffic amount of at least 1 GB (e.g. 10 or 2.5).");
      return;
    }
    if (renewing && (!Number.isSafeInteger(Number(renewDays)) || Number(renewDays) < 1)) {
      setError("Enter a whole number of days.");
      return;
    }
    if (renewing && !renewUnlimited && !(Number(renewGig) >= 0.5)) {
      setError("Enter a traffic amount of at least 0.5 GB, or choose unlimited.");
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
        ...(renewing ? { days: Number(renewDays), ...(renewUnlimited ? { unlimited: true } : { gig: Number(renewGig) }) } : {}),
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
          {renewing ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="vpn-renew-days">Days to add</Label>
                <Input id="vpn-renew-days" inputMode="numeric" value={renewDays} onChange={(event) => setRenewDays(event.target.value)} placeholder="30" />
              </div>
              <div className="flex items-center gap-2">
                <Switch id="vpn-renew-unlimited" checked={renewUnlimited} onCheckedChange={setRenewUnlimited} />
                <Label htmlFor="vpn-renew-unlimited" className="font-normal">Unlimited traffic</Label>
              </div>
              {renewUnlimited ? null : (
                <div className="space-y-1.5">
                  <Label htmlFor="vpn-renew-gig">Traffic (GB)</Label>
                  <Input id="vpn-renew-gig" inputMode="decimal" value={renewGig} onChange={(event) => setRenewGig(event.target.value)} placeholder="20" />
                </div>
              )}
              <p className="text-xs text-muted-foreground">{renewalEffect(serviceUnlimited, renewUnlimited)}</p>
              {quote ? <p className={quote.warn ? "text-xs text-warning" : "text-xs text-muted-foreground"} role="status">{quote.text}</p> : null}
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
          <Button variant={copy.destructive ? "destructive" : "default"} onClick={submit} loading={submitting}>
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
