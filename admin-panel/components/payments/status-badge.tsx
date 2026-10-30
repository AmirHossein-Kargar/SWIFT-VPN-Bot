import { Badge } from "@/components/ui/badge";
import { ChangeFlash } from "@/components/shared/change-flash";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive" | "muted"> = {
  pending: "warning",
  paid: "default",
  fulfilled: "success",
  failed: "destructive",
  cancelled: "muted",
  refunded: "secondary",
  "recovery-required": "destructive",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  fulfilled: "Fulfilled",
  failed: "Failed",
  cancelled: "Cancelled",
  refunded: "Refunded",
  "recovery-required": "Needs recovery",
};

export function PaymentStatusBadge({ status }: { status: string }) {
  return <ChangeFlash value={status}><Badge variant={STATUS_VARIANT[status] ?? "outline"}>{STATUS_LABEL[status] ?? status}</Badge></ChangeFlash>;
}
