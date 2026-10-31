import { AlertOctagon, AlertTriangle, CircleCheck, CircleDashed, Info, ShieldAlert, type LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { CLASSIFICATION_LABEL, REVIEW_LABEL, SEVERITY_LABEL, type Classification, type Review, type Severity } from "@/lib/sentinel";
import { cn } from "@/lib/utils";

const SEVERITY_STYLE: Record<Severity, { variant: "destructive" | "warning" | "secondary" | "muted"; icon: LucideIcon }> = {
  critical: { variant: "destructive", icon: AlertOctagon },
  high: { variant: "destructive", icon: ShieldAlert },
  medium: { variant: "warning", icon: AlertTriangle },
  low: { variant: "secondary", icon: Info },
  info: { variant: "muted", icon: Info },
};

/** Icon and word as well as colour: severity must survive colour blindness and a greyscale print. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const { variant, icon: Icon } = SEVERITY_STYLE[severity];
  return <Badge variant={variant} className="gap-1"><Icon className="h-3 w-3" aria-hidden />{SEVERITY_LABEL[severity]}</Badge>;
}

const CLASSIFICATION_ICON: Record<Classification, LucideIcon> = { confirmed: CircleCheck, probable: CircleDashed, informational: Info };

export function ClassificationBadge({ classification }: { classification: Classification }) {
  const Icon = CLASSIFICATION_ICON[classification];
  return <Badge variant="outline" className="gap-1"><Icon className="h-3 w-3" aria-hidden />{CLASSIFICATION_LABEL[classification]}</Badge>;
}

export function ReviewBadge({ review }: { review: Review }) {
  return <Badge variant={review === "new" ? "default" : "muted"}>{REVIEW_LABEL[review]}</Badge>;
}

/** Facts and inferences must never look alike. */
export function BasisTag({ basis, className }: { basis: "recorded" | "inferred" | "absent"; className?: string }) {
  const label = basis === "recorded" ? "Recorded" : basis === "inferred" ? "Inferred" : "No evidence";
  return (
    <span className={cn("mf-basis", className)} data-basis={basis}>
      {label}
    </span>
  );
}
