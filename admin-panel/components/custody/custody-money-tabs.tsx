"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminSession } from "@/components/session-provider";
import { useOperationId } from "@/components/users/use-operation-id";
import { adminGet, adminMutate } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import { formatDateTime } from "@/lib/utils";

interface Paged<T> { items: T[]; total: number; page: number; pages: number; pageSize: number; balanceError?: string | null; lastSyncedAt?: string }

interface Asset {
  code: string; ticker: string; name: string; network: string;
  availableDisplay: string | null; pendingDisplay: string | null; hasBalance: boolean;
  minAmount: number | null; enable: boolean;
  supportedActions: { acceptPayment: boolean; convert: boolean; withdraw: boolean };
}
interface Conversion { id: string; fromCurrency: string; toCurrency: string; fromAmountDisplay: string; toAmountDisplay: string; rate: number | null; status: string; createdAt: string | null }
interface Payout {
  id: string; batchWithdrawalId: string | null; currency: string; ticker: string; network: string;
  address: string; extraId: string | null; amountDisplay: string; fee: number | null; status: string; hash: string | null; createdAt: string | null;
}
interface ConversionPreview { fromCurrency: string; fromTicker: string; toCurrency: string; toTicker: string; fromAmount: number; estimatedToAmount: number; impliedRate: number; availableBalance: number | null; previewedAt: string }
interface FeeEstimate { ticker: string; network: string; amount: number; fee: number | null; minAmount: number | null; estimatedTotalDebit: number }

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "outline"> = {
  finished: "success", completed: "success", confirmed: "success", sent: "success",
  failed: "destructive", rejected: "destructive", expired: "destructive", cancelled: "destructive",
  creating: "warning", waiting: "warning", pending: "warning", processing: "warning", sending: "warning",
};

function StatusPill({ status }: { status: string }) {
  return <Badge variant={STATUS_TONE[status.toLowerCase()] ?? "outline"}>{status}</Badge>;
}

/** Loads one paged custody list from the admin API with explicit loading / error / retry states. */
function usePagedList<T>(path: string, params: Record<string, string | number | undefined> = {}) {
  const [data, setData] = useState<Paged<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(params);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    adminGet<Paged<T>>(path, { ...JSON.parse(key), page, pageSize: 20 }, { signal: controller.signal })
      .then(setData)
      .catch((requestError) => { if (!controller.signal.aborted) setError(describeError(requestError)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, key, page, nonce]);

  return { data, error, loading, page, setPage, reload: useCallback(() => setNonce((value) => value + 1), []) };
}

function ListState({ loading, error, empty, onRetry }: { loading: boolean; error: string | null; empty: boolean; onRetry: () => void }) {
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm" role="alert">
        <p className="text-destructive">{error}</p>
        <p className="text-muted-foreground">The data shown below, if any, may be out of date.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  if (loading) return <p className="p-4 text-sm text-muted-foreground" role="status">Loading…</p>;
  if (empty) return <p className="p-6 text-center text-sm text-muted-foreground">Nothing to show.</p>;
  return null;
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t p-3 text-sm">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
      <span className="text-muted-foreground">Page {page} of {pages}</span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
    </div>
  );
}

const mono = "font-mono text-xs break-all";

export function CustodyAssetsTab() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("with-balance");
  const list = usePagedList<Asset>("/custody/assets", { search: search || undefined, filter });
  const { setPage } = list;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asset balances</CardTitle>
        <CardDescription>Custody balances and the NOWPayments catalogue{list.data?.lastSyncedAt ? ` · synced ${formatDateTime(list.data.lastSyncedAt)}` : ""}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        <div className="flex flex-wrap gap-2 px-4">
          <Input aria-label="Search assets" placeholder="Search code, ticker or network" className="max-w-xs" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <select aria-label="Filter assets" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}>
            <option value="with-balance">With balance</option>
            <option value="pending">Pending funds</option>
            <option value="fixed-rate">Fixed-rate capable</option>
            <option value="all">All assets</option>
          </select>
        </div>
        {list.data?.balanceError ? <p className="px-4 text-sm text-warning" role="status">Custody balances are unavailable: {list.data.balanceError}</p> : null}
        <ListState loading={list.loading} error={list.error} empty={!list.loading && !list.error && !list.data?.items.length} onRetry={list.reload} />
        {list.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Asset</TableHead><TableHead>Network</TableHead><TableHead>Available</TableHead><TableHead>Pending</TableHead><TableHead>Actions</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((asset) => (
                <TableRow key={asset.code}>
                  <TableCell><span className="font-medium">{asset.ticker}</span> <span className="text-muted-foreground">{asset.name}</span></TableCell>
                  <TableCell>{asset.network}</TableCell>
                  <TableCell className="font-mono text-xs">{asset.availableDisplay ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{asset.pendingDisplay ?? "—"}</TableCell>
                  <TableCell className="space-x-1">
                    {asset.supportedActions.convert ? <Badge variant="outline">convert</Badge> : null}
                    {asset.supportedActions.withdraw ? <Badge variant="outline">withdraw</Badge> : null}
                    {!asset.enable ? <Badge variant="muted">disabled</Badge> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <Pager page={list.page} pages={list.data?.pages ?? 1} onPage={list.setPage} />
      </CardContent>
    </Card>
  );
}

export function CustodyConversionsTab() {
  const { csrfToken } = useAdminSession();
  const list = usePagedList<Conversion>("/custody/conversions");
  const { operationId, rotate } = useOperationId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ConversionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Any edit invalidates a previous quote: the user must preview again.
  function edit(setter: (value: string) => void) {
    return (event: React.ChangeEvent<HTMLInputElement>) => { setter(event.target.value); setPreview(null); setError(null); };
  }

  async function runPreview() {
    setBusy(true); setError(null);
    try {
      setPreview(await adminMutate<ConversionPreview>("/custody/conversions/preview", "POST", csrfToken, { fromCurrency: from.trim(), toCurrency: to.trim(), amount }));
    } catch (previewError) { setPreview(null); setError(describeError(previewError)); }
    finally { setBusy(false); }
  }

  async function execute() {
    setBusy(true); setError(null);
    try {
      await adminMutate("/custody/conversions", "POST", csrfToken, { operationId, fromCurrency: from.trim(), toCurrency: to.trim(), amount, reason: reason.trim() });
      toast.success("Conversion submitted. Check its status below.");
      rotate(); setPreview(null); setAmount(""); setReason(""); setConfirmOpen(false); list.reload();
    } catch (executeError) {
      // Same operationId is kept on purpose: retrying after a timeout cannot run the conversion twice.
      setError(describeError(executeError));
    } finally { setBusy(false); }
  }

  const ready = from.trim() && to.trim() && Number(amount) > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Convert assets</CardTitle><CardDescription>Always preview first. The confirmed amounts come from a fresh server quote, not from this form.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5"><Label htmlFor="conv-from">From (currency code)</Label><Input id="conv-from" value={from} onChange={edit(setFrom)} placeholder="e.g. trx" autoCapitalize="none" /></div>
            <div className="space-y-1.5"><Label htmlFor="conv-to">To (currency code)</Label><Input id="conv-to" value={to} onChange={edit(setTo)} placeholder="e.g. usdttrc20" autoCapitalize="none" /></div>
            <div className="space-y-1.5"><Label htmlFor="conv-amount">Amount</Label><Input id="conv-amount" inputMode="decimal" value={amount} onChange={edit(setAmount)} /></div>
          </div>
          {error && !confirmOpen ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {preview ? (
            <div className="rounded-md border p-3 text-sm" role="status">
              <p>Convert <b>{preview.fromAmount} {preview.fromTicker}</b> → about <b>{preview.estimatedToAmount} {preview.toTicker}</b></p>
              <p className="text-muted-foreground">Rate {preview.impliedRate} · available {preview.availableBalance ?? "unknown"} · quoted {formatDateTime(preview.previewedAt)}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!ready || busy} onClick={runPreview}>{busy && !confirmOpen ? "Working…" : "Preview"}</Button>
            <Button disabled={!preview || busy} onClick={() => { setError(null); setConfirmOpen(true); }}>Review and convert</Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(next) => !busy && setConfirmOpen(next)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Confirm conversion</DialogTitle>
            <DialogDescription>This moves custody funds at the provider and cannot be undone from this panel. The rate is re-quoted when it executes.</DialogDescription>
          </DialogHeader>
          {preview ? <p className="text-sm"><b>{preview.fromAmount} {preview.fromTicker}</b> → about <b>{preview.estimatedToAmount} {preview.toTicker}</b></p> : null}
          <div className="space-y-1.5"><Label htmlFor="conv-reason">Reason (kept in the audit log)</Label><Input id="conv-reason" maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button disabled={busy || reason.trim().length < 5} onClick={execute}>{busy ? "Submitting…" : "Convert"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader><CardTitle>Conversion history</CardTitle></CardHeader>
        <CardContent className="p-0">
          <ListState loading={list.loading} error={list.error} empty={!list.loading && !list.error && !list.data?.items.length} onRetry={list.reload} />
          {list.data?.items.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>Pair</TableHead><TableHead>From</TableHead><TableHead>To</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead></TableRow></TableHeader>
              <TableBody>
                {list.data.items.map((conversion) => (
                  <TableRow key={conversion.id}>
                    <TableCell className={mono}>{conversion.id}</TableCell>
                    <TableCell>{conversion.fromCurrency} → {conversion.toCurrency}</TableCell>
                    <TableCell className="font-mono text-xs">{conversion.fromAmountDisplay}</TableCell>
                    <TableCell className="font-mono text-xs">{conversion.toAmountDisplay}</TableCell>
                    <TableCell><StatusPill status={conversion.status} /></TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(conversion.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <Pager page={list.page} pages={list.data?.pages ?? 1} onPage={list.setPage} />
        </CardContent>
      </Card>
    </div>
  );
}

export function CustodyPayoutsTab() {
  const { csrfToken } = useAdminSession();
  const list = usePagedList<Payout>("/custody/payouts");
  const create = useOperationId();
  const verify = useOperationId();
  const [currency, setCurrency] = useState("");
  const [address, setAddress] = useState("");
  const [extraId, setExtraId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [checked, setChecked] = useState<{ fee: FeeEstimate; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [verifyBatch, setVerifyBatch] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifyReason, setVerifyReason] = useState("");

  function edit(setter: (value: string) => void) {
    return (event: React.ChangeEvent<HTMLInputElement>) => { setter(event.target.value); setChecked(null); setError(null); };
  }

  async function validate() {
    setBusy(true); setError(null);
    try {
      await adminMutate("/custody/payouts/validate-address", "POST", csrfToken, { currency: currency.trim(), address: address.trim(), extraId: extraId.trim() || undefined });
      const fee = await adminGet<FeeEstimate>("/custody/payouts/fee", { currency: currency.trim(), amount });
      setChecked({ fee, address: address.trim() });
    } catch (checkError) { setChecked(null); setError(describeError(checkError)); }
    finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      await adminMutate("/custody/payouts", "POST", csrfToken, { operationId: create.operationId, currency: currency.trim(), address: address.trim(), amount, extraId: extraId.trim() || undefined, reason: reason.trim() });
      toast.success("Payout created. Provider verification (2FA) is required before it is sent.");
      create.rotate(); setChecked(null); setAmount(""); setAddress(""); setExtraId(""); setReason(""); setConfirmOpen(false); list.reload();
    } catch (submitError) {
      // operationId is intentionally kept so a retry after a timeout cannot create a second payout.
      setError(describeError(submitError));
    } finally { setBusy(false); }
  }

  async function submitVerification() {
    if (!verifyBatch) return;
    setBusy(true); setError(null);
    try {
      await adminMutate(`/custody/payouts/${encodeURIComponent(verifyBatch)}/verify`, "POST", csrfToken, { operationId: verify.operationId, verificationCode: code.trim(), reason: verifyReason.trim() });
      toast.success("Verification sent to the provider.");
      verify.rotate(); setVerifyBatch(null); setCode(""); setVerifyReason(""); list.reload();
    } catch (verificationError) { setError(describeError(verificationError)); }
    finally { setBusy(false); }
  }

  const ready = currency.trim() && address.trim() && Number(amount) > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>New payout</CardTitle><CardDescription>Validate the destination first. A payout is only sent after provider 2FA verification.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="po-currency">Currency code</Label><Input id="po-currency" value={currency} onChange={edit(setCurrency)} placeholder="e.g. trx" autoCapitalize="none" /></div>
            <div className="space-y-1.5"><Label htmlFor="po-amount">Amount</Label><Input id="po-amount" inputMode="decimal" value={amount} onChange={edit(setAmount)} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="po-address">Destination address</Label><Input id="po-address" className="font-mono" value={address} onChange={edit(setAddress)} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="po-extra">Memo / extra ID (only if the network needs one)</Label><Input id="po-extra" value={extraId} onChange={edit(setExtraId)} /></div>
          </div>
          {error && !confirmOpen && !verifyBatch ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {checked ? (
            <div className="rounded-md border p-3 text-sm" role="status">
              <p>Address is valid for <b>{checked.fee.ticker}</b> on <b>{checked.fee.network}</b>.</p>
              <p className="text-muted-foreground">Estimated fee {checked.fee.fee ?? "unknown"} · total debit {checked.fee.estimatedTotalDebit}{checked.fee.minAmount != null ? ` · minimum ${checked.fee.minAmount}` : ""}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!ready || busy} onClick={validate}>{busy && !confirmOpen ? "Checking…" : "Validate address and fee"}</Button>
            <Button disabled={!checked || busy} onClick={() => { setError(null); setConfirmOpen(true); }}>Review and create payout</Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(next) => !busy && setConfirmOpen(next)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Confirm payout</DialogTitle>
            <DialogDescription>Check the destination character by character. Crypto transfers are irreversible once verified.</DialogDescription>
          </DialogHeader>
          {checked ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Asset</dt><dd>{checked.fee.ticker} · {checked.fee.network}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Amount</dt><dd className="font-mono">{checked.fee.amount}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Estimated fee</dt><dd className="font-mono">{checked.fee.fee ?? "unknown"}</dd></div>
              <div><dt className="text-muted-foreground">To</dt><dd className={mono}>{checked.address}</dd></div>
            </dl>
          ) : null}
          <div className="space-y-1.5"><Label htmlFor="po-reason">Reason (kept in the audit log)</Label><Input id="po-reason" maxLength={240} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={busy} onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || reason.trim().length < 5} onClick={submit}>{busy ? "Submitting…" : "Create payout"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={verifyBatch != null} onOpenChange={(next) => { if (!busy && !next) { setVerifyBatch(null); setError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Verify payout (2FA)</DialogTitle>
            <DialogDescription>Enter the verification code the provider sent for batch <span className={mono}>{verifyBatch}</span>.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5"><Label htmlFor="po-code">Verification code</Label><Input id="po-code" inputMode="text" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="po-vreason">Reason (kept in the audit log)</Label><Input id="po-vreason" maxLength={240} value={verifyReason} onChange={(event) => setVerifyReason(event.target.value)} /></div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={busy} onClick={() => setVerifyBatch(null)}>Cancel</Button>
            <Button disabled={busy || code.trim().length < 4 || verifyReason.trim().length < 5} onClick={submitVerification}>{busy ? "Verifying…" : "Verify"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader><CardTitle>Payout history</CardTitle></CardHeader>
        <CardContent className="p-0">
          <ListState loading={list.loading} error={list.error} empty={!list.loading && !list.error && !list.data?.items.length} onRetry={list.reload} />
          {list.data?.items.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>Payout</TableHead><TableHead>Asset</TableHead><TableHead>Amount</TableHead><TableHead>Destination</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {list.data.items.map((payout) => (
                  <TableRow key={`${payout.id}-${payout.batchWithdrawalId}`}>
                    <TableCell className={mono}>{payout.id}{payout.batchWithdrawalId ? <span className="block text-muted-foreground">batch {payout.batchWithdrawalId}</span> : null}</TableCell>
                    <TableCell>{payout.ticker} <span className="text-muted-foreground">{payout.network}</span></TableCell>
                    <TableCell className="font-mono text-xs">{payout.amountDisplay}{payout.fee != null ? <span className="block text-muted-foreground">fee {payout.fee}</span> : null}</TableCell>
                    <TableCell className={mono}>{payout.address}{payout.extraId ? <span className="block text-muted-foreground">memo {payout.extraId}</span> : null}</TableCell>
                    <TableCell><StatusPill status={payout.status} /></TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(payout.createdAt)}</TableCell>
                    <TableCell>
                      {payout.batchWithdrawalId && ["creating", "waiting"].includes(payout.status.toLowerCase()) ? (
                        <Button size="sm" variant="outline" onClick={() => { setError(null); setVerifyBatch(payout.batchWithdrawalId); }}>Verify 2FA</Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <Pager page={list.page} pages={list.data?.pages ?? 1} onPage={list.setPage} />
        </CardContent>
      </Card>
    </div>
  );
}
