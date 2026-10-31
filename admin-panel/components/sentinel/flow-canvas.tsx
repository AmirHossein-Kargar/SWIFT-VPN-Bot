"use client";

import { useRef } from "react";

import { EdgeParticles, useInView, useSceneTilt } from "@/components/shared/scene-motion";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { buildFlowGraph, SEVERITY_LABEL, type FlowNode, type FlowNodeId, type SentinelFlow } from "@/lib/sentinel";
import { cn, formatNumber, formatToman } from "@/lib/utils";

const VIEW_W = 1000;
const VIEW_H = 460;
const SOURCE_IDS = new Set<FlowNodeId>(["hooshpay", "nowpayments", "trx", "bank"]);
const edgeWidth = (count: number) => (count > 0 ? Math.min(5, 1.75 + Math.log10(count + 1) * 1.4) : 1.25);

/**
 * Money as it moves. The picture is a plain SVG with compositor-run dots: no canvas loop and no 3D library. Each dot rides
 * a real edge, and how many ride it comes from that edge's real count; an edge with no records stays still. Depth is a CSS
 * tilt on the whole scene plus stacked plates under each node. Nodes are real buttons, so keyboard and touch work as usual.
 * Motion pauses off-screen, follows `prefers-reduced-motion`, and the tilt follows the pointer only on a fine pointer.
 */
export function FlowCanvas({ flow, selected, onSelect }: { flow: SentinelFlow; selected: FlowNodeId | null; onSelect: (id: FlowNodeId | null) => void }) {
  const reducedMotion = useReducedMotion();
  const { nodes, edges } = buildFlowGraph(flow);
  const scene = useRef<HTMLDivElement>(null);
  const visible = useInView(scene);
  useSceneTilt(scene, reducedMotion);

  return (
    <div className="mf-stage" ref={scene} data-paused={visible ? undefined : "true"}>
      <div className="mf-scene">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <radialGradient id="mf-core" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="hsl(var(--brand))" stopOpacity="0.28" />
              <stop offset="100%" stopColor="hsl(var(--brand))" stopOpacity="0" />
            </radialGradient>
            <pattern id="mf-grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="hsl(var(--brand))" strokeOpacity="0.1" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={VIEW_W} height={VIEW_H} fill="url(#mf-grid)" />
          <ellipse cx="520" cy="220" rx="190" ry="150" fill="url(#mf-core)" />
          {edges.map((edge) => (
            <path key={edge.id} d={edge.path} className="mf-edge" data-active={edge.count > 0 ? "true" : undefined} data-tone={edge.tone} style={{ strokeWidth: edgeWidth(edge.count) }} />
          ))}
        </svg>
        {reducedMotion ? null : <EdgeParticles edges={edges} paused={!visible} width={VIEW_W} height={VIEW_H} />}
        {nodes.map((node) => <FlowNodeButton key={node.id} node={node} selected={selected === node.id} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

function FlowNodeButton({ node, selected, onSelect }: { node: FlowNode; selected: boolean; onSelect: (id: FlowNodeId | null) => void }) {
  const alert = node.alert ? `, open ${SEVERITY_LABEL[node.alert].toLowerCase()} findings` : "";
  return (
    <button
      type="button"
      className={cn("mf-node", node.id === "wallet" && "mf-node-core", SOURCE_IDS.has(node.id) && "mf-node-source")}
      style={{ left: `${(node.x / VIEW_W) * 100}%`, top: `${(node.y / VIEW_H) * 100}%` }}
      data-alert={node.alert ?? undefined}
      data-empty={node.count === 0 ? "true" : undefined}
      aria-pressed={selected}
      aria-label={`${node.label}: ${formatNumber(node.count)} records, ${formatToman(node.amount)}${alert}. ${node.hint}. Filters the feed.`}
      onClick={() => onSelect(selected ? null : node.id)}
    >
      <span className="mf-node-plate" aria-hidden />
      <span className="mf-node-plate" aria-hidden />
      <span className="mf-node-face">
        <span className="mf-node-label">{node.label}</span>
        <span className="mf-node-count">{formatNumber(node.count)}</span>
      </span>
    </button>
  );
}

/** The same numbers without the picture: the phone layout, and the text version of the graph for everyone else. */
export function FlowStageList({ flow, selected, onSelect }: { flow: SentinelFlow; selected: FlowNodeId | null; onSelect: (id: FlowNodeId | null) => void }) {
  const { nodes } = buildFlowGraph(flow);
  return (
    <ol className="space-y-2">
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            aria-pressed={selected === node.id}
            onClick={() => onSelect(selected === node.id ? null : node.id)}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-accent aria-pressed:border-primary"
          >
            <span className="min-w-0">
              <span className="block font-medium">{node.label}</span>
              <span className="block text-xs text-muted-foreground">{node.hint}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block font-semibold tabular-nums">{formatNumber(node.count)}</span>
              <span className="block text-xs text-muted-foreground tabular-nums">{formatToman(node.amount)}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
