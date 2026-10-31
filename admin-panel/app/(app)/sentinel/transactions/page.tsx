import Link from "next/link";

import { adminApiGet } from "@/lib/adminApi.server";
import { PROVIDER_OPTIONS, SEVERITIES, SEVERITY_LABEL, type TransactionPage } from "@/lib/sentinel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { TransactionList } from "@/components/sentinel/transaction-list";
import { UrlFilters } from "@/components/sentinel/url-filters";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

const STATES = [
  { value: "all", label: "Any state" },
  { value: "pending", label: "In progress" },
  { value: "confirmed", label: "Confirmed, not credited" },
  { value: "credited", label: "Credited" },
  { value: "reserved", label: "Funds held" },
  { value: "review", label: "Needs review" },
  { value: "fulfilled", label: "Delivered" },
  { value: "refunded", label: "Refunded" },
  { value: "reversed", label: "Reversed" },
  { value: "failed", label: "Failed or expired" },
];

const AMOUNT = "^[0-9]{1,12}$";
const DATE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";

export default async function SentinelTransactionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const provider = first(params.provider) || "all";
  const state = first(params.state);
  const severity = first(params.severity);
  const reference = first(params.reference);
  const userId = first(params.userId);
  const minAmount = first(params.minAmount);
  const maxAmount = first(params.maxAmount);
  const payCurrency = first(params.payCurrency);
  const from = first(params.from);
  const to = first(params.to);
  const before = first(params.before);

  const query = { provider, state, severity, reference, userId, minAmount, maxAmount, payCurrency, from, to };
  const result = await adminApiGet<TransactionPage>("/sentinel/transactions", { ...query, before, pageSize: 25 });
  const next = new URLSearchParams(Object.entries({ ...query, before: result.nextBefore ?? "" }).filter(([, value]) => value && value !== "all"));

  return (
    <div className="space-y-4">
      <UrlFilters
        filters={[
          { kind: "text", name: "from", label: "From date", value: from, placeholder: "From YYYY-MM-DD", pattern: DATE, width: "w-40" },
          { kind: "text", name: "to", label: "To date", value: to, placeholder: "To YYYY-MM-DD", pattern: DATE, width: "w-40" },
          { kind: "text", name: "reference", label: "Exact reference", value: reference, placeholder: "Payment or order ID", pattern: "^[A-Za-z0-9_.:-]{1,128}$", width: "w-56" },
          { kind: "select", name: "provider", label: "Source", value: provider, options: PROVIDER_OPTIONS },
          { kind: "select", name: "state", label: "State", value: state || "all", width: "w-52", options: STATES },
          { kind: "select", name: "severity", label: "Anomaly severity", value: severity || "all", width: "w-36", options: [{ value: "all", label: "Any anomaly" }, ...SEVERITIES.map((value) => ({ value, label: SEVERITY_LABEL[value] }))] },
          { kind: "text", name: "userId", label: "Customer Telegram ID", value: userId, placeholder: "Telegram ID", pattern: "^[1-9][0-9]{0,19}$", numeric: true },
          { kind: "text", name: "minAmount", label: "Minimum amount in Toman", value: minAmount, placeholder: "Min Toman", pattern: AMOUNT, numeric: true, width: "w-32" },
          { kind: "text", name: "maxAmount", label: "Maximum amount in Toman", value: maxAmount, placeholder: "Max Toman", pattern: AMOUNT, numeric: true, width: "w-32" },
          { kind: "text", name: "payCurrency", label: "Crypto paid in", value: payCurrency, placeholder: "Coin (NOWPayments)", pattern: "^[a-z0-9]{2,16}$", width: "w-44" },
        ]}
      />
      {result.degraded.length ? <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">Some sources did not answer: {result.degraded.join(", ")}.</p> : null}
      <Card>
        <CardContent className="p-0">
          {result.items.length ? <TransactionList items={result.items} /> : <EmptyState title="No transactions" hint="Without a start date, the last 30 days are searched." />}
        </CardContent>
      </Card>
      <div className="flex justify-between">
        {before ? <Button variant="outline" size="sm" asChild><Link href={`/sentinel/transactions?${new URLSearchParams(Object.entries(query).filter(([, value]) => value && value !== "all"))}`}>Newest</Link></Button> : <span />}
        {result.nextBefore ? <Button variant="outline" size="sm" asChild><Link href={`/sentinel/transactions?${next}`}>Older</Link></Button> : null}
      </div>
    </div>
  );
}
