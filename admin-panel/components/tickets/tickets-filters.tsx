"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { stripBasePath } from "@/lib/basePath";
import { STATUS_LABELS, TICKET_STATUSES } from "@/lib/tickets";

export function TicketsFilters({ defaultQuery, defaultStatus, defaultUnread }: { defaultQuery: string; defaultStatus: string; defaultUnread: boolean }) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(defaultQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setQuery(defaultQuery), [defaultQuery]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-3" dir="rtl">
      <Input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (timer.current) clearTimeout(timer.current);
          const value = event.target.value;
          timer.current = setTimeout(() => update({ q: value.trim() }), 350);
        }}
        placeholder="شماره تیکت، شناسه تلگرام یا موضوع"
        aria-label="جستجوی تیکت"
        className="w-72"
        dir="auto"
      />
      <select
        value={defaultStatus}
        onChange={(event) => update({ status: event.target.value })}
        aria-label="فیلتر وضعیت"
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="">همه وضعیت‌ها</option>
        {TICKET_STATUSES.map((status) => (
          <option key={status} value={status}>{STATUS_LABELS[status]}</option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={defaultUnread} onChange={(event) => update({ unread: event.target.checked ? "1" : null })} />
        فقط پیام‌های خوانده‌نشده
      </label>
    </div>
  );
}
