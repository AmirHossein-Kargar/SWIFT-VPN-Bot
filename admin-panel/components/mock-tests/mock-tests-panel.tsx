"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, FlaskConical, Play, RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useAdminSession } from "@/components/session-provider";
import { adminGet, adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import { formatDuration, isGenuinePass, normalizeListing, runBlockedReason, runDurationMs } from "@/lib/mockTests";
import type { MockTestRunReport, MockTestsListing, MockScenarioResult } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

// Scenarios run sequentially on the server; allow a generous ceiling, then
// tell the admin the outcome is unknown rather than leaving a spinner forever.
const RUN_TIMEOUT_MS = 180_000;

const STATUS_VARIANT: Record<string, "success" | "destructive" | "warning" | "muted" | "outline"> = {
  PASS: "success",
  FAIL: "destructive",
  BLOCKED: "warning",
  "NOT RUN": "muted",
  PARTIAL: "warning",
};
const STATUS_LABEL: Record<string, string> = { PASS: "Passed", FAIL: "Failed", BLOCKED: "Blocked", "NOT RUN": "Not run", PARTIAL: "Partial" };

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "outline"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function MockTestsPanel({ listing: rawListing }: { listing: MockTestsListing }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const listing = useMemo(() => normalizeListing(rawListing), [rawListing]);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MockTestRunReport | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const inFlight = useRef(false);

  const blockedReason = runBlockedReason(listing, Boolean(submitting));

  async function run(scenarios: "all" | string[], label: string) {
    // A ref guards against a double click landing before React re-renders.
    if (inFlight.current || blockedReason) return;
    inFlight.current = true;
    setSubmitting(label);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    try {
      const report = await adminMutate<MockTestRunReport>("/mock-tests/run", "POST", csrfToken, { scenarios }, { signal: controller.signal });
      if (report.enabled === false) {
        toast.warning("Mock testing is disabled on this server; nothing was executed.");
      } else if (isGenuinePass(report)) {
        toast.success(`Run ${report.runId}: all requested scenarios passed.`);
      } else {
        toast.error(`Run ${report.runId}: ${STATUS_LABEL[report.summary.overall] ?? report.summary.overall}. Open the run for details.`);
      }
      openDetail(report.runId, report);
      router.refresh();
    } catch (error) {
      toast.error(describeError(error, "Could not start the run."));
      router.refresh();
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setSubmitting(null);
    }
  }

  function refresh() {
    setRefreshing(true);
    router.refresh();
    setTimeout(() => setRefreshing(false), 500);
  }

  async function openDetail(runId: string, known?: MockTestRunReport) {
    setDetailRunId(runId);
    if (known?.scenarios?.some((scenario) => Array.isArray(scenario.assertions))) {
      setDetail(known);
      setDetailState("idle");
      return;
    }
    setDetail(null);
    setDetailState("loading");
    try {
      setDetail(await adminGet<MockTestRunReport>(`/mock-tests/${encodeURIComponent(runId)}`));
      setDetailState("idle");
    } catch {
      setDetailState("error");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Mock tests</CardTitle>
              <Badge variant={listing.enabled ? "success" : "muted"}>{listing.enabled ? "Enabled on server" : "Disabled on server"}</Badge>
              {listing.running || submitting ? <Badge variant="warning">Running</Badge> : null}
            </div>
            <CardDescription>
              Runs isolated scenarios against in-memory models and fake providers. Real payments, wallets, the database and
              the VPN panel are blocked by the isolation guard; a scenario that tries to touch them fails.
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => run("all", "all")} disabled={Boolean(blockedReason)} title={blockedReason ?? undefined}>
              <Play className="h-4 w-4" />
              {submitting === "all" ? "Running…" : "Run all"}
            </Button>
          </div>
        </CardHeader>
        {blockedReason && !submitting ? (
          <CardContent className="pt-0">
            <p className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">{blockedReason}</p>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scenarios</CardTitle>
          <CardDescription>Run a single scenario to iterate on one flow.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {listing.scenarios.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">The server reported no scenarios.</p>
          ) : (
            <ul className="divide-y divide-border">
              {listing.scenarios.map((scenario) => (
                <li key={scenario.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className="text-sm font-medium">{scenario.title}</p>
                    <p className="font-mono text-xs text-muted-foreground">{scenario.id}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => run([scenario.id], scenario.id)} disabled={Boolean(blockedReason)}>
                    {submitting === scenario.id ? "Running…" : "Run"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>
            {listing.source === "memory" ? "Database unavailable — showing runs kept in this process's memory." : "Most recent 20 runs."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {listing.items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No runs recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Scenarios</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {listing.items.map((item) => (
                  <TableRow key={item.runId}>
                    <TableCell>
                      <p className="font-mono text-xs">{item.runId}</p>
                      <p className="text-xs text-muted-foreground">via {item.trigger}</p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {item.summary.PASS} passed · {item.summary.FAIL} failed · {item.summary.BLOCKED} blocked · {item.summary["NOT RUN"]} not run
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(item.startedAt)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDuration(runDurationMs(item))}</TableCell>
                    <TableCell><StatusBadge status={item.summary.overall} /></TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" onClick={() => openDetail(item.runId)}>View</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={Boolean(detailRunId)} onOpenChange={(open) => { if (!open) { setDetailRunId(null); setDetail(null); } }}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" />
              <span className="font-mono text-sm">{detailRunId}</span>
            </SheetTitle>
            <SheetDescription>
              {detail ? `${formatDateTime(detail.startedAt)} · ${formatDuration(runDurationMs(detail))}` : "Loading report…"}
            </SheetDescription>
          </SheetHeader>
          {detailState === "loading" ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : detailState === "error" ? (
            <p className="mt-6 text-sm text-destructive">Could not load this report. It may have been removed.</p>
          ) : detail ? (
            <div className="mt-6 space-y-3">
              {detail.enabled === false ? (
                <p className="rounded-md border border-border bg-muted/50 p-3 text-sm text-muted-foreground">Mock testing was disabled; no scenario executed.</p>
              ) : null}
              {detail.scenarios.map((scenario) => <ScenarioDetail key={scenario.id} scenario={scenario} />)}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ScenarioDetail({ scenario }: { scenario: MockScenarioResult }) {
  const assertions = scenario.assertions ?? [];
  const failed = assertions.filter((assertion) => assertion.status === "fail");
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{scenario.title}</p>
        <StatusBadge status={scenario.status} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {scenario.counts.passed}/{scenario.counts.total - scenario.counts.skipped} checks passed
        {scenario.counts.skipped ? ` · ${scenario.counts.skipped} skipped` : ""}
        {scenario.durationMs ? ` · ${formatDuration(scenario.durationMs)}` : ""}
      </p>
      {scenario.explanation ? <p className="mt-2 text-xs text-muted-foreground">{scenario.explanation}</p> : null}
      {scenario.error ? <p className="mt-2 break-words font-mono text-xs text-destructive">{scenario.error}</p> : null}
      {scenario.isolationViolations?.length ? (
        <p className="mt-2 text-xs text-destructive">Isolation violations: {scenario.isolationViolations.join(", ")}</p>
      ) : null}
      {assertions.length > 0 ? (
        <Collapsible defaultOpen={failed.length > 0} className="mt-2">
          <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=closed]:-rotate-90" />
            {assertions.length} checks{failed.length ? ` (${failed.length} failed)` : ""}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-2 space-y-1">
              {assertions.map((assertion, index) => (
                <li key={`${assertion.name}-${index}`} className="flex gap-2 text-xs">
                  <span className={assertion.status === "pass" ? "text-success" : assertion.status === "fail" ? "text-destructive" : "text-muted-foreground"}>
                    {assertion.status === "pass" ? "✓" : assertion.status === "fail" ? "✗" : "–"}
                  </span>
                  <span>
                    {assertion.name}
                    {assertion.detail ? <span className="block text-muted-foreground">{assertion.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
