"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import { REVIEW_LABEL, findingReport, type FindingDetail, type Review } from "@/lib/sentinel";
import { AdminApiError } from "@/lib/types";

const NEXT_STATES: Record<Review, Review[]> = {
  new: ["investigating", "remediation_proposed", "resolved", "false_positive"],
  investigating: ["remediation_proposed", "resolved", "false_positive"],
  remediation_proposed: ["investigating", "resolved", "false_positive"],
  resolved: ["investigating"],
  false_positive: ["investigating"],
};

const ACTION_LABEL: Partial<Record<Review, string>> = {
  investigating: "Start investigating",
  remediation_proposed: "Record a proposed fix",
  resolved: "Mark resolved",
  false_positive: "Dismiss",
};

const ACTION_HELP: Partial<Record<Review, string>> = {
  investigating: "Tells other admins someone is on this.",
  remediation_proposed: "Records the decision. Nothing runs here: the correction happens in the tool you name, with its own confirmation and audit entry.",
  resolved: "The server rechecks the records first and refuses while the problem still reproduces.",
  false_positive: "Takes this out of the totals. If the evidence changes later, it comes back.",
};

/** Records a human decision about a finding. It writes a review note and an audit entry, and it cannot move money. */
export function FindingReview({ finding }: { finding: FindingDetail }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const { operationId, rotate } = useOperationId();
  const [target, setTarget] = useState<Review | null>(null);
  const [reason, setReason] = useState("");
  const [optionId, setOptionId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsOption = target === "remediation_proposed";
  const ready = reason.trim().length >= 10 && (!needsOption || optionId !== "");

  async function submit() {
    if (!target || !ready || pending) return;
    setPending(true);
    setError(null);
    try {
      await adminMutate(`/sentinel/findings/${finding.id}/review`, "POST", csrfToken, { operationId, review: target, reason: reason.trim(), optionId: needsOption ? optionId : undefined });
      rotate();
      toast.success(`Marked ${REVIEW_LABEL[target].toLowerCase()}.`);
      setTarget(null);
      setReason("");
      setOptionId("");
      router.refresh();
    } catch (failure) {
      // A refusal is final, so the next decision is a new operation. A lost response keeps its id: resending is then safe.
      if (failure instanceof AdminApiError && failure.status >= 400 && failure.status < 500) rotate();
      setError(describeError(failure, "The decision was not recorded."));
    } finally {
      setPending(false);
    }
  }

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(findingReport(finding));
      toast.success("Evidence report copied.");
    } catch {
      toast.error("The browser refused access to the clipboard.");
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {NEXT_STATES[finding.review].map((state) => (
        <Button key={state} size="sm" variant={state === "false_positive" ? "outline" : "secondary"} onClick={() => { setTarget(state); setError(null); }}>
          {ACTION_LABEL[state]}
        </Button>
      ))}
      <Button size="sm" variant="ghost" onClick={copyReport}><Copy aria-hidden />Copy report</Button>

      <Dialog open={target != null} onOpenChange={(open) => { if (!open && !pending) setTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{target ? ACTION_LABEL[target] : ""}</DialogTitle>
            <DialogDescription>{target ? ACTION_HELP[target] : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {needsOption ? (
              <div className="space-y-1.5">
                <Label htmlFor="mf-option">Proposed fix</Label>
                <Select value={optionId} onValueChange={setOptionId}>
                  <SelectTrigger id="mf-option"><SelectValue placeholder="Choose an option" /></SelectTrigger>
                  <SelectContent>{finding.explanation.options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="mf-reason">Reason</Label>
              <Textarea id="mf-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={400} rows={3} placeholder="What you checked and what you decided (at least 10 characters)" />
            </div>
            {error ? <p className="animate-in fade-in-0 text-sm text-destructive" role="alert">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setTarget(null)}>Cancel</Button>
            <Button loading={pending} disabled={!ready} onClick={submit}>{pending ? "Saving…" : "Save decision"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
