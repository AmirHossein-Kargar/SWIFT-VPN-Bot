"use client";

import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate } from "@/lib/adminApi.client";
import { AdminApiError } from "@/lib/types";
import type { CustodyLocalInvoice, CustodyOverview, CustodyReconcileResult } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";

const SEVERITY_VARIANT: Record<string, "success" | "warning" | "destructive" | "outline"> = {
  ok: "success",
  info: "outline",
  warning: "warning",
  critical: "destructive",
};

export function CustodyView({ overview, transactions }: { overview: CustodyOverview; transactions: CustodyLocalInvoice[] }) {
  const { csrfToken } = useAdminSession();
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<CustodyReconcileResult | null>(null);

  async function reconcile() {
    setReconciling(true);
    try {
      const result = await adminMutate<CustodyReconcileResult>("/custody/reconcile", "POST", csrfToken, { limit: 20 });
      setReconcileResult(result);
      if (result.discrepancyCount > 0) {
        toast.warning(`${result.discrepancyCount} discrepancy(ies) found across ${result.checkedCount} invoices.`);
      } else {
        toast.success(`${result.checkedCount} invoices checked — all in sync.`);
      }
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Reconciliation failed.");
    } finally {
      setReconciling(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Custody (NOWPayments)</CardTitle>
            <CardDescription>Synced {formatDateTime(overview.lastSyncedAt)}</CardDescription>
          </div>
          <Badge variant={overview.providerHealth.status === "healthy" ? "success" : "destructive"}>
            {overview.providerHealth.status}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 pt-0 text-xs text-muted-foreground">
          <Badge variant={overview.capabilities.apiConfigured ? "outline" : "muted"}>API key {overview.capabilities.apiConfigured ? "configured" : "missing"}</Badge>
          <Badge variant={overview.capabilities.custodyJwtConfigured ? "outline" : "muted"}>
            Custody auth {overview.capabilities.custodyJwtConfigured ? "configured" : "missing"}
          </Badge>
          <Badge variant={overview.capabilities.isOwner ? "outline" : "muted"}>{overview.capabilities.isOwner ? "You are the owner" : "Not the owner"}</Badge>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle>Finished deposits</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-semibold">{formatToman(overview.localSummary.finishedToman)}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle>Pending</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-semibold">{overview.localSummary.pendingCount}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle>Needs recovery</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-semibold">{overview.localSummary.recoveryRequiredCount}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle>Underpaid</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-semibold">{overview.localSummary.underpaidCount}</p></CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Custody balances</CardTitle>
              {overview.balanceError ? <CardDescription className="text-destructive">{overview.balanceError}</CardDescription> : null}
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Available</TableHead>
                    <TableHead>Pending</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.balances.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">No balance data available.</TableCell></TableRow>
                  ) : (
                    overview.balances.map((balance) => (
                      <TableRow key={balance.code}>
                        <TableCell className="font-medium">{balance.ticker} ({balance.network})</TableCell>
                        <TableCell>{balance.availableDisplay}</TableCell>
                        <TableCell className="text-muted-foreground">{balance.pendingDisplay}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {overview.reconciliationWarnings.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Needs attention</CardTitle>
                <CardDescription>Invoices flagged for manual review, underpaid, or with an uncertain provider outcome.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {overview.reconciliationWarnings.map((item) => (
                  <div key={item.orderId} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{item.orderId}</p>
                      <p className="text-xs text-muted-foreground">{item.userId} · {formatToman(item.amountToman)} · {item.reason}</p>
                    </div>
                    <Badge variant="warning">{item.status}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Recent conversions</CardTitle>
                {overview.conversionsError ? <CardDescription className="text-destructive">{overview.conversionsError}</CardDescription> : null}
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Pair</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.recentConversions.length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">None yet.</TableCell></TableRow>
                    ) : (
                      overview.recentConversions.map((conversion) => (
                        <TableRow key={conversion.id}>
                          <TableCell className="font-medium">{conversion.fromCurrency.toUpperCase()} → {conversion.toCurrency.toUpperCase()}</TableCell>
                          <TableCell>{conversion.fromAmountDisplay} → {conversion.toAmountDisplay}</TableCell>
                          <TableCell><Badge variant="outline">{conversion.status}</Badge></TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Recent payouts</CardTitle>
                {overview.payoutsError ? <CardDescription className="text-destructive">{overview.payoutsError}</CardDescription> : null}
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Asset</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.recentPayouts.length === 0 ? (
                      <TableRow><TableCell colSpan={3} className="text-center text-sm text-muted-foreground">None yet.</TableCell></TableRow>
                    ) : (
                      overview.recentPayouts.map((payout) => (
                        <TableRow key={payout.id}>
                          <TableCell className="font-medium">{payout.ticker}</TableCell>
                          <TableCell>{payout.amountDisplay}</TableCell>
                          <TableCell><Badge variant="outline">{payout.status}</Badge></TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="transactions" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>Reconciliation check</CardTitle>
                <CardDescription>Compares local invoices against live NOWPayments provider state. Read-only — never changes balances.</CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={reconcile} disabled={reconciling}>
                <RefreshCw className={reconciling ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                Run check
              </Button>
            </CardHeader>
            {reconcileResult ? (
              <CardContent className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Checked {reconcileResult.checkedCount} invoices at {formatDateTime(reconcileResult.checkedAt)} — {reconcileResult.discrepancyCount} discrepancy(ies).
                </p>
                {reconcileResult.findings.filter((f) => f.classification !== "in_sync").map((finding) => (
                  <div key={finding.orderId} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{finding.orderId}</p>
                      <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.classification.replace(/_/g, " ")}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{finding.detail}</p>
                  </div>
                ))}
              </CardContent>
            ) : null}
          </Card>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Currency</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {transactions.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground">No NOWPayments transactions yet.</TableCell></TableRow>
                  ) : (
                    transactions.map((tx) => (
                      <TableRow key={tx.orderId}>
                        <TableCell className="font-medium">{tx.orderId}</TableCell>
                        <TableCell>{tx.userId}</TableCell>
                        <TableCell>{formatToman(tx.amountToman)}</TableCell>
                        <TableCell>{tx.ticker}</TableCell>
                        <TableCell>
                          <Badge variant={tx.balanceCredited ? "success" : "outline"}>{tx.status}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{formatDateTime(tx.createdAt)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
