import { STATE_LABEL, type ComponentHealth, type HealthState } from "@/lib/reliability";

const SIZE = 200;
const CENTER = SIZE / 2;
const RADIUS = 78;
const GAP_DEG = 5;

function arc(startDeg: number, endDeg: number) {
  const point = (deg: number) => {
    const radians = ((deg - 90) * Math.PI) / 180;
    return `${(CENTER + RADIUS * Math.cos(radians)).toFixed(2)} ${(CENTER + RADIUS * Math.sin(radians)).toFixed(2)}`;
  };
  return `M ${point(startDeg)} A ${RADIUS} ${RADIUS} 0 0 1 ${point(endDeg)}`;
}

/**
 * The hero: one segment per component, coloured by its state. It is a small map rather than a decoration, and a CSS tilt with
 * two stacked plates gives it depth. The text beside it says the same thing, so nothing depends on seeing the colours.
 */
export function StatusCore({ components, overall }: { components: ComponentHealth[]; overall: HealthState }) {
  const verified = components.filter((item) => item.state === "healthy").length;
  const step = 360 / Math.max(1, components.length);
  return (
    <div className="rf-core" data-state={overall} aria-hidden>
      <span className="rf-core-plate" />
      <span className="rf-core-plate" />
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="rf-core-ring">
        {components.map((component, index) => (
          <path key={component.id} d={arc(index * step + GAP_DEG / 2, (index + 1) * step - GAP_DEG / 2)} className="rf-core-segment" data-state={component.state}>
            <title>{`${component.label}: ${STATE_LABEL[component.state]}`}</title>
          </path>
        ))}
        <text x={CENTER} y={CENTER - 2} textAnchor="middle" className="rf-core-count">{verified}/{components.length}</text>
        <text x={CENTER} y={CENTER + 18} textAnchor="middle" className="rf-core-caption">verified</text>
      </svg>
    </div>
  );
}
