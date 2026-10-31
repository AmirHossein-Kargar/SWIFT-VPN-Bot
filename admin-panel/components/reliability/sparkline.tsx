/** A plain SVG trend: no chart library, so a card update stays cheap. Drawn only when there is something to show. */
export function Sparkline({ values, tone = "brand", label }: { values: number[]; tone?: "brand" | "warn" | "bad"; label: string }) {
  if (!values.length || values.every((value) => value === 0)) return null;
  const max = Math.max(...values, 1);
  const width = 120;
  const height = 28;
  const step = width / Math.max(1, values.length - 1);
  const y = (value: number) => (height - 2 - ((value / max) * (height - 4))).toFixed(1);
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"} ${(index * step).toFixed(1)} ${y(value)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="rf-spark" data-tone={tone} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`${line} L ${width} ${height} L 0 ${height} Z`} className="rf-spark-fill" />
      <path d={line} className="rf-spark-line" />
    </svg>
  );
}
