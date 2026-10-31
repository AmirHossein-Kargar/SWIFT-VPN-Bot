"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";

import { chartTheme } from "@/lib/chartTheme";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { formatRate, type HistoryPoint } from "@/lib/reliability";
import { formatDateTime, formatNumber } from "@/lib/utils";

type Metric = "perMinute" | "errors" | "p95Ms";
type Row = HistoryPoint & { perMinute: number | null };
const MANY_POINTS = 12;

const time = (value: string) => new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

function PointTooltip({ active, payload, label, unit, rate }: TooltipProps<number, string> & { unit: string; rate: boolean }) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-0.5 text-muted-foreground">{formatDateTime(String(label))}</p>
      <p><span className="font-semibold tabular-nums">{value == null ? "No data" : rate ? formatRate(value) : formatNumber(value)}</span>{value == null ? null : <span className="text-muted-foreground"> {unit}</span>}</p>
    </div>
  );
}

/**
 * One series, one axis. A null is a gap in the line: a bucket with no measurement must not read as zero. Throughput is per
 * measured minute, because a count would show the unfinished last bucket as a sudden fall in traffic.
 */
export default function HistoryChart({ points, metric, unit, tone = "brand" }: { points: HistoryPoint[]; metric: Metric; unit: string; tone?: "brand" | "bad" }) {
  const reducedMotion = useReducedMotion();
  const color = tone === "bad" ? "hsl(var(--destructive))" : chartTheme.series1;
  const gradient = `rfHistory-${metric}`;
  const rows: Row[] = points.map((point) => ({ ...point, perMinute: point.requests == null ? null : point.requests / Math.max(1, point.measured) }));
  const present = rows.filter((point) => point[metric] != null).length;
  if (!present) return <p className="grid h-full place-items-center text-sm text-muted-foreground">No data in this window.</p>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.24} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={chartTheme.grid} />
        <XAxis dataKey="t" tickFormatter={time} tick={chartTheme.axisTick} axisLine={{ stroke: chartTheme.grid }} tickLine={false} minTickGap={40} />
        <YAxis width={40} allowDecimals={metric === "perMinute"} tick={chartTheme.axisTick} axisLine={false} tickLine={false} />
        <Tooltip cursor={chartTheme.cursor} content={<PointTooltip unit={unit} rate={metric === "perMinute"} />} />
        <Area type="monotone" dataKey={metric} connectNulls={false} stroke={color} strokeWidth={2} fill={`url(#${gradient})`} dot={present <= MANY_POINTS ? { r: 2.5, fill: color, strokeWidth: 0 } : false} isAnimationActive={!reducedMotion} animationDuration={400} activeDot={{ r: 4, strokeWidth: 2, stroke: "hsl(var(--card))" }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
