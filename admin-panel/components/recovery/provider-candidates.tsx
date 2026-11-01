"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { adminGet } from "@/lib/adminApi.client";
import { AdminApiError, type ProviderCandidates } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

/**
 * For an order whose create has an unknown outcome: does WizardXray list a service nobody here knows, with these terms, from
 * around that time? It reads and reports. A match is a lead and no match proves nothing, because the list lags and two orders can
 * share terms, so the wording keeps the decision with the admin and nothing here settles the order.
 */
export function ProviderCandidatesCheck({ purchaseId }: { purchaseId: string }) {
  const [state, setState] = useState<{ loading: boolean; result: ProviderCandidates | null; error: string | null }>({ loading: false, result: null, error: null });

  async function check() {
    setState({ loading: true, result: null, error: null });
    try {
      setState({ loading: false, result: await adminGet<ProviderCandidates>(`/provider/candidates/${encodeURIComponent(purchaseId)}`), error: null });
    } catch (error) {
      setState({ loading: false, result: null, error: error instanceof AdminApiError ? error.message : "The provider could not be checked." });
    }
  }

  const { loading, result, error } = state;
  return (
    <div className="mt-1 space-y-1 text-xs">
      <Button variant="outline" size="sm" onClick={check} loading={loading}>Check provider</Button>
      <div role="status">
        {error ? <p className="text-destructive">{error}</p> : null}
        {result?.settled ? <p className="text-muted-foreground">This order already has a service.</p> : null}
        {result && !result.settled && !result.candidates.length ? (
          <p className="text-muted-foreground">No match in {result.scanned} provider rows{result.complete ? "" : " (not the whole list)"}. This does not prove nothing was created: the list can lag.</p>
        ) : null}
        {result && !result.settled && result.candidates.length ? (
          <div>
            <p className="font-medium text-warning">{result.candidates.length === 1 ? "Possible match, not proof:" : `${result.candidates.length} possible matches, not proof:`}</p>
            <ul>
              {result.candidates.map((candidate) => <li key={candidate.username}><span className="font-mono">{candidate.username}</span> · {formatDateTime(candidate.createdAt)}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
