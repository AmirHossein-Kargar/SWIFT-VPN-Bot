import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-2 rounded-full border text-sm font-bold", {
  variants: {
    variant: {
      brand: "border-border-strong bg-brand/10 px-3 py-1.5 text-[13px] text-brand",
      chip: "min-h-11 border-border-strong bg-card px-4 text-sm text-foreground",
      chipMuted: "min-h-11 border-border-strong bg-card px-4 text-sm font-semibold text-foreground opacity-70",
    },
  },
  defaultVariants: { variant: "brand" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
