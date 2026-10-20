"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FlaskConical, Play } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { MockTestRunReport } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

const OVERALL_VARIANT: Record<string, "success" | "destructive" | "warning" | "muted" | "outline"> = {
  PASS: "success",
  FAIL: "destructive",
  BLOCKED: "warning",
  "NOT RUN": "muted",
  PARTIAL: "warning",
};

export function MockTestsPanel({ initialRuns }: { initialRuns: MockTestRunReport[] }) {
  const { csrfToken } = useAdminSession();
  const [runs, setRuns] = useState(initialRuns);
  const [running, setRunning] = useState(false);
  const [viewing, setViewing] = useState<MockTestRunReport | null>(null);

  async function runAll() {
    setRunning(true);
    try {
      const report = await adminMutate<MockTestRunReport>("/mock-tests/run", "POST", csrfToken, { scenarios: "all" });
      setRuns((prev) => [report, ...prev].slice(0, 20));
      if (report.enabled === false) {
        toast.warning("Mock testing is disabled on this server (set MOCK_TESTS_ENABLED=true).");
      } else {
        toast.success(`Run ${report.runId} finished: ${report.summary.overall}.`);
      }
      setViewing(report);
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not start the run.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Mock tests</CardTitle>
            <CardDescription>
              Runs isolated scenarios (purchase, crypto, card-to-card, test service) against fake providers. Never touches real
              payments or the database.
            </CardDescription>
          </div>
          <Button onClick={runAll} disabled={running}>
            <Play className="h-4 w-4" />
            {running ? "Running…" : "Run all scenarios"}
          </Button>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.runId}>
                    <TableCell className="font-medium">{run.runId}</TableCell>
                    <TableCell className="text-muted-foreground">{run.trigger}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(run.startedAt)}</TableCell>
                    <TableCell>
                      <Badge variant={OVERALL_VARIANT[run.summary.overall] ?? "outline"}>{run.summary.overall}</Badge>
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" onClick={() => setViewing(run)}>
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={Boolean(viewing)} onOpenChange={(open) => !open && setViewing(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" />
              {viewing?.runId}
            </SheetTitle>
            <SheetDescription>
              {viewing ? `${formatDateTime(viewing.startedAt)} → ${formatDateTime(viewing.completedAt)}` : null}
            </SheetDescription>
          </SheetHeader>
          {viewing ? (
            <div className="mt-6 space-y-3">
              {viewing.scenarios.map((scenario) => (
                <div key={scenario.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{scenario.title}</p>
                    <Badge variant={OVERALL_VARIANT[scenario.status] ?? "outline"}>{scenario.status}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {scenario.counts.passed}/{scenario.counts.total} assertions passed
                    {scenario.durationMs ? ` · ${scenario.durationMs}ms` : ""}
                  </p>
                  {scenario.explanation ? <p className="mt-1 text-xs text-muted-foreground">{scenario.explanation}</p> : null}
                  {scenario.errorDetail ? <p className="mt-1 text-xs text-destructive">{scenario.errorDetail}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
