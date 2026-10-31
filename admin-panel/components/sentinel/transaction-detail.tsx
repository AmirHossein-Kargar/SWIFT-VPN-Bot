import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BasisTag } from "@/components/sentinel/labels";
import { FindingList } from "@/components/sentinel/finding-list";
import { LifecycleTrack, WalletPanel } from "@/components/sentinel/lifecycle";
import type { TransactionDetail } from "@/lib/sentinel";
import { formatDateTime, formatToman } from "@/lib/utils";

const FIELD_LABEL: Record<string, string> = {
  reference: "Reference", invoiceId: "Provider invoice", paymentId: "Provider payment", trackingCode: "Tracking code", transactionHash: "Transaction hash",
  payCurrency: "Paid in", payAmount: "Requested", actuallyPaid: "Received", orderId: "Order", planName: "Plan", planId: "Plan ID", serviceUsername: "Service", days: "Days", trafficGb: "Traffic (GB)",
};
const RELATION_LABEL: Record<string, string> = { credit: "Credited the wallet", debit: "Debited the wallet", refund: "Refunded to the wallet", likely_funded_by: "May have been paid by" };

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm font-medium">{value}</dd>
    </div>
  );
}

export function TransactionDetailView({ transaction }: { transaction: TransactionDetail }) {
  const identifiers = Object.entries(transaction.identifiers).filter(([, value]) => value != null && value !== "");
  const paymentsHref = `/payments?search=${encodeURIComponent(transaction.key.split(":").slice(1).join(":"))}`;

  return (
    <div className="space-y-4">
      <Link href="/sentinel/transactions" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Transactions</Link>

      <section className="mf-surface p-5" aria-labelledby="mf-transaction-title">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{transaction.providerLabel}</p>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="mf-transaction-title" className="text-2xl font-semibold tracking-tight tabular-nums">{transaction.amount == null ? "—" : formatToman(transaction.amount)}</h2>
          <p className="text-sm text-muted-foreground">Status: <span className="font-medium text-foreground">{transaction.status.replace(/_/g, " ")}</span> · {formatDateTime(transaction.createdAt)}</p>
        </div>
        <div className="mt-5"><LifecycleTrack stages={transaction.flow} /></div>
      </section>

      {transaction.findings.length ? (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Findings on this record</CardTitle></CardHeader>
          <CardContent><FindingList items={transaction.findings} /></CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Identifiers</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Customer" value={<Link className="text-primary underline-offset-4 hover:underline" href={`/users?search=${encodeURIComponent(transaction.userId)}`}>{transaction.userId}</Link>} />
              {identifiers.map(([key, value]) => <Field key={key} label={FIELD_LABEL[key] ?? key} value={String(value)} />)}
            </dl>
            <Link href={paymentsHref} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">Open in Payments<ExternalLink className="h-3.5 w-3.5" aria-hidden /></Link>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <CardTitle className="text-foreground">Relationships</CardTitle>
            <CardDescription>A wallet is shared money: no payment can be proven to have paid for one specific order.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {transaction.relationships.map((relation) => (
                <li key={`${relation.from}-${relation.to}-${relation.type}`} className="text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">{RELATION_LABEL[relation.type] ?? relation.type}<BasisTag basis={relation.basis} /></p>
                  <p className="text-xs text-muted-foreground">{relation.evidence}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {transaction.verification ? (
        <Card className="min-w-0">
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Provider verification</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid gap-3 sm:grid-cols-4">
              <Field label="Provider status" value={transaction.verification.providerStatus} />
              <Field label="Confirmed" value={transaction.verification.confirmed ? "Yes" : "No"} />
              <Field label="Ledger version" value={transaction.verification.ledgerVersion ?? "Predates the ledger"} />
              <Field label="Retries" value={transaction.verification.retryCount} />
              {transaction.verification.lastErrorCode ? <Field label="Last error" value={transaction.verification.lastErrorCode} /> : null}
              {transaction.recovery.reason ? <Field label="Recovery reason" value={transaction.recovery.reason} /> : null}
            </dl>
            {transaction.verification.callbacks.length ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Callbacks received</p>
                <ul className="flex flex-wrap gap-2">
                  {transaction.verification.callbacks.map((callback, index) => <li key={`${callback.at}-${index}`} className="rounded border border-border px-2 py-1 text-xs">{callback.status} · {formatDateTime(callback.at)}</li>)}
                </ul>
              </div>
            ) : <p className="text-sm text-muted-foreground">No callback is on record. Bank and TRX invoices do not have one.</p>}
          </CardContent>
        </Card>
      ) : null}

      {transaction.order ? (
        <Card className="min-w-0">
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Order state</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid gap-3 sm:grid-cols-4">
              <Field label="Wallet debit" value={transaction.order.walletDebitStatus ?? "—"} />
              <Field label="Refund" value={transaction.order.refundStatus} />
              {transaction.order.refundAmount != null ? <Field label="Refund amount" value={formatToman(transaction.order.refundAmount)} /> : null}
              {transaction.order.refundReason ? <Field label="Refund reason" value={transaction.order.refundReason} /> : null}
              {transaction.order.errorCode ? <Field label="Error" value={transaction.order.errorCode} /> : null}
              <Field label="Retries" value={transaction.order.retryCount} />
            </dl>
            {transaction.order.transitions.length ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">State changes</p>
                <ol className="space-y-1 text-sm">
                  {transaction.order.transitions.map((item, index) => <li key={`${item.at}-${index}`}>{item.from} → {item.to} <span className="text-xs text-muted-foreground">{formatDateTime(item.at)}</span></li>)}
                </ol>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground">Customer wallet</CardTitle>
          <CardDescription>The ledger around this record.</CardDescription>
        </CardHeader>
        <CardContent><WalletPanel wallet={transaction.wallet} /></CardContent>
      </Card>
    </div>
  );
}
