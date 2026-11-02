"use client";

import { useState } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { AuditLogEntry } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";

export function AuditTable({ items }: { items: AuditLogEntry[] }) {
  const [viewing, setViewing] = useState<AuditLogEntry | null>(null);

  if (items.length === 0) {
    return <EmptyState title="No audit entries match these filters." />;
  }

  return (
    <>
      <Table stack label="Audit log">
        <TableHeader>
          <TableRow>
            <TableHead>Action</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>When</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((entry, index) => (
            <TableRow key={`${entry.actorTelegramId}-${entry.createdAt}-${index}`} className="cursor-pointer" onClick={() => setViewing(entry)}>
              <TableCell wide className="font-medium">
                <button type="button" className="max-w-full text-left hover:underline">{entry.action}</button>
              </TableCell>
              <TableCell label="Actor">{entry.actorTelegramId}</TableCell>
              <TableCell wide label="Target" className="max-w-56 truncate">
                {entry.targetType ?? "—"} {entry.targetId ? `· ${entry.targetId}` : ""}
              </TableCell>
              <TableCell label="Status">
                <Badge variant={entry.status === "success" ? "success" : entry.status === "failed" ? "destructive" : "outline"}>
                  {entry.status}
                </Badge>
              </TableCell>
              <TableCell label="When" className="text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Sheet open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewing?.action}</SheetTitle>
            <SheetDescription>{viewing ? formatDateTime(viewing.createdAt) : null}</SheetDescription>
          </SheetHeader>
          {viewing ? (
            <div className="mt-6 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-muted-foreground">Actor</p>
                  <p className="font-medium">{viewing.actorTelegramId}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">IP address</p>
                  <p className="font-medium">{viewing.ipAddress ?? "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Target</p>
                  <p className="font-medium">{viewing.targetType ?? "—"} {viewing.targetId ?? ""}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">{viewing.status}{viewing.errorCode ? ` (${viewing.errorCode})` : ""}</p>
                </div>
              </div>
              <div>
                <p className="mb-1 text-muted-foreground">Metadata</p>
                <ScrollRegion label="Metadata" className="rounded-md border border-border bg-muted/40">
                  <pre className="w-max min-w-full p-3 text-xs">{JSON.stringify(viewing.metadata ?? {}, null, 2)}</pre>
                </ScrollRegion>
              </div>
              {viewing.result ? (
                <div>
                  <p className="mb-1 text-muted-foreground">Result</p>
                  <ScrollRegion label="Result" className="rounded-md border border-border bg-muted/40">
                    <pre className="w-max min-w-full p-3 text-xs">{JSON.stringify(viewing.result, null, 2)}</pre>
                  </ScrollRegion>
                </div>
              ) : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
