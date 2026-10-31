"use client";

import { usePathname } from "next/navigation";
import { Clock3, History, Network, Route, Siren, type LucideIcon } from "lucide-react";

import { ProgressLink } from "@/components/shared/progress-link";
import { useFeed } from "@/components/reliability/feed-provider";
import { stripBasePath } from "@/lib/basePath";
import { cn, formatNumber } from "@/lib/utils";

const TABS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/reliability", label: "Command center", icon: Network },
  { href: "/reliability/incidents", label: "Incidents", icon: Siren },
  { href: "/reliability/events", label: "Events", icon: Clock3 },
  { href: "/reliability/orders", label: "Order trace", icon: Route },
  { href: "/reliability/history", label: "History", icon: History },
];

export function ReliabilityTabs() {
  const pathname = stripBasePath(usePathname());
  const openIncidents = useFeed((state) => state.snapshot?.incidents.openCount ?? 0);
  return (
    <nav aria-label="Service Reliability sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {TABS.map(({ href, label, icon: Icon }) => {
        const active = href === "/reliability" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
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
            {href === "/reliability/incidents" && openIncidents > 0 ? <span className="rf-count" aria-label={`${formatNumber(openIncidents)} open`}>{formatNumber(openIncidents)}</span> : null}
          </ProgressLink>
        );
      })}
    </nav>
  );
}
