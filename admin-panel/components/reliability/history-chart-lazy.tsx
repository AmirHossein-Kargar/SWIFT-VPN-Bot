"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

/** Recharts stays out of the command center's bundle: only this tab loads it. */
export const HistoryChartLazy = dynamic(() => import("@/components/reliability/history-chart"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});
