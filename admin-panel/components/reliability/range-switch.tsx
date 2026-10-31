"use client";

import { RANGES, type RangeName } from "@/lib/reliability";

/** Four windows, all on screen. Each one is already measured, so switching needs no request. */
export function RangeSwitch({ value, onChange }: { value: RangeName; onChange: (range: RangeName) => void }) {
  return (
    <div className="inline-flex gap-1" role="group" aria-label="Time window">
      {RANGES.map((range) => (
        <button key={range.value} type="button" className="rf-toggle" aria-pressed={value === range.value} aria-label={range.long} onClick={() => onChange(range.value)}>{range.label}</button>
      ))}
    </div>
  );
}
