"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/components/session-provider";
import { adminGet, adminMutate, newOperationId } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import { formatAge, type SyncHealth, type SyncStatus } from "@/lib/sentinel";

const HEALTH: Record<SyncHealth, { label: string; tone: "ok" | "warn" | "bad" | "idle" }> = {
  healthy: { label: "Reconciliation current", tone: "ok" },
  delayed: { label: "Reconciliation delayed", tone: "warn" },
  stale: { label: "Reconciliation stale", tone: "bad" },
  never_run: { label: "Waiting for the first check", tone: "idle" },
  disabled: { label: "Sentinel is off", tone: "idle" },
};

/** What the numbers on this page are worth right now. A failed check never leaves an old time looking fresh. */
export function SyncStatusBar({ initial }: { initial: SyncStatus | null }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [sync, setSync] = useState(initial);
  const [unreachable, setUnreachable] = useState(false);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    const poll = setInterval(async () => {
      if (document.hidden) return;
      try {
        setSync(await adminGet<SyncStatus>("/sentinel/sync"));
        setUnreachable(false);
      } catch {
        setUnreachable(true);
      }
    }, 30_000);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, []);

  async function runNow() {
    setRunning(true);
    try {
      const result = await adminMutate<{ skipped: string | null; evaluated: number; created: number; cleared: number }>("/sentinel/reconcile", "POST", csrfToken, { operationId: newOperationId() });
      if (result.skipped) toast.info("A check is already running. It will update this page when it finishes.");
      else toast.success(`Checked ${result.evaluated} wallets: ${result.created} new, ${result.cleared} cleared.`);
      setSync(await adminGet<SyncStatus>("/sentinel/sync"));
      router.refresh();
    } catch (error) {
      toast.error(describeError(error, "The check could not run."));
    } finally {
      setRunning(false);
    }
  }

  const health = unreachable ? { label: "Status unavailable", tone: "bad" as const } : HEALTH[sync?.health ?? "never_run"];
  const age = sync?.lastSuccessAt && now != null ? formatAge(now - new Date(sync.lastSuccessAt).getTime()) : null;
  const progress = sync?.totalUsers && sync.passUsers > 0 ? Math.min(100, Math.round((sync.passUsers / sync.totalUsers) * 100)) : null;
  const passDone = sync?.lastPassCompletedAt && now != null ? formatAge(now - new Date(sync.lastPassCompletedAt).getTime()) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground" role="status">
      <span className="inline-flex items-center gap-2 font-medium text-foreground">
        <span className="mf-signal" data-tone={health.tone} aria-hidden />
        {health.label}
      </span>
      {age ? <span>Last check {age}</span> : null}
      {sync?.enabled && sync.intervalSeconds ? <span className="hidden sm:inline">Every {Math.round(sync.intervalSeconds / 60) || 1} min, not real time</span> : null}
      {sync?.enabled && progress != null ? <span className="hidden md:inline">Full pass {progress}%</span> : null}
      {sync?.enabled && progress == null && passDone ? <span className="hidden md:inline">All wallets checked {passDone}</span> : null}
      {sync?.lastError ? <span className="text-warning">Last failure: {sync.lastError}</span> : null}
      {sync?.enabled ? (
        <Button variant="outline" size="sm" loading={running} onClick={runNow}>
          {running ? null : <RefreshCw aria-hidden />}
          {running ? "Checking…" : "Check now"}
        </Button>
      ) : null}
    </div>
  );
}
