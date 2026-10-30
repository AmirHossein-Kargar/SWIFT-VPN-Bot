"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Inbox, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNavigate } from "@/components/shared/navigation-pending";
import { stripBasePath } from "@/lib/basePath";

/** Empty list. When filters are what emptied it, it offers the way out. */
export function EmptyState({ title, hint, icon: Icon = Inbox }: { title: string; hint?: string; icon?: LucideIcon }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const filtered = [...searchParams.keys()].some((key) => key !== "page");

  return (
    <div className="animate-in fade-in-0 flex flex-col items-center gap-2 px-6 py-12 text-center duration-300">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground"><Icon className="h-5 w-5" aria-hidden /></span>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
      {filtered ? <Button variant="outline" size="sm" className="mt-1" onClick={() => navigate(pathname)}>Clear filters</Button> : null}
    </div>
  );
}
