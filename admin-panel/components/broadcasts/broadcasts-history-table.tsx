import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { BroadcastSummary } from "@/lib/types";
import { formatDateTime, formatNumber } from "@/lib/utils";

const STATUS_VARIANT: Record<BroadcastSummary["status"], "success" | "destructive" | "warning" | "muted" | "outline"> = {
  queued: "outline",
  running: "warning",
  cancel_requested: "warning",
  cancelled: "muted",
  interrupted: "destructive",
  completed: "success",
  failed: "destructive",
};

export function BroadcastsHistoryTable({ items }: { items: BroadcastSummary[] }) {
  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No broadcasts sent yet.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Audience</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((broadcast) => (
          <TableRow key={broadcast.operationId}>
            <TableCell className="font-medium">{broadcast.audience}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[broadcast.status]}>{broadcast.status.replace(/_/g, " ")}</Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatNumber(broadcast.succeeded)} sent · {formatNumber(broadcast.failed)} failed / {formatNumber(broadcast.total)}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDateTime(broadcast.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
