"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import type { AnalyticsReport } from "@/lib/types";
import { formatDate, formatToman } from "@/lib/utils";
import { chartTheme } from "@/lib/chartTheme";

export default function AnalyticsChart({ series }: { series: AnalyticsReport["series"] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="topupsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chartTheme.series1} stopOpacity={0.25} />
            <stop offset="100%" stopColor={chartTheme.series1} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={chartTheme.series2} stopOpacity={0.25} />
            <stop offset="100%" stopColor={chartTheme.series2} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={chartTheme.grid} />
        <XAxis
          dataKey="start"
          tickFormatter={(value) => formatDate(value)}
          tick={chartTheme.axisTick}
          axisLine={{ stroke: chartTheme.grid }}
          tickLine={false}
          minTickGap={32}
        />
        <Tooltip
          {...chartTheme.tooltip}
          formatter={(value: number, name: string) => [formatToman(value), name === "topups" ? "Top-ups" : "Sales"]}
          labelFormatter={(value) => formatDate(value)}
        />
        <Area type="monotone" dataKey="topups" stroke={chartTheme.series1} strokeWidth={2} fill="url(#topupsFill)" />
        <Area type="monotone" dataKey="sales" stroke={chartTheme.series2} strokeWidth={2} fill="url(#salesFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
