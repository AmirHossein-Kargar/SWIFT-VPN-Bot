"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import type { AdminUser } from "@/lib/types";
import { formatToman } from "@/lib/utils";

const MAX_AMOUNT = 2_000_000_000;

/**
 * Credit and debit are separate entry points with separate copy and a review
 * step showing the before/after balance. Both go through the existing audited,
 * idempotent POST /users/:id/balance — an atomic $inc guarded by the
 * operationId, and for debits by balance >= amount (never overdraws).
 */
export function BalanceDialog({
  user,
  direction,
  open,
  onOpenChange,
  onDone,
}: {
  user: AdminUser;
  direction: "add" | "remove";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { csrfToken } = useAdminSession();
  const { operationId, rotate } = useOperationId();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"form" | "review">("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCredit = direction === "add";
  const amountValue = Number(amount.replace(/[,\s]/g, ""));
  const projected = isCredit ? user.balance + amountValue : user.balance - amountValue;
  const label = user.name ?? (user.username ? `@${user.username}` : user.telegramId);

  function review() {
    if (!Number.isInteger(amountValue) || amountValue < 1 || amountValue > MAX_AMOUNT) {
      setError("Enter a whole Toman amount between 1 and 2,000,000,000.");
      return;
    }
    if (!isCredit && amountValue > user.balance) {
      setError(`A debit cannot exceed the current balance (${formatToman(user.balance)}).`);
      return;
    }
    if (reason.trim().length < 5 || reason.trim().length > 240) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    setError(null);
    setStep("review");
  }

  async function confirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await adminMutate<{ balance: number; alreadyApplied?: boolean }>(`/users/${user.telegramId}/balance`, "POST", csrfToken, {
        operationId,
        amount: amountValue,
        direction,
        reason: reason.trim(),
      });
      toast.success(
        result.alreadyApplied
          ? `This ${isCredit ? "credit" : "debit"} was already applied. Balance: ${formatToman(result.balance)}.`
          : `${isCredit ? "Credited" : "Debited"} ${formatToman(amountValue)}. New balance: ${formatToman(result.balance)}.`
      );
      rotate();
      setAmount("");
      setReason("");
      setStep("form");
      onOpenChange(false);
      onDone?.();
    } catch (mutationError) {
      // Keep the same operationId so a retry cannot apply the change twice.
      setError(describeError(mutationError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) { onOpenChange(next); if (!next) setStep("form"); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isCredit ? "Credit wallet" : "Debit wallet"}</DialogTitle>
          <DialogDescription>
            {label} · current balance {formatToman(user.balance)}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="balance-amount">Amount to {isCredit ? "add" : "remove"} (Toman)</Label>
              <Input id="balance-amount" inputMode="numeric" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="50000" />
              {!isCredit ? <p className="text-xs text-muted-foreground">Debits never take a wallet below zero; larger amounts are refused.</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="balance-reason">Reason (kept in the audit log)</Label>
              <Textarea id="balance-reason" value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)} placeholder={isCredit ? "e.g. Compensation for outage on 12 Oct" : "e.g. Reversal of duplicated manual credit"} />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-center gap-3 rounded-md border border-border p-4 text-sm">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Before</p>
                <p className="font-medium">{formatToman(user.balance)}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <div className="text-center">
                <p className="text-xs text-muted-foreground">After</p>
                <p className="font-semibold">{formatToman(projected)}</p>
              </div>
            </div>
            <p className="text-sm">
              {isCredit ? "Add" : "Remove"} <span className="font-semibold">{formatToman(amountValue)}</span> {isCredit ? "to" : "from"} {label}&apos;s wallet.
            </p>
            <p className="text-xs text-muted-foreground">Reason: {reason.trim()}</p>
            <p className="text-xs text-muted-foreground">The final balance is computed by the server atomically and may differ if the wallet changes in the meantime.</p>
          </div>
        )}

        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <DialogFooter>
          {step === "form" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={review}>Review</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("form")} disabled={submitting}>Back</Button>
              <Button variant={isCredit ? "default" : "destructive"} onClick={confirm} disabled={submitting}>
                {submitting ? "Applying…" : isCredit ? `Credit ${formatToman(amountValue)}` : `Debit ${formatToman(amountValue)}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
