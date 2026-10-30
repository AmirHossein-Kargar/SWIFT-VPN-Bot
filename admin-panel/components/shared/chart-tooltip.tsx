import type { TooltipProps } from "recharts";

import { formatDate, formatToman } from "@/lib/utils";

export interface ChartSeries { key: string; label: string; color: string; dashed?: boolean }

/** Short stroke keying a series: it matches the line, so solid and dashed stay distinct without colour. */
export function SeriesKey({ color, dashed = false }: { color: string; dashed?: boolean }) {
  return (
    <svg width="18" height="6" viewBox="0 0 18 6" aria-hidden className="shrink-0">
      <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} strokeLinecap="round" />
    </svg>
  );
}

/** One readout for every series at the hovered date: the value leads and the series name follows. */
export function ChartTooltip({ active, payload, label, series }: TooltipProps<number, string> & { series: ChartSeries[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 text-muted-foreground">{formatDate(String(label))}</p>
      <ul className="space-y-1">
        {series.map((entry) => {
          const point = payload.find((item) => item.dataKey === entry.key);
          if (!point) return null;
          return (
            <li key={entry.key} className="flex items-center gap-2">
              <SeriesKey color={entry.color} dashed={entry.dashed} />
              <span className="font-semibold tabular-nums">{formatToman(Number(point.value))}</span>
              <span className="text-muted-foreground">{entry.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
