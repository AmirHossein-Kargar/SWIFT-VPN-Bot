"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "@/components/shared/navigation-pending";
import { stripBasePath } from "@/lib/basePath";

export interface SelectFilter { kind: "select"; name: string; label: string; value: string; options: { value: string; label: string }[]; width?: string }
export interface TextFilter { kind: "text"; name: string; label: string; value: string; placeholder: string; pattern: string; width?: string; numeric?: boolean }
export type UrlFilter = SelectFilter | TextFilter;

function TextField({ filter, onApply }: { filter: TextFilter; onApply: (name: string, value: string) => void }) {
  const [value, setValue] = useState(filter.value);
  useEffect(() => setValue(filter.value), [filter.value]);
  const valid = value === "" || new RegExp(filter.pattern).test(value);
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (valid) onApply(filter.name, value); }}>
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value.trim())}
        onBlur={() => { if (valid && value !== filter.value) onApply(filter.name, value); }}
        placeholder={filter.placeholder}
        aria-label={filter.label}
        aria-invalid={!valid}
        inputMode={filter.numeric ? "numeric" : undefined}
        className={filter.width ?? "w-40"}
      />
    </form>
  );
}

/** Filters live in the URL, so a view can be linked, and an invalid value never reaches the server. */
export function UrlFilters({ filters }: { filters: UrlFilter[] }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();

  function apply(name: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") next.delete(name);
    else next.set(name, value);
    next.delete("page");
    next.delete("before");
    navigate(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {filters.map((filter) => (filter.kind === "select" ? (
        <Select key={filter.name} value={filter.value} onValueChange={(value) => apply(filter.name, value)}>
          <SelectTrigger className={filter.width ?? "w-44"} aria-label={filter.label}><SelectValue /></SelectTrigger>
          <SelectContent>{filter.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
      ) : <TextField key={filter.name} filter={filter} onApply={apply} />))}
    </div>
  );
}
