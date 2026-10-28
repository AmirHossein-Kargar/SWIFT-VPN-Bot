"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Globe,
  CreditCard,
  RotateCcw,
  Package,
  Coins,
  Megaphone,
  BarChart3,
  ScrollText,
  UserCog,
  FlaskConical,
  Activity,
  Settings,
  LifeBuoy,
  Gift,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { stripBasePath } from "@/lib/basePath";

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard };
type NavSection = { label: string; items: NavItem[] };

const NAV_SECTIONS: NavSection[] = [
  { label: "Overview", items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Operations",
    items: [
      { href: "/users", label: "Users", icon: Users },
      { href: "/vpns", label: "VPN services", icon: Globe },
      { href: "/payments", label: "Payments", icon: CreditCard },
      { href: "/recovery", label: "Recovery", icon: RotateCcw },
      { href: "/tickets", label: "Support tickets", icon: LifeBuoy },
    ],
  },
  {
    label: "Catalog & finance",
    items: [
      { href: "/products", label: "Service catalog", icon: Package },
      { href: "/custody", label: "Custody", icon: Coins },
    ],
  },
  {
    label: "Engagement",
    items: [
      { href: "/broadcasts", label: "Broadcasts", icon: Megaphone },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/referrals", label: "Referrals", icon: Gift },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/audit", label: "Audit log", icon: ScrollText },
      { href: "/admins", label: "Admins", icon: UserCog },
      { href: "/mock-tests", label: "Mock tests", icon: FlaskConical },
      { href: "/system-health", label: "System health", icon: Activity },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const pathname = stripBasePath(usePathname());

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card lg:flex">
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-5">
        <Logo height={24} />
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Admin</span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mb-4">
            <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(`${item.href}/`));
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export { NAV_SECTIONS };
