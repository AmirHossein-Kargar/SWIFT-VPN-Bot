"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate, newOperationId } from "@/lib/adminApi.client";
import { ProviderCandidatesCheck } from "@/components/recovery/provider-candidates";
import { AdminApiError } from "@/lib/types";
import type { RecoveryItem } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";
import { ShieldCheck } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

const PROVIDER_LABEL: Record<RecoveryItem["provider"], string> = {
  hooshpay: "HooshPay",
  nowpayments: "NOWPayments",
  bank: "Bank transfer",
  trx: "TRX (legacy)",
  wallet: "Order",
};

export function RecoveryTable({ items }: { items: RecoveryItem[] }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | "all" | null>(null);

  const safeItems = items.filter((item) => item.retrySafe);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function retry(keys?: string[]) {
    try {
      const result = await adminMutate<{ attempted: number; succeeded: number; failed: { key: string; code: string }[] }>(
        "/recovery/retry-safe",
        "POST",
        csrfToken,
        { operationId: newOperationId(), ...(keys ? { keys } : {}) }
      );
      if (result.failed.length > 0) {
        toast.warning(`${result.succeeded}/${result.attempted} retried successfully; ${result.failed.length} still failing.`);
      } else if (result.attempted === 0) {
        toast.info("Nothing eligible to retry right now.");
      } else {
        toast.success(`${result.succeeded}/${result.attempted} retried successfully.`);
      }
      setSelected(new Set());
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Retry failed.");
    }
  }

  if (items.length === 0) {
    return <EmptyState title="Nothing needs attention right now." hint="Stuck payments and orders appear here." icon={ShieldCheck} />;
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-border p-4">
        <p className="text-sm text-muted-foreground">
          {safeItems.length} of {items.length} on this page can be retried automatically.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={selected.size === 0} onClick={() => setConfirming([...selected])}>
            Retry selected ({selected.size})
          </Button>
          <Button size="sm" disabled={safeItems.length === 0} onClick={() => setConfirming("all")}>
            Retry all safe items
          </Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Provider</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Last event</TableHead>
            <TableHead>Retries</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.key}>
              <TableCell>
                <Checkbox checked={selected.has(item.key)} disabled={!item.retrySafe} onCheckedChange={() => toggle(item.key)} aria-label={`Select ${item.key}`} />
              </TableCell>
              <TableCell>{PROVIDER_LABEL[item.provider]}</TableCell>
              <TableCell>{item.userId}</TableCell>
              <TableCell>{formatToman(item.amount)}</TableCell>
              <TableCell>
                <Badge variant={item.retrySafe ? "warning" : "destructive"}>{item.kind.replace(/-/g, " ")}</Badge>
                {item.kind === "provisioning-uncertain" ? <ProviderCandidatesCheck purchaseId={item.key.slice("wallet:".length)} /> : null}
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(item.lastEventAt)}</TableCell>
              <TableCell className="text-muted-foreground">
                {item.retryCount > 0 ? `${item.retryCount} (last ${formatDateTime(item.lastRetryAt)})` : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
        title={confirming === "all" ? "Retry all safe items?" : `Retry ${confirming?.length ?? 0} selected item${confirming?.length === 1 ? "" : "s"}?`}
        description="Only items the server marks as safe are retried, and each runs through the normal idempotent payment path. The result is reported per item."
        confirmLabel="Retry"
        pendingLabel="Retrying…"
        onConfirm={() => retry(confirming === "all" || confirming === null ? undefined : confirming)}
      />
    </>
  );
}
