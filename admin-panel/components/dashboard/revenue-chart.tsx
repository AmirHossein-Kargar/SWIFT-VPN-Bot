"use client";

import { Area, AreaChart, CartesianGrid, ReferenceDot, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { ChartTooltip, type ChartSeries } from "@/components/shared/chart-tooltip";
import { formatDate, formatToman } from "@/lib/utils";
import { chartTheme } from "@/lib/chartTheme";
import { useReducedMotion } from "@/lib/use-reduced-motion";

const SERIES: ChartSeries[] = [{ key: "value", label: "Revenue", color: chartTheme.series1 }];

/** Chart body only; the surrounding Card is a Server Component (revenue-card.tsx). */
export default function RevenueChart({ data }: { data: { date: string; value: number }[] }) {
  const reducedMotion = useReducedMotion();
  const peak = data.reduce((best, point) => (point.value > best.value ? point : best), data[0] ?? { date: "", value: 0 });
  const total = data.reduce((sum, point) => sum + point.value, 0);

  return (
    <div className="h-full w-full" role="group" aria-label={`Revenue over ${data.length} days: ${formatToman(total)} in total, highest ${formatToman(peak.value)} on ${formatDate(peak.date)}.`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 20, right: 12, left: 12, bottom: 0 }} accessibilityLayer>
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
          <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip series={SERIES} />} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={chartTheme.series1}
            strokeWidth={2}
            fill="url(#revenueFill)"
            activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }}
            isAnimationActive={!reducedMotion}
            animationDuration={500}
          />
          {peak.value > 0 ? (
            <ReferenceDot
              x={peak.date}
              y={peak.value}
              r={3}
              fill={chartTheme.series1}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              label={{ value: formatToman(peak.value), position: "top", ...chartTheme.label }}
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
