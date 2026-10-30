"use client";

import { useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { stripBasePath } from "@/lib/basePath";
import { useNavigate } from "@/components/shared/navigation-pending";

function useQueryUpdater() {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();

  return (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "" || value === "all") next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    navigate(`${pathname}?${next.toString()}`);
  };
}

export function UsersFilters({
  defaultSearch,
  activity,
  paying,
  blocked,
  sort,
}: {
  defaultSearch: string;
  activity: string;
  paying: string;
  blocked: string;
  sort: string;
}) {
  const update = useQueryUpdater();
  const [search, setSearch] = useState(defaultSearch);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSearch(defaultSearch);
  }, [defaultSearch]);

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => update({ search: value }), 350);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search by Telegram ID, username, or name"
          className="pl-8"
        />
      </div>
      <Select value={activity} onValueChange={(value) => update({ activity: value })}>
        <SelectTrigger className="w-44" aria-label="Filter by activity">
          <SelectValue placeholder="Activity" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All activity</SelectItem>
          <SelectItem value="active">Active (30d)</SelectItem>
          <SelectItem value="inactive">Inactive</SelectItem>
        </SelectContent>
      </Select>
      <Select value={paying} onValueChange={(value) => update({ paying: value })}>
        <SelectTrigger className="w-44" aria-label="Filter by paying status">
          <SelectValue placeholder="Paying" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All users</SelectItem>
          <SelectItem value="yes">Paying</SelectItem>
          <SelectItem value="no">Non-paying</SelectItem>
        </SelectContent>
      </Select>
      <Select value={blocked} onValueChange={(value) => update({ blocked: value })}>
        <SelectTrigger className="w-44" aria-label="Filter by block status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="no">Not blocked</SelectItem>
          <SelectItem value="yes">Blocked</SelectItem>
        </SelectContent>
      </Select>
      <Select value={sort} onValueChange={(value) => update({ sort: value })}>
        <SelectTrigger className="w-44" aria-label="Sort users">
          <SelectValue placeholder="Sort by" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="registered">Newest registered</SelectItem>
          <SelectItem value="activity">Last active</SelectItem>
          <SelectItem value="spending">Top spending</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
