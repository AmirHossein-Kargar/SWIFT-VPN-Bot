"use client";

import { usePathname } from "next/navigation";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "@/components/shared/navigation-pending";
import { stripBasePath } from "@/lib/basePath";
import { RANGE_OPTIONS } from "@/lib/sentinel";

export function RangePicker({ range }: { range: string }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  return (
    <Select value={range} onValueChange={(value) => navigate(`${pathname}?range=${value}`)}>
      <SelectTrigger className="w-44" aria-label="Time range"><SelectValue /></SelectTrigger>
      <SelectContent>{RANGE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}
