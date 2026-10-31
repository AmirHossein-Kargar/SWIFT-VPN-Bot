"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CircleSlash } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "@/components/shared/navigation-pending";
import { FlowCanvas, FlowStageList } from "@/components/sentinel/flow-canvas";
import { useLiveFeed, type LiveFeedFilters } from "@/components/sentinel/use-live-feed";
import { adminGet } from "@/lib/adminApi.client";
import { stripBasePath } from "@/lib/basePath";
import { buildFlowGraph, formatAge, PROVIDER_OPTIONS, RANGE_OPTIONS, STAGE_LABEL, type FeedEvent, type FeedHealth, type FlowNodeId, type LiveFeed, type SentinelFlow } from "@/lib/sentinel";
import { cn, formatNumber, formatToman } from "@/lib/utils";

const NODE_FILTER: Partial<Record<FlowNodeId, Partial<LiveFeedFilters>>> = {
  hooshpay: { provider: "hooshpay" },
  nowpayments: { provider: "nowpayments" },
  trx: { provider: "trx" },
  bank: { provider: "bank" },
  confirmed: { stage: "confirmed" },
  wallet: { stage: "credited" },
  reserved: { stage: "reserved" },
  fulfilled: { stage: "fulfilled" },
  refunded: { stage: "refunded" },
};

const HEALTH_LABEL: Record<FeedHealth, { label: string; tone: string }> = {
  connecting: { label: "Connecting", tone: "idle" },
  live: { label: "Live", tone: "ok" },
  delayed: { label: "Delayed", tone: "warn" },
  stale: { label: "Stale", tone: "bad" },
  paused: { label: "Paused while hidden", tone: "idle" },
};

const MONEY_IN = new Set(["credited", "refunded"]);
const MONEY_OUT = new Set(["reserved", "reversed"]);

function direction(stage: string) {
  if (MONEY_IN.has(stage)) return <ArrowDownLeft className="h-3.5 w-3.5 text-success" aria-label="Into a wallet" />;
  if (MONEY_OUT.has(stage)) return <ArrowUpRight className="h-3.5 w-3.5 text-warning" aria-label="Out of a wallet" />;
  return <span className="block h-1.5 w-1.5 rounded-full bg-muted-foreground/50" aria-hidden />;
}

function FeedRow({ event, now }: { event: FeedEvent; now: number | null }) {
  return (
    <li className="mf-feed-row">
      <Link href={`/sentinel/transactions/${encodeURIComponent(event.key)}`} className="flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-accent">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted">{direction(event.stage)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{STAGE_LABEL[event.stage] ?? event.stage}</span>
          <span className="block truncate text-xs text-muted-foreground">{event.provider} · {event.user ?? "unknown"}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold tabular-nums">{event.amount == null ? "—" : formatNumber(event.amount)}</span>
          <time dateTime={event.at} className="block text-xs text-muted-foreground">{now == null ? "" : formatAge(now - new Date(event.at).getTime())}</time>
        </span>
      </Link>
    </li>
  );
}

export function LiveFlowView({ flow: initialFlow, feed, range, filters: urlFilters }: { flow: SentinelFlow; feed: LiveFeed; range: string; filters: LiveFeedFilters }) {
  const navigate = useNavigate();
  const pathname = stripBasePath(usePathname());
  const searchParams = useSearchParams();
  const [flow, setFlow] = useState(initialFlow);
  const [selected, setSelected] = useState<FlowNodeId | null>(null);
  const [minAmount, setMinAmount] = useState(urlFilters.minAmount);
  const [maxAmount, setMaxAmount] = useState(urlFilters.maxAmount);
  const [userId, setUserId] = useState(urlFilters.userId);

  useEffect(() => setFlow(initialFlow), [initialFlow]);
  useEffect(() => {
    const refresh = setInterval(async () => {
      if (document.hidden) return;
      try { setFlow(await adminGet<SentinelFlow>("/sentinel/flow", { range, provider: urlFilters.provider })); } catch { /* the freshness badge reports it */ }
    }, 30_000);
    return () => clearInterval(refresh);
  }, [range, urlFilters.provider]);

  const filters = useMemo<LiveFeedFilters>(() => ({ ...urlFilters, ...(selected ? NODE_FILTER[selected] : {}) }), [urlFilters, selected]);
  const { events, health, failures, gap, degraded, openFindings, lastSyncAt, now } = useLiveFeed(feed, filters);
  const status = HEALTH_LABEL[health];
  const node = selected ? buildFlowGraph(flow).nodes.find((item) => item.id === selected) : null;

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value || value === "all") next.delete(key);
      else next.set(key, value);
    }
    navigate(`${pathname}?${next.toString()}`);
  }

  const amountsValid = [minAmount, maxAmount].every((value) => value === "" || /^\d{1,12}$/.test(value));
  const userValid = userId === "" || /^[1-9]\d{0,19}$/.test(userId);
  const unavailable = [...flow.degraded, ...degraded];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select value={range} onValueChange={(value) => update({ range: value === "24h" ? "" : value })}>
          <SelectTrigger className="w-44" aria-label="Time range"><SelectValue /></SelectTrigger>
          <SelectContent>{RANGE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={urlFilters.provider} onValueChange={(value) => update({ provider: value })}>
          <SelectTrigger className="w-44" aria-label="Payment source"><SelectValue /></SelectTrigger>
          <SelectContent>{PROVIDER_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (amountsValid && userValid) update({ minAmount, maxAmount, userId });
          }}
        >
          <Input value={minAmount} onChange={(event) => setMinAmount(event.target.value.trim())} inputMode="numeric" placeholder="Min Toman" aria-label="Minimum amount in Toman" aria-invalid={!amountsValid} className="w-32" />
          <Input value={maxAmount} onChange={(event) => setMaxAmount(event.target.value.trim())} inputMode="numeric" placeholder="Max Toman" aria-label="Maximum amount in Toman" aria-invalid={!amountsValid} className="w-32" />
          <Input value={userId} onChange={(event) => setUserId(event.target.value.trim())} inputMode="numeric" placeholder="Telegram ID" aria-label="Customer Telegram ID" aria-invalid={!userValid} className="w-40" />
          <Button type="submit" variant="outline" disabled={!amountsValid || !userValid}>Apply</Button>
        </form>
      </div>

      {unavailable.length ? (
        <p className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          Some sources did not answer, so these numbers may be incomplete: {[...new Set(unavailable)].join(", ")}.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="mf-flow-title" className="mf-surface min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="mf-flow-title" className="text-sm font-semibold">Money paths</h2>
            <p className="text-xs text-muted-foreground">
              Records created in the selected range, followed through their stages. Choose a stage to filter the feed.
            </p>
          </div>
          <div className="hidden md:block"><FlowCanvas flow={flow} selected={selected} onSelect={setSelected} /></div>
          <div className="md:hidden"><FlowStageList flow={flow} selected={selected} onSelect={setSelected} /></div>
          <div className="mt-3 flex min-h-5 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {node ? (
              <p role="status">
                <span className="font-medium text-foreground">{node.label}:</span> {formatNumber(node.count)} records, {formatToman(node.amount)}. {NODE_FILTER[node.id] ? "The feed shows this stage." : "No feed filter for this stage."}{" "}
                <button type="button" className="font-medium text-primary underline-offset-4 hover:underline" onClick={() => setSelected(null)}>Clear</button>
              </p>
            ) : <p>Each stage shows its own total. Stages are not added together.</p>}
            <ul className="hidden items-center gap-4 md:flex">
              <li className="inline-flex items-center gap-1.5"><span className="mf-legend" data-kind="flow" aria-hidden />Money moving</li>
              <li className="inline-flex items-center gap-1.5"><span className="mf-legend" data-kind="return" aria-hidden />Back to the wallet</li>
              <li className="inline-flex items-center gap-1.5"><span className="mf-legend" data-kind="alert" aria-hidden />Open finding</li>
            </ul>
          </div>
        </section>

        <Card className="flex min-w-0 flex-col max-xl:max-h-[32rem] xl:h-0 xl:min-h-full">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-foreground">Activity</CardTitle>
              <span className="inline-flex items-center gap-2 text-xs font-medium" data-testid="feed-health" data-health={health}>
                <span className="mf-signal" data-tone={status.tone} aria-hidden />
                {status.label}
              </span>
            </div>
            <CardDescription className="text-xs">
              Polled every 10 seconds{lastSyncAt && now ? `, updated ${formatAge(now - lastSyncAt)}` : ""}.
              {failures > 0 ? ` ${failures} failed ${failures === 1 ? "attempt" : "attempts"}; retrying with a longer wait.` : ""}
            </CardDescription>
            {gap ? <Badge variant="warning" className="w-fit">Busy period: older events may be missing here. Use Transactions for a full list.</Badge> : null}
            {openFindings ? <Link href="/sentinel/reconciliation" className="inline-flex items-center text-xs font-medium text-primary underline-offset-4 hover:underline [@media(pointer:coarse)]:min-h-10">{formatNumber(openFindings)} open {openFindings === 1 ? "finding" : "findings"}</Link> : null}
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <p className="sr-only" role="status">{events.length} events listed</p>
            {events.length ? (
              <ul className={cn("space-y-0.5", health === "stale" && "opacity-70")}>
                {events.map((event) => <FeedRow key={event.id} event={event} now={now} />)}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                <CircleSlash className="h-5 w-5" aria-hidden />
                No money moved in this window.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="sr-only">
        <table>
          <caption>Money paths by stage</caption>
          <thead><tr><th>Source</th><th>Initiated</th><th>Confirmed</th><th>Credited</th></tr></thead>
          <tbody>
            {(flow.payments ?? []).map((row) => (
              <tr key={row.provider}><th scope="row">{row.label}</th><td>{formatToman(row.initiated.amount)}</td><td>{formatToman(row.confirmed.amount)}</td><td>{formatToman(row.credited.amount)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
