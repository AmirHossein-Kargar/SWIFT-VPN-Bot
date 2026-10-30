// Recharts accepts CSS color strings in its props, so referencing the design
// tokens here makes every chart follow the active light/dark theme without
// re-rendering on theme change.
export const chartTheme = {
  series1: "hsl(var(--chart-1))",
  series2: "hsl(var(--chart-2))",
  grid: "hsl(var(--border))",
  axisTick: { fill: "hsl(var(--muted-foreground))", fontSize: 11 },
  cursor: { stroke: "hsl(var(--muted-foreground))", strokeWidth: 1, strokeDasharray: "3 3" },
  label: { fill: "hsl(var(--foreground))", fontSize: 11, fontWeight: 600 },
  tooltip: {
    contentStyle: {
      background: "hsl(var(--popover))",
      border: "1px solid hsl(var(--border))",
      borderRadius: 8,
      fontSize: 12,
      color: "hsl(var(--popover-foreground))",
    },
    labelStyle: { color: "hsl(var(--muted-foreground))" },
    itemStyle: { color: "hsl(var(--popover-foreground))" },
  },
} as const;
