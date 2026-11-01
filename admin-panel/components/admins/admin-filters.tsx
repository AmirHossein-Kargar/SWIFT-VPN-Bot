"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "@/components/shared/navigation-pending";
import { stripBasePath } from "@/lib/basePath";

/** Filters live in the URL, as on Users and Audit: a filtered list can be reloaded or shared, and the server does the matching. */
export function AdminFilters({ defaultSearch, role, status }: { defaultSearch: string; role: string; status: string }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(defaultSearch);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setSearch(defaultSearch); }, [defaultSearch]);
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === "all") next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    navigate(query ? `${pathname}?${query}` : pathname);
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => update({ search: value.trim() }), 350);
  }

  return (
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-3 lg:flex-1 lg:basis-0">
      <div className="relative w-full sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search name, username or Telegram ID"
          aria-label="Search admins"
          maxLength={64}
          className="pl-8"
        />
      </div>
      <Select value={role} onValueChange={(value) => update({ role: value })}>
        <SelectTrigger className="min-w-0 flex-1 sm:w-40 sm:flex-none" aria-label="Filter by role">
          <SelectValue placeholder="Role" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All roles</SelectItem>
          <SelectItem value="owner">Owner</SelectItem>
          <SelectItem value="admin">Admin</SelectItem>
        </SelectContent>
      </Select>
      <Select value={status} onValueChange={(value) => update({ status: value })}>
        <SelectTrigger className="min-w-0 flex-1 sm:w-44 sm:flex-none" aria-label="Filter by account status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="blocked">Blocked in bot</SelectItem>
          <SelectItem value="removed">Removed</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
