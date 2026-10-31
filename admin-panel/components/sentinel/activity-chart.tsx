"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from "recharts";

import { ChartTooltip, SeriesKey, type ChartSeries } from "@/components/shared/chart-tooltip";
import { chartTheme } from "@/lib/chartTheme";
import { formatDate, formatToman } from "@/lib/utils";
import { useReducedMotion } from "@/lib/use-reduced-motion";

const SERIES: ChartSeries[] = [
  { key: "inflow", label: "Credited", color: chartTheme.series1 },
  { key: "consumed", label: "Consumed", color: chartTheme.series2, dashed: true },
];

const tick = (bucket: "hour" | "day") => (value: string) => (bucket === "hour" ? value.slice(11) : formatDate(value));

export default function ActivityChart({ data, bucket }: { data: { t: string; inflow: number; consumed: number }[]; bucket: "hour" | "day" }) {
  const reducedMotion = useReducedMotion();
  if (!data.length) return <p className="grid h-full place-items-center text-sm text-muted-foreground">No credited or consumed money in this range.</p>;
  const totals = data.reduce((sum, point) => ({ inflow: sum.inflow + point.inflow, consumed: sum.consumed + point.consumed }), { inflow: 0, consumed: 0 });

  return (
    <div className="flex h-full w-full flex-col" role="group" aria-label={`Over ${data.length} periods: ${formatToman(totals.inflow)} credited, ${formatToman(totals.consumed)} consumed.`}>
      <div className="mb-2 flex gap-4 text-xs text-muted-foreground">
        {SERIES.map((series) => <span key={series.key} className="inline-flex items-center gap-2"><SeriesKey color={series.color} dashed={series.dashed} />{series.label}</span>)}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 12, left: 12, bottom: 0 }} accessibilityLayer>
            <defs>
              <linearGradient id="mfInflow" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chartTheme.series1} stopOpacity={0.28} />
                <stop offset="100%" stopColor={chartTheme.series1} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={chartTheme.grid} />
            <XAxis dataKey="t" tickFormatter={tick(bucket)} tick={chartTheme.axisTick} axisLine={{ stroke: chartTheme.grid }} tickLine={false} minTickGap={32} />
            <Tooltip cursor={chartTheme.cursor} content={<ChartTooltip series={SERIES} />} />
            <Area type="monotone" dataKey="inflow" stroke={chartTheme.series1} strokeWidth={2} fill="url(#mfInflow)" isAnimationActive={!reducedMotion} animationDuration={500} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} />
            <Area type="monotone" dataKey="consumed" stroke={chartTheme.series2} strokeWidth={2} strokeDasharray="5 4" fill="none" isAnimationActive={!reducedMotion} animationDuration={500} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
