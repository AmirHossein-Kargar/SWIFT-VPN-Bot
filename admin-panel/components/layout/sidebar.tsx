"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, CreditCard, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { stripBasePath } from "@/lib/basePath";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/users", label: "Users", icon: Users },
  { href: "/payments", label: "Payments", icon: CreditCard },
];

const LEGACY_SECTIONS = [
  "VPNs", "Recovery", "Custody", "Products", "Broadcasts",
  "Analytics", "Audit log", "Admins", "Mock tests", "System health",
];

export function Sidebar() {
  const pathname = stripBasePath(usePathname());

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card/40 lg:flex">
      <div className="flex h-14 items-center gap-2 border-b border-border px-5">
        <ShieldAlert className="h-5 w-5 text-primary" />
        <span className="text-sm font-semibold">SWIFT Admin</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <Separator className="my-4" />
        <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Not yet migrated</p>
        <ul className="mt-2 space-y-1">
          {LEGACY_SECTIONS.map((label) => (
            <li key={label} className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-muted-foreground/60">
              <span>{label}</span>
              <Badge variant="muted" className="text-[10px]">Soon</Badge>
            </li>
          ))}
        </ul>
        <a href="/panel" className="mt-3 block px-3 text-xs text-primary hover:underline">
          Open legacy panel for these sections →
        </a>
      </nav>
    </aside>
  );
}
