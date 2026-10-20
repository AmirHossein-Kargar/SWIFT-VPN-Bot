"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { stripBasePath } from "@/lib/basePath";

const STATUSES = ["all", "pending", "paid", "fulfilled", "failed", "cancelled", "refunded", "recovery-required"];
const PROVIDERS = ["all", "hooshpay", "nowpayments", "bank", "trx", "wallet"];
const PROVIDER_LABEL: Record<string, string> = {
  all: "All providers",
  hooshpay: "HooshPay",
  nowpayments: "NOWPayments",
  bank: "Bank transfer",
  trx: "TRX (legacy)",
  wallet: "Wallet (order)",
};

export function PaymentsFilters({
  defaultSearch,
  status,
  provider,
}: {
  defaultSearch: string;
  status: string;
  provider: string;
}) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(defaultSearch);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setSearch(defaultSearch), [defaultSearch]);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === "all") next.delete(key);
      else next.set(key, value);
    }
    next.delete("page");
    router.push(`${pathname}?${next.toString()}`);
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => update({ search: value }), 350);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search by ID, order, or tracking code" className="pl-8" />
      </div>
      <Select value={status} onValueChange={(value) => update({ status: value })}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {value === "all" ? "All statuses" : value.replace("-", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={provider} onValueChange={(value) => update({ provider: value })}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="Provider" />
        </SelectTrigger>
        <SelectContent>
          {PROVIDERS.map((value) => (
            <SelectItem key={value} value={value}>
              {PROVIDER_LABEL[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
