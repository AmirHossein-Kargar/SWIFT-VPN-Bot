"use client";

import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { ChartTooltip, SeriesKey, type ChartSeries } from "@/components/shared/chart-tooltip";
import type { AnalyticsReport } from "@/lib/types";
import { cn, formatDate, formatToman } from "@/lib/utils";
import { chartTheme } from "@/lib/chartTheme";
import { useReducedMotion } from "@/lib/use-reduced-motion";

// The panel's palette is deliberately greyscale, so the second series is also dashed: identity never rests on tone alone.
const SERIES: ChartSeries[] = [
  { key: "topups", label: "Top-ups", color: chartTheme.series1 },
  { key: "sales", label: "Sales", color: chartTheme.series2, dashed: true },
];

export default function AnalyticsChart({ series }: { series: AnalyticsReport["series"] }) {
  const reducedMotion = useReducedMotion();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = SERIES.filter((entry) => !hidden.has(entry.key));
  const totalOf = (key: string) => series.reduce((sum, point) => sum + Number(point[key as "topups" | "sales"] || 0), 0);

  function toggle(key: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      // At least one series stays, so the chart is never blank.
      else if (next.size < SERIES.length - 1) next.add(key);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chart series">
        {SERIES.map((entry) => {
          const on = !hidden.has(entry.key);
          return (
            <button
              key={entry.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(entry.key)}
              className={cn("inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs transition-[opacity,background-color] duration-150 hover:bg-accent", !on && "opacity-55")}
            >
              <SeriesKey color={entry.color} dashed={entry.dashed} />
              <span>{entry.label}</span>
              <span className="font-semibold tabular-nums">{formatToman(totalOf(entry.key))}</span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1" role="group" aria-label={`${SERIES.map((entry) => `${entry.label} ${formatToman(totalOf(entry.key))}`).join(", ")} over ${series.length} periods.`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
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
            <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip series={visible} />} />
            {visible.map((entry) => (
              <Area
                key={entry.key}
                type="monotone"
                dataKey={entry.key}
                stroke={entry.color}
                strokeWidth={2}
                strokeDasharray={entry.dashed ? "6 4" : undefined}
                fill={`url(#${entry.key}Fill)`}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }}
                isAnimationActive={!reducedMotion}
                animationDuration={500}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
