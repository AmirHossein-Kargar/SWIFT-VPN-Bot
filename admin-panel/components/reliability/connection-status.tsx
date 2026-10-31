"use client";

import { RefreshCw } from "lucide-react";

import { Age } from "@/components/reliability/age";
import { useFeed } from "@/components/reliability/feed-provider";
import { Button } from "@/components/ui/button";
import { CONNECTION_LABEL } from "@/lib/reliability";

const selectConnection = (state: { connection: keyof typeof CONNECTION_LABEL }) => state.connection;

/** What the numbers on this page are worth right now. "Live" appears only with a live connection and a recent monitor run. */
export function ConnectionStatus() {
  const connection = useFeed(selectConnection);
  const lastTickAt = useFeed((state) => state.snapshot?.monitoring.lastTickAt ?? null);
  const failures = useFeed((state) => state.failures);
  const view = CONNECTION_LABEL[connection];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" role="status" data-testid="connection" data-state={connection}>
      <span className="inline-flex items-center gap-2 font-medium text-foreground" title={view.detail}>
        <span className="mf-signal" data-tone={view.tone} aria-hidden />
        {view.label}
      </span>
      <span>Monitor ran <Age at={lastTickAt} fallback="not yet" /></span>
      {failures > 0 ? <span className="text-warning">{failures} failed {failures === 1 ? "attempt" : "attempts"}, retrying</span> : null}
      {connection === "signed_out" ? (
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}><RefreshCw aria-hidden />Sign in again</Button>
      ) : null}
    </div>
  );
}
