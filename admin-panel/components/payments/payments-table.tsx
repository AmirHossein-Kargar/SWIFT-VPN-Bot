"use client";

import { useState } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { PaymentDetailSheet } from "@/components/payments/payment-detail-sheet";
import type { AdminPayment } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";

export function PaymentsTable({ items }: { items: AdminPayment[] }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No payments match these filters.</p>;
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
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
            <TableRow key={payment.key}>
              <TableCell>{payment.providerLabel}</TableCell>
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
    </>
  );
}
