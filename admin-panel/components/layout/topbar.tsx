"use client";

import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { LogOut, Menu, User as UserIcon, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbPage } from "@/components/ui/breadcrumb";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate } from "@/lib/adminApi.client";
import { stripBasePath } from "@/lib/basePath";
import { NAV_SECTIONS } from "@/components/layout/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

function pageTitle(pathname: string): string {
  for (const section of NAV_SECTIONS) {
    const match = section.items.find((item) => item.href === pathname);
    if (match) return match.label;
  }
  return "Swift VPN Admin";
}

export function Topbar() {
  const { actorTelegramId, csrfToken } = useAdminSession();
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  const title = pageTitle(pathname);
  const [signingOut, setSigningOut] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await adminMutate("/auth/logout", "POST", csrfToken);
      router.push("/sign-in");
      router.refresh();
    } catch {
      toast.error("Sign-out failed. Please try again.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem className="hidden sm:inline-flex">
              <span className="text-muted-foreground">Admin</span>
            </BreadcrumbItem>
            <BreadcrumbItem className="hidden sm:inline-flex">
              <span className="text-muted-foreground">/</span>
            </BreadcrumbItem>
            <BreadcrumbItem>
              <BreadcrumbPage>{title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2">
              <UserIcon className="h-4 w-4" />
              <span className="hidden sm:inline">{actorTelegramId}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
            <DropdownMenuItem disabled className="opacity-100">
              <ShieldCheck className="h-4 w-4" />
              {actorTelegramId}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleSignOut} disabled={signingOut}>
              <LogOut className="h-4 w-4" />
              {signingOut ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="right" className="w-72 p-0">
          <SheetHeader className="border-b border-border px-5 py-4">
            <SheetTitle className="flex items-center gap-2.5">
              <Logo height={24} />
              <span className="sr-only">Admin navigation</span>
            </SheetTitle>
          </SheetHeader>
          <nav className="overflow-y-auto px-3 py-4">
            {NAV_SECTIONS.map((section) => (
              <div key={section.label} className="mb-4">
                <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </p>
                <ul className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = pathname === item.href;
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setMobileNavOpen(false)}
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
        </SheetContent>
      </Sheet>
    </header>
  );
}
