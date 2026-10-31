"use client";

import { usePathname } from "next/navigation";
import { Activity, Gauge, ListChecks, Search, type LucideIcon } from "lucide-react";

import { ProgressLink } from "@/components/shared/progress-link";
import { stripBasePath } from "@/lib/basePath";
import { cn } from "@/lib/utils";

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/sentinel", label: "Overview", icon: Gauge },
  { href: "/sentinel/flow", label: "Live flow", icon: Activity },
  { href: "/sentinel/reconciliation", label: "Reconciliation", icon: ListChecks },
  { href: "/sentinel/transactions", label: "Transactions", icon: Search },
];

export function SentinelTabs() {
  const pathname = stripBasePath(usePathname());
  return (
    <nav aria-label="Money Flow Sentinel sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = href === "/sentinel" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <ProgressLink
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors [@media(pointer:coarse)]:min-h-10",
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </ProgressLink>
        );
      })}
    </nav>
  );
}
