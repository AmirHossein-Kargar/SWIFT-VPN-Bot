"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import type { AdminUser } from "@/lib/types";

const MAX_LENGTH = 3500;
// Mirrors the header services/admin/userMessaging.js prepends (Persian, as all customer messages are).
const HEADER = "🔔 پیام از پشتیبانی";

export function MessageDialog({ user, open, onOpenChange }: { user: AdminUser; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { csrfToken } = useAdminSession();
  const { operationId, rotate } = useOperationId();
  const [message, setMessage] = useState("");
  const [step, setStep] = useState<"compose" | "confirm">("compose");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = user.name ?? (user.username ? `@${user.username}` : user.telegramId);
  const trimmed = message.trim();

  async function send() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await adminMutate<{ delivered: boolean; replayed?: boolean }>(`/users/${user.telegramId}/message`, "POST", csrfToken, { operationId, message: trimmed });
      if (!result.delivered) throw new Error("not delivered");
      toast.success(result.replayed ? "This message was already delivered; it was not sent again." : `Delivered to ${label} via Telegram.`);
      rotate();
      setMessage("");
      setStep("compose");
      onOpenChange(false);
    } catch (sendError) {
      setError(describeError(sendError, "The message was not delivered."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) { onOpenChange(next); if (!next) setStep("compose"); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Message {label}</DialogTitle>
          <DialogDescription>Sent once, by the Swift bot, to this user&apos;s private chat. It is recorded in the audit log.</DialogDescription>
        </DialogHeader>

        {step === "compose" ? (
          <div className="space-y-1.5">
            <Label htmlFor="user-message">Message</Label>
            <Textarea id="user-message" rows={6} maxLength={MAX_LENGTH} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Customers read Persian; write in the language they use with the bot." dir="auto" />
            <p className={`text-right text-xs ${message.length > MAX_LENGTH - 200 ? "text-warning" : "text-muted-foreground"}`}>
              {message.length.toLocaleString("en-US")} / {MAX_LENGTH.toLocaleString("en-US")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preview</p>
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-sm" dir="auto">
              <p className="font-semibold" dir="rtl">{HEADER}</p>
              <p className="mt-2">{trimmed}</p>
            </div>
            <p className="text-xs text-muted-foreground">Formatting is sent as plain text. A support-contact button is attached when one is configured.</p>
          </div>
        )}

        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

        <DialogFooter>
          {step === "compose" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => (trimmed ? (setError(null), setStep("confirm")) : setError("Enter a message."))}>Preview</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("compose")} disabled={submitting}>Edit</Button>
              <Button onClick={send} disabled={submitting}>{submitting ? "Sending…" : "Send message"}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
