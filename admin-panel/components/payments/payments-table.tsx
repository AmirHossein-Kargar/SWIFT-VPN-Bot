"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { PaymentDetailSheet } from "@/components/payments/payment-detail-sheet";
import { PaymentDeleteDialog } from "@/components/payments/payment-delete-dialog";
import type { AdminPayment } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";
import { deletionReason } from "@/lib/paymentDeletion";
import { EmptyState } from "@/components/shared/empty-state";

export function PaymentsTable({ items }: { items: AdminPayment[] }) {
  const router = useRouter();
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Hint only: the server decides again at preview time and at delete time.
  const selectable = useMemo(() => items.filter((payment) => payment.deletion?.eligible), [items]);
  const selectedKeys = useMemo(() => items.filter((payment) => selected.has(payment.key)).map((payment) => payment.key), [items, selected]);
  const allSelected = selectable.length > 0 && selectable.every((payment) => selected.has(payment.key));

  function toggle(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key); else next.delete(key);
      return next;
    });
  }

  if (items.length === 0) {
    return <EmptyState title="No payments match these filters." hint="Try a different status or provider." />;
  }

  return (
    <>
      {selectable.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-sm">
          <span className="text-muted-foreground" aria-live="polite">
            {selectedKeys.length ? `${selectedKeys.length} selected` : `${selectable.length} deletable on this page`}
          </span>
          <Button variant="destructive" size="sm" disabled={selectedKeys.length === 0} onClick={() => setDeleteOpen(true)}>
            <Trash2 className="mr-1.5 h-4 w-4" aria-hidden /> Delete selected
          </Button>
        </div>
      ) : null}
      {/* Phones: one stacked card per record so amount, status and actions are never hidden behind a sideways scroll. */}
      <ul className="divide-y md:hidden" aria-label="Payments">
        {items.map((payment) => (
          <li key={payment.key} className="space-y-2 p-4" data-state={selected.has(payment.key) ? "selected" : undefined}>
            <div className="flex items-start gap-3">
              <Checkbox
                className="mt-1"
                aria-label={`Select ${payment.providerLabel} payment ${payment.id}`}
                checked={selected.has(payment.key)}
                disabled={!payment.deletion?.eligible}
                onCheckedChange={(checked) => toggle(payment.key, checked === true)}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{payment.providerLabel}</span>
                  <PaymentStatusBadge status={payment.status} />
                </div>
                <p className="break-all font-mono text-xs text-muted-foreground">{payment.id}</p>
                {payment.trackingCode ? <p className="break-all font-mono text-xs text-muted-foreground">ref {payment.trackingCode}</p> : null}
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-sm">
                  <div><dt className="text-xs text-muted-foreground">Amount</dt><dd>{formatToman(payment.amount)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">User</dt><dd className="break-all">{payment.userId}</dd></div>
                  <div className="col-span-2"><dt className="text-xs text-muted-foreground">Created</dt><dd>{formatDateTime(payment.createdAt)}</dd></div>
                </dl>
                {!payment.deletion?.eligible && payment.deletion?.code ? <p className="text-xs text-muted-foreground">Not deletable: {deletionReason(payment.deletion.code)}</p> : null}
              </div>
            </div>
            <Button variant="outline" size="sm" className="w-full" onClick={() => { setActiveKey(payment.key); setOpen(true); }}>
              View details
            </Button>
          </li>
        ))}
      </ul>
      <Table className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label="Select all deletable payments on this page"
                checked={allSelected}
                disabled={selectable.length === 0}
                onCheckedChange={(checked) => setSelected(checked === true ? new Set(selectable.map((payment) => payment.key)) : new Set())}
              />
            </TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Product</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((payment) => (
            <TableRow key={payment.key} data-state={selected.has(payment.key) ? "selected" : undefined}>
              <TableCell>
                <Checkbox
                  aria-label={`Select ${payment.providerLabel} payment ${payment.id}`}
                  checked={selected.has(payment.key)}
                  disabled={!payment.deletion?.eligible}
                  title={payment.deletion?.eligible ? undefined : deletionReason(payment.deletion?.code)}
                  onCheckedChange={(checked) => toggle(payment.key, checked === true)}
                />
              </TableCell>
              <TableCell>
                {payment.providerLabel}
                <span className="block max-w-56 break-all font-mono text-xs text-muted-foreground" title={payment.id}>{payment.id}</span>
                {payment.trackingCode ? <span className="block break-all font-mono text-xs text-muted-foreground">ref {payment.trackingCode}</span> : null}
              </TableCell>
              <TableCell>{payment.userId}</TableCell>
              <TableCell className="max-w-48 truncate">{payment.product}</TableCell>
              <TableCell>{formatToman(payment.amount)}</TableCell>
              <TableCell>
                <PaymentStatusBadge status={payment.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(payment.createdAt)}</TableCell>
              <TableCell>
                <Button variant="outline" size="sm" onClick={() => { setActiveKey(payment.key); setOpen(true); }}>
                  View
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaymentDetailSheet paymentKey={activeKey} open={open} onOpenChange={setOpen} />
      <PaymentDeleteDialog
        keys={selectedKeys}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDone={() => { setSelected(new Set()); router.refresh(); }}
      />
    </>
  );
}
