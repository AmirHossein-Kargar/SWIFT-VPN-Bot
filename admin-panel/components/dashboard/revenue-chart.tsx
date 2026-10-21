"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { formatToman, formatDate } from "@/lib/utils";
import { chartTheme } from "@/lib/chartTheme";

/** Chart body only; the surrounding Card is a Server Component (revenue-card.tsx). */
export default function RevenueChart({ data }: { data: { date: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chartTheme.series1} stopOpacity={0.25} />
            <stop offset="100%" stopColor={chartTheme.series1} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={chartTheme.grid} />
        <XAxis
          dataKey="date"
          tickFormatter={(value) => formatDate(value)}
          tick={chartTheme.axisTick}
          axisLine={{ stroke: chartTheme.grid }}
          tickLine={false}
          minTickGap={32}
        />
        <Tooltip
          {...chartTheme.tooltip}
          formatter={(value: number) => [formatToman(value), "Revenue"]}
          labelFormatter={(value) => formatDate(value)}
        />
        <Area type="monotone" dataKey="value" stroke={chartTheme.series1} strokeWidth={2} fill="url(#revenueFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
