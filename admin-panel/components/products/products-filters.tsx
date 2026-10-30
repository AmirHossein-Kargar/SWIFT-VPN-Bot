"use client";

import { useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { stripBasePath } from "@/lib/basePath";
import { SUBSCRIPTION_DURATION_DAYS } from "@/lib/subscription-durations";
import { useNavigate } from "@/components/shared/navigation-pending";

const STATUS_LABELS: Record<string, string> = {
  current: "Current (not archived)",
  live: "Live",
  disabled: "Off sale",
  hidden: "Hidden from storefront",
  archived: "Archived",
  all: "Everything",
};

export function ProductsFilters({ search: defaultSearch, status, duration }: { search: string; status: string; duration: string }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(defaultSearch);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setSearch(defaultSearch), [defaultSearch]);
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === "all" || (key === "status" && value === "current")) next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    const query = next.toString();
    navigate(query ? `${pathname}?${query}` : pathname);
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => update({ search: value.trim() }), 350);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search by name or ID" className="pl-8" aria-label="Search services" maxLength={80} />
      </div>
      <Select value={status} onValueChange={(value) => update({ status: value })}>
        <SelectTrigger className="w-52" aria-label="Filter by availability">
          <SelectValue placeholder="Availability" />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(STATUS_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={duration} onValueChange={(value) => update({ duration: value })}>
        <SelectTrigger className="w-40" aria-label="Filter by duration">
          <SelectValue placeholder="Duration" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any duration</SelectItem>
          {SUBSCRIPTION_DURATION_DAYS.map((days) => (
            <SelectItem key={days} value={String(days)}>{days} days</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
