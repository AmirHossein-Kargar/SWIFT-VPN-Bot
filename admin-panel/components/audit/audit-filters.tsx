"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { stripBasePath } from "@/lib/basePath";

export function AuditFilters({
  defaultAction,
  defaultActor,
  defaultTarget,
}: {
  defaultAction: string;
  defaultActor: string;
  defaultTarget: string;
}) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [action, setAction] = useState(defaultAction);
  const [actor, setActor] = useState(defaultActor);
  const [target, setTarget] = useState(defaultTarget);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setAction(defaultAction), [defaultAction]);
  useEffect(() => setActor(defaultActor), [defaultActor]);
  useEffect(() => setTarget(defaultTarget), [defaultTarget]);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    router.push(`${pathname}?${next.toString()}`);
  }

  function debounced(patch: Record<string, string>) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => update(patch), 350);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        value={action}
        onChange={(event) => { setAction(event.target.value.toUpperCase()); debounced({ action: event.target.value.toUpperCase() }); }}
        placeholder="Action (e.g. VPN_REVOKED)"
        className="w-56"
      />
      <Input
        value={actor}
        onChange={(event) => { setActor(event.target.value); debounced({ actor: event.target.value }); }}
        placeholder="Actor Telegram ID"
        className="w-48"
      />
      <Input
        value={target}
        onChange={(event) => { setTarget(event.target.value); debounced({ target: event.target.value }); }}
        placeholder="Target ID"
        className="w-48"
      />
    </div>
  );
}
