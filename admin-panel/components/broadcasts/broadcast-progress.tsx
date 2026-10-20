"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/components/session-provider";
import { adminGet, adminMutate, newOperationId } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { BroadcastSummary } from "@/lib/types";

const ACTIVE_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const STATUS_VARIANT: Record<BroadcastSummary["status"], "success" | "destructive" | "warning" | "muted" | "outline"> = {
  queued: "outline",
  running: "warning",
  cancel_requested: "warning",
  cancelled: "muted",
  interrupted: "destructive",
  completed: "success",
  failed: "destructive",
};

export function BroadcastProgress({ operationId, onFinished }: { operationId: string; onFinished: () => void }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [status, setStatus] = useState<BroadcastSummary | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const data = await adminGet<BroadcastSummary>(`/broadcast/status/${operationId}`);
        if (cancelled) return;
        setStatus(data);
        if (ACTIVE_STATUSES.has(data.status)) {
          timer = setTimeout(poll, 2_000);
        } else {
          onFinished();
          router.refresh();
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 3_000);
      }
    }
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId]);

  async function cancel() {
    setCancelling(true);
    try {
      await adminMutate(`/broadcast/cancel/${operationId}`, "POST", csrfToken, { operationId: newOperationId() });
      toast.success("Cancellation requested.");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not cancel.");
    } finally {
      setCancelling(false);
    }
  }

  if (!status) return null;
  const pct = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm">Broadcast in progress</CardTitle>
        <Badge variant={STATUS_VARIANT[status.status]}>{status.status.replace(/_/g, " ")}</Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          {status.processed} / {status.total} processed · {status.succeeded} succeeded · {status.failed} failed
        </p>
        {ACTIVE_STATUSES.has(status.status) ? (
          <Button variant="outline" size="sm" onClick={cancel} disabled={cancelling || status.status === "cancel_requested"}>
            {status.status === "cancel_requested" ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
