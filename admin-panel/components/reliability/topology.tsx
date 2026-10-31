"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

import { Age } from "@/components/reliability/age";
import { useFeedStore } from "@/components/reliability/feed-provider";
import { EdgeParticles, useInView, useSceneTilt, type ParticleEdge } from "@/components/shared/scene-motion";
import { NODE_LABEL, NODE_POSITION, STATE_LABEL, STATE_TONE, VIEW_HEIGHT, VIEW_WIDTH, edgePath, edgeWidth, formatRate, highlightSet, trafficDots, type ComponentHealth, type ComponentId, type TopologyEdge } from "@/lib/reliability";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";

interface Selection { node: ComponentId | null; path: ComponentId[] | null }

const EXTERNAL: ComponentId[] = ["telegram", "hooshpay", "nowpayments", "wizardxray"];
const DATA: ComponentId[] = ["mongodb", "redis"];

function summary(component: ComponentHealth): string {
  return `${component.label}: ${STATE_LABEL[component.state]}. ${component.reason}`;
}

/**
 * The real system as one tilted plane. Plain SVG for the links, real buttons for the nodes, compositor-run dots for traffic:
 * no canvas loop and no 3D library, the same technique as Sentinel's money paths. Every dot stands for traffic this process
 * measured in the last 15 minutes. A quiet link has none, and a link nothing can measure stays still whatever it carries.
 */
export const Topology = memo(function Topology({ components, edges, selection, onSelect }: { components: ComponentHealth[]; edges: TopologyEdge[]; selection: Selection; onSelect: (id: ComponentId | null) => void }) {
  const reducedMotion = useReducedMotion();
  const scene = useRef<HTMLDivElement>(null);
  const visible = useInView(scene);
  const store = useFeedStore();
  const nodes = useRef(new Map<string, HTMLElement>());
  const [hovered, setHovered] = useState<ComponentId | null>(null);
  useSceneTilt(scene, reducedMotion);

  const highlight = useMemo(() => highlightSet(edges, selection), [edges, selection]);
  const particles = useMemo<ParticleEdge[]>(() => edges.map((edge) => ({ id: edge.id, path: edgePath(edge), particles: trafficDots(edge), tone: edge.tone === "return" ? "return" : "normal" })), [edges]);

  // A short flash on the node an event belongs to, on the compositor and outside React, so a burst re-renders nothing.
  useEffect(() => {
    if (reducedMotion) return;
    return store.onEvents((events) => {
      for (const event of events.slice(-8)) {
        nodes.current.get(event.component)?.animate(
          [{ opacity: 0.85, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.16)" }],
          { duration: 700, easing: "ease-out" },
        );
      }
    });
  }, [store, reducedMotion]);

  const tip = hovered ? components.find((item) => item.id === hovered) : null;
  const tipEdge = NODE_POSITION[hovered ?? "orders"];

  return (
    <div className="mf-stage" ref={scene} data-paused={visible ? undefined : "true"} data-testid="topology">
      <div className="mf-scene rf-scene">
        <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <pattern id="rf-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="hsl(var(--brand))" strokeOpacity="0.09" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#rf-grid)" />
          {edges.map((edge) => (
            <path
              key={edge.id}
              d={edgePath(edge)}
              className="mf-edge rf-edge"
              data-active={edge.measured && edge.count ? "true" : undefined}
              data-tone={edge.tone}
              data-kind={edge.kind}
              data-lit={highlight?.edges.has(edge.id) ? "true" : undefined}
              data-dim={highlight && !highlight.edges.has(edge.id) ? "true" : undefined}
              style={{ strokeWidth: edgeWidth(edge) }}
            />
          ))}
        </svg>
        {reducedMotion ? null : <EdgeParticles edges={particles} paused={!visible} width={VIEW_WIDTH} height={VIEW_HEIGHT} />}
        {components.map((component) => {
          const position = NODE_POSITION[component.id];
          const dim = highlight && !highlight.nodes.has(component.id);
          return (
            <button
              key={component.id}
              type="button"
              className={cn("rf-node", EXTERNAL.includes(component.id) && "rf-node-external", DATA.includes(component.id) && "rf-node-data")}
              style={{ left: `${(position.x / VIEW_WIDTH) * 100}%`, top: `${(position.y / VIEW_HEIGHT) * 100}%` }}
              data-state={component.state}
              data-dim={dim ? "true" : undefined}
              data-node={component.id}
              aria-pressed={selection.node === component.id}
              aria-label={`${summary(component)}${component.incidents ? ` ${component.incidents} open ${component.incidents === 1 ? "incident" : "incidents"}.` : ""} Opens details.`}
              onClick={() => onSelect(selection.node === component.id ? null : component.id)}
              onPointerEnter={() => setHovered(component.id)}
              onPointerLeave={() => setHovered(null)}
              onFocus={() => setHovered(component.id)}
              onBlur={() => setHovered(null)}
            >
              <span className="mf-node-plate" aria-hidden />
              <span className="mf-node-plate" aria-hidden />
              <span className="rf-node-face">
                <span className="rf-node-title"><span className="mf-signal" data-tone={STATE_TONE[component.state]} aria-hidden /><span className="truncate">{NODE_LABEL[component.id]}</span></span>
                <span className="rf-node-state">{STATE_LABEL[component.state]}{component.evidence === "probe" && component.latencyMs != null ? ` · ${component.latencyMs} ms` : ""}</span>
              </span>
              {component.incidents ? <span className="rf-node-badge" aria-hidden>{component.incidents}</span> : null}
              <span className="rf-node-flash" ref={(element) => { if (element) nodes.current.set(component.id, element); else nodes.current.delete(component.id); }} aria-hidden />
            </button>
          );
        })}
        {tip ? (
          <div className="rf-tip" role="tooltip" style={{ left: `${Math.min(84, Math.max(16, (tipEdge.x / VIEW_WIDTH) * 100))}%`, top: `${(tipEdge.y / VIEW_HEIGHT) * 100}%` }} data-flip={tipEdge.y < 130 ? "true" : undefined}>
            <p className="font-medium">{tip.label}: {STATE_LABEL[tip.state]}</p>
            <p className="text-muted-foreground">{tip.reason}</p>
            <p className="text-muted-foreground">Checked <Age at={tip.checkedAt} fallback="never" />{tip.incidents ? ` · ${tip.incidents} open` : ""}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** The same system with no picture: the phone layout, and the plain alternative for anyone who prefers it. */
export function TopologyList({ components, edges, selection, onSelect }: { components: ComponentHealth[]; edges: TopologyEdge[]; selection: Selection; onSelect: (id: ComponentId | null) => void }) {
  const groups = [...new Set(components.map((item) => item.group))];
  const highlight = highlightSet(edges, selection);
  return (
    <div className="space-y-4" data-testid="topology-list">
      {groups.map((group) => (
        <section key={group} aria-label={group}>
          <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</h3>
          <ul className="space-y-1.5">
            {components.filter((item) => item.group === group).map((component) => (
              <li key={component.id}>
                <button
                  type="button"
                  aria-pressed={selection.node === component.id}
                  onClick={() => onSelect(selection.node === component.id ? null : component.id)}
                  className={cn("flex min-h-11 w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition-[background-color,opacity] hover:bg-accent aria-pressed:border-primary", highlight && !highlight.nodes.has(component.id) && "opacity-50")}
                >
                  <span className="mf-signal" data-tone={STATE_TONE[component.state]} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{component.label}</span>
                    <span className="block text-xs text-muted-foreground">{component.reason}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs">
                    <span className="block font-medium">{STATE_LABEL[component.state]}</span>
                    {component.latencyMs != null ? <span className="block text-muted-foreground tabular-nums">{component.latencyMs} ms</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function TopologyLegend({ edges }: { edges: TopologyEdge[] }) {
  const busiest = edges.filter((edge) => edge.measured && edge.count).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  return (
    <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <p>{busiest ? `Busiest link: ${busiest.label.toLowerCase()}, ${formatRate(busiest.perMinute ?? 0)}/min over 15 minutes.` : "No measured traffic in the last 15 minutes, so nothing is moving."}</p>
      <ul className="hidden items-center gap-4 lg:flex">
        <li className="inline-flex items-center gap-1.5"><span className="mf-legend" aria-hidden />Measured link</li>
        <li className="inline-flex items-center gap-1.5"><span className="rf-legend-uses" aria-hidden />Dependency, not measured</li>
      </ul>
    </div>
  );
}
