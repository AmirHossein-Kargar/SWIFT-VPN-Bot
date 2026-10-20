"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { AdminUser } from "@/lib/types";

export function BalanceDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setAmount("");
    setReason("");
    setDirection("add");
    setError(null);
  }

  async function handleSubmit() {
    const amountValue = Number(amount);
    if (!Number.isInteger(amountValue) || amountValue < 1 || amountValue > 2_000_000_000) {
      setError("Enter a whole Toman amount between 1 and 2,000,000,000.");
      return;
    }
    if (reason.trim().length < 5 || reason.trim().length > 240) {
      setError("Reason must be between 5 and 240 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminMutate(`/users/${user.telegramId}/balance`, "POST", csrfToken, {
        operationId: newOperationId(),
        amount: amountValue,
        direction,
        reason: reason.trim(),
      });
      toast.success(`Balance ${direction === "add" ? "increased" : "decreased"} for ${user.telegramId}.`);
      onOpenChange(false);
      reset();
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
          <DialogTitle>Adjust balance</DialogTitle>
          <DialogDescription>
            {user.name ?? user.username ?? user.telegramId} · current balance {user.balance.toLocaleString("en-US")} Toman
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Direction</Label>
            <Select value={direction} onValueChange={(value) => setDirection(value as "add" | "remove")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="add">Add funds</SelectItem>
                <SelectItem value="remove">Remove funds</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="amount">Amount (Toman)</Label>
            <Input id="amount" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="50000" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Reason</Label>
            <Textarea id="reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is this adjustment being made?" />
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
