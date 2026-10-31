import Link from "next/link";
import { AlertTriangle, Check, CircleDashed, CircleHelp, Clock, Link2Off, Minus, X, type LucideIcon } from "lucide-react";

import { EventRow } from "@/components/reliability/event-row";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BASIS_LABEL, ORDER_STATUS_LABEL, STAGE_LABEL, formatDuration, type OrderTrace, type StageState, type TraceStage } from "@/lib/reliability";
import { formatDateTime, formatNumber } from "@/lib/utils";

const STAGE_ICON: Record<StageState, LucideIcon> = { done: Check, pending: CircleDashed, waiting: Clock, failed: X, skipped: Minus, unknown: CircleHelp, not_linked: Link2Off };
const BASIS_ATTRIBUTE: Record<TraceStage["basis"], string> = { recorded: "recorded", inferred: "inferred", missing: "absent" };

function Stage({ stage, first }: { stage: TraceStage; first: boolean }) {
  const Icon = STAGE_ICON[stage.state];
  const timed = stage.durationMs ?? stage.waitingMs ?? null;
  return (
    <li className="rf-stage" data-state={stage.state} data-delayed={stage.delayed?.exceeded ? "true" : undefined} data-stage={stage.id}>
      <span className="rf-stage-dot" aria-hidden><Icon className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1 pb-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-semibold">{stage.label}</h3>
          <span className="text-xs font-medium text-muted-foreground">{STAGE_LABEL[stage.state]}</span>
          {stage.state === "skipped" ? null : <span className="mf-basis" data-basis={BASIS_ATTRIBUTE[stage.basis]}>{BASIS_LABEL[stage.basis]}</span>}
          {stage.delayed?.exceeded ? <Badge variant="warning"><AlertTriangle className="mr-1 h-3 w-3" aria-hidden />Past the {formatDuration(stage.delayed.limitMs)} limit</Badge> : null}
        </div>
        {stage.note ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{stage.note}</p> : null}
        {!first || stage.startedAt ? (
          <dl className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            {stage.startedAt ? <div className="flex gap-1.5"><dt className="text-muted-foreground">Started</dt><dd>{formatDateTime(stage.startedAt)}</dd></div> : null}
            {stage.completedAt ? <div className="flex gap-1.5"><dt className="text-muted-foreground">Finished</dt><dd>{formatDateTime(stage.completedAt)}</dd></div> : null}
            {timed != null ? <div className="flex gap-1.5"><dt className="text-muted-foreground">{stage.durationMs != null ? "Took" : "Waiting"}</dt><dd className="font-medium tabular-nums">{formatDuration(timed)}</dd></div> : null}
            {stage.retries ? <div className="flex gap-1.5"><dt className="text-muted-foreground">Attempts</dt><dd className="font-medium tabular-nums">{formatNumber(stage.retries)}</dd></div> : null}
            {stage.error ? <div className="flex gap-1.5"><dt className="text-muted-foreground">Error</dt><dd className="font-medium text-destructive">{stage.error}</dd></div> : null}
            {stage.source && stage.state !== "skipped" ? <div className="flex gap-1.5"><dt className="text-muted-foreground">Source</dt><dd className="break-all">{stage.source}</dd></div> : null}
          </dl>
        ) : null}
      </div>
    </li>
  );
}

/** One order from start to end, read from its own record. Each stage says whether it is recorded, inferred or simply unknown. */
export function OrderTraceView({ trace }: { trace: OrderTrace }) {
  return (
    <div className="space-y-4">
      <section className="mf-surface p-5" aria-labelledby="rf-trace-title" data-testid="trace">
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Order trace</p>
            <h2 id="rf-trace-title" className="mt-1 text-xl font-semibold tracking-tight">{ORDER_STATUS_LABEL[trace.status] === "Delivery pending" ? "Completed" : ORDER_STATUS_LABEL[trace.status] ?? trace.status}</h2>
            <p className="mt-1 break-all text-sm text-muted-foreground">{trace.plan ?? "Plan unknown"} · {trace.user ?? "unknown customer"} · {trace.orderId}</p>
          </div>
          <Link href={`/sentinel/transactions/${encodeURIComponent(trace.key)}`} className="inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">Money view in Sentinel</Link>
        </div>
        {trace.recovery.status !== "none" ? <p className="relative z-10 mt-3 text-sm">Recovery: {trace.recovery.status}{trace.recovery.reason ? ` (${trace.recovery.reason})` : ""}. <Link href="/recovery" className="font-medium text-primary underline-offset-4 hover:underline">Open Recovery</Link></p> : null}
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground">Lifecycle</CardTitle>
          <CardDescription className="text-xs">Stages this order really went through. Limits are the same ones System Health uses.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol>{trace.stages.map((stage, index) => <Stage key={stage.id} stage={stage} first={index === 0} />)}</ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">State changes</CardTitle><CardDescription className="text-xs">From the order&apos;s own event history.</CardDescription></CardHeader>
          <CardContent>
            {trace.transitions.length ? (
              <ol className="space-y-1.5 text-sm">
                {trace.transitions.map((item, index) => (
                  <li key={`${item.at}:${index}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-medium">{item.type}{item.from && item.to ? <span className="font-normal text-muted-foreground"> {item.from} to {item.to}</span> : null}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(item.at)}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">No state change was recorded in this order&apos;s history.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Provider and delivery events</CardTitle><CardDescription className="text-xs">Telemetry linked to this order, with sanitized codes only.</CardDescription></CardHeader>
          <CardContent className="px-3 pb-3">
            {trace.events.length ? <ul className="space-y-0.5">{trace.events.map((event) => <EventRow key={event.id} event={event} />)}</ul> : <p className="px-2 text-sm text-muted-foreground">No telemetry for this order. It may predate the monitor, or be older than the seven days kept.</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
