"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

import { Pagination } from "@/components/ui/pagination";
import { stripBasePath } from "@/lib/basePath";

export function PaginationNav({ page, pages }: { page: number; pages: number }) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();

  function onPageChange(nextPage: number) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("page", String(nextPage));
    router.push(`${pathname}?${next.toString()}`);
  }

  if (pages <= 1) return null;
  return <Pagination page={page} pages={pages} onPageChange={onPageChange} />;
}
