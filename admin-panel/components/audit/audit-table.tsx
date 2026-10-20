"use client";

import { useState } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { AuditLogEntry } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function AuditTable({ items }: { items: AuditLogEntry[] }) {
  const [viewing, setViewing] = useState<AuditLogEntry | null>(null);

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No audit entries match these filters.</p>;
  }

  return (
    <>
      <Table>
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
              <TableCell className="font-medium">{entry.action}</TableCell>
              <TableCell>{entry.actorTelegramId}</TableCell>
              <TableCell className="max-w-56 truncate">
                {entry.targetType ?? "—"} {entry.targetId ? `· ${entry.targetId}` : ""}
              </TableCell>
              <TableCell>
                <Badge variant={entry.status === "success" ? "success" : entry.status === "failed" ? "destructive" : "outline"}>
                  {entry.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
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
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                  {JSON.stringify(viewing.metadata ?? {}, null, 2)}
                </pre>
              </div>
              {viewing.result ? (
                <div>
                  <p className="mb-1 text-muted-foreground">Result</p>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
                    {JSON.stringify(viewing.result, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
