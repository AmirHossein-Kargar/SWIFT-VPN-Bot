"use client";

import { useRouter, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogOut, Menu, User as UserIcon, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbPage } from "@/components/ui/breadcrumb";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate } from "@/lib/adminApi.client";
import { stripBasePath } from "@/lib/basePath";
import { NAV_SECTIONS, NavLinks } from "@/components/layout/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/brand/logo";

function pageTitle(pathname: string): string {
  for (const section of NAV_SECTIONS) {
    const match = section.items.find((item) => item.href === pathname || (item.href !== "/" && pathname.startsWith(`${item.href}/`)));
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
  const menuButton = useRef<HTMLButtonElement>(null);

  // The drawer belongs to one page and to narrow screens: browser back and a rotated tablet must not leave it open.
  useEffect(() => setMobileNavOpen(false), [pathname]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const close = (event: MediaQueryListEvent) => { if (event.matches) setMobileNavOpen(false); };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);

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
    <header className="sticky top-0 z-40 flex min-h-14 items-center justify-between gap-2 border-b border-border bg-card px-4 pt-[env(safe-area-inset-top)] sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          ref={menuButton}
          variant="ghost"
          size="icon"
          className="shrink-0 lg:hidden"
          aria-label="Open navigation"
          aria-expanded={mobileNavOpen}
          aria-controls="mobile-navigation"
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
      <div className="flex shrink-0 items-center gap-2">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2" aria-label={`Account menu, signed in as ${actorTelegramId}`}>
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
        {/* Controlled, so Radix has no trigger to give focus back to. */}
        <SheetContent
          id="mobile-navigation"
          side="left"
          aria-describedby={undefined}
          className="flex w-72 max-w-[85vw] flex-col p-0"
          onCloseAutoFocus={(event) => { event.preventDefault(); menuButton.current?.focus(); }}
        >
          <SheetHeader className="shrink-0 border-b border-border px-5 py-4 pt-[max(1rem,env(safe-area-inset-top))]">
            <SheetTitle className="flex items-center gap-2.5">
              <Logo height={24} />
              <span className="sr-only">Admin navigation</span>
            </SheetTitle>
          </SheetHeader>
          <nav aria-label="Admin sections" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <NavLinks touch onNavigate={() => setMobileNavOpen(false)} />
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  );
}
