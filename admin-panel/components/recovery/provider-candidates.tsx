"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useAdminSession } from "@/components/session-provider";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { adminGet, adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError, type ProviderCandidates } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

type Settlement = { outcome: "created"; serviceUsername: string } | { outcome: "not_created" };

/**
 * An order whose create has an unknown outcome: check WizardXray, then settle it. Checking reads. Settling is a person's decision
 * and the server re-proves it: linking needs the live service to match the order, and a refund needs the provider's whole list to
 * show nothing. Nothing here can create a service or repeat a charge.
 */
export function ProviderCandidatesCheck({ purchaseId }: { purchaseId: string }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [state, setState] = useState<{ loading: boolean; result: ProviderCandidates | null; error: string | null }>({ loading: false, result: null, error: null });
  const [settling, setSettling] = useState<Settlement | null>(null);
  const [reason, setReason] = useState("");

  async function check() {
    setState({ loading: true, result: null, error: null });
    try {
      setState({ loading: false, result: await adminGet<ProviderCandidates>(`/provider/candidates/${encodeURIComponent(purchaseId)}`), error: null });
    } catch (error) {
      setState({ loading: false, result: null, error: error instanceof AdminApiError ? error.message : "The provider could not be checked." });
    }
  }

  async function settle() {
    if (!settling) return;
    // A fresh id each attempt: a refused action burns its operationId.
    await adminMutate(`/recovery/orders/${encodeURIComponent(purchaseId)}/settle`, "POST", csrfToken, { operationId: newOperationId(), reason: reason.trim(), ...settling });
    toast.success(settling.outcome === "created" ? "Service linked to the order." : "The customer was refunded.");
    setSettling(null);
    setReason("");
    router.refresh();
  }

  const { loading, result, error } = state;
  const canRefund = result && !result.settled && result.complete && !result.candidates.length;
  return (
    <div className="mt-1 space-y-1 text-xs">
      <Button variant="outline" size="sm" onClick={check} loading={loading}>Check provider</Button>
      <div role="status">
        {error ? <p className="text-destructive">{error}</p> : null}
        {result?.settled ? <p className="text-muted-foreground">This order already has a service.</p> : null}
        {result && !result.settled && !result.candidates.length ? (
          <p className="text-muted-foreground">No match in {result.scanned} provider rows{result.complete ? "" : " (not the whole list)"}. The list can lag by minutes, so this is not proof on its own.</p>
        ) : null}
        {result && !result.settled && result.candidates.length ? (
          <div className="space-y-1">
            <p className="font-medium text-warning">{result.candidates.length === 1 ? "Possible match, not proof:" : `${result.candidates.length} possible matches, not proof:`}</p>
            <ul className="space-y-1">
              {result.candidates.map((candidate) => (
                <li key={candidate.username} className="flex flex-wrap items-center gap-2">
                  <span><span className="font-mono">{candidate.username}</span> · {formatDateTime(candidate.createdAt)}</span>
                  <Button variant="outline" size="sm" onClick={() => setSettling({ outcome: "created", serviceUsername: candidate.username ?? "" })}>Link to this order</Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {canRefund ? <Button variant="destructive" size="sm" className="mt-1" onClick={() => setSettling({ outcome: "not_created" })}>Nothing was created: refund</Button> : null}
      </div>
      <ConfirmDialog
        open={settling !== null}
        onOpenChange={(open) => { if (!open) setSettling(null); }}
        title={settling?.outcome === "created" ? "Link this service to the order?" : "Refund the customer?"}
        destructive={settling?.outcome === "not_created"}
        confirmLabel={settling?.outcome === "created" ? "Link and deliver" : "Refund"}
        pendingLabel="Checking with WizardXray…"
        description={(
          <span className="block space-y-3">
            <span className="block">
              {settling?.outcome === "created"
                ? "The service goes to this customer and the debit already taken pays for it. Nothing is charged and no service is created. The server checks the live service first."
                : "The held amount returns to the customer's wallet. If a service does exist after all, it stays on WizardXray unpaid for by anyone, so look at the provider's list first. The server reads the whole list again before refunding."}
            </span>
            <span className="block space-y-1.5">
              <Label htmlFor={`settle-${purchaseId}`}>Reason, recorded in the audit log</Label>
              <Textarea id={`settle-${purchaseId}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What did you check?" />
            </span>
          </span>
        )}
        onConfirm={settle}
      />
    </div>
  );
}
