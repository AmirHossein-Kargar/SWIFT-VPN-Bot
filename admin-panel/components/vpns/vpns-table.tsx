"use client";

import { useState } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { VpnDetailSheet } from "@/components/vpns/vpn-detail-sheet";
import type { AdminVpn } from "@/lib/types";
import { formatDateTime, formatNumber } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";

const STATUS_VARIANT: Record<AdminVpn["status"], "success" | "warning" | "destructive" | "muted" | "outline"> = {
  active: "success",
  expiring: "warning",
  expired: "destructive",
  revoked: "muted",
  unknown: "outline",
};

export function VpnsTable({ items }: { items: AdminVpn[] }) {
  const [activeClientId, setActiveClientId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (items.length === 0) {
    return <EmptyState title="No VPN services match these filters." />;
  }

  return (
    <>
      <Table stack label="VPN services">
        <TableHeader>
          <TableRow>
            <TableHead>Client ID</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Traffic</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((vpn) => (
            <TableRow
              key={vpn.clientId}
              className="cursor-pointer"
              onClick={() => {
                setActiveClientId(vpn.clientId);
                setOpen(true);
              }}
            >
              <TableCell wide className="font-medium">
                <button type="button" className="max-w-full text-left hover:underline">{vpn.clientId}</button>
              </TableCell>
              <TableCell label="Owner">
                <p>{vpn.ownerName ?? vpn.username ?? vpn.telegramId}</p>
                <p className="text-xs text-muted-foreground">{vpn.telegramId}</p>
              </TableCell>
              <TableCell label="Plan" className="max-w-44 truncate">{vpn.product ?? "—"}</TableCell>
              <TableCell label="Traffic">{vpn.trafficGb === 0 ? "Unlimited" : vpn.trafficGb != null ? `${formatNumber(vpn.trafficGb)} GB` : "—"}</TableCell>
              <TableCell label="Expires" className="text-muted-foreground">{formatDateTime(vpn.expiresAt)}</TableCell>
              <TableCell label="Status">
                <Badge variant={STATUS_VARIANT[vpn.status]}>{vpn.status}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <VpnDetailSheet clientId={activeClientId} open={open} onOpenChange={setOpen} />
    </>
  );
}
