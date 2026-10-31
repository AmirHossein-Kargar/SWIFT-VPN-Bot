import { adminApiGet } from "@/lib/adminApi.server";
import { CLASSIFICATION_LABEL, REVIEW_LABEL, SEVERITIES, SEVERITY_LABEL, type Classification, type FindingSummary, type Review } from "@/lib/sentinel";
import type { PagedResult } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { PaginationNav } from "@/components/shared/pagination-nav";
import { FindingList } from "@/components/sentinel/finding-list";
import { UrlFilters } from "@/components/sentinel/url-filters";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

const CATEGORIES = [
  { value: "payment", label: "Payments" },
  { value: "wallet", label: "Wallets" },
  { value: "order", label: "Orders" },
  { value: "refund", label: "Refunds" },
  { value: "transition", label: "State changes" },
  { value: "stuck", label: "Stuck" },
];

export default async function SentinelReconciliationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const classification = first(params.classification);
  const severity = first(params.severity);
  const category = first(params.category);
  const review = first(params.review);
  const state = first(params.state) || "open";
  const userId = first(params.userId);
  const page = Number(first(params.page)) || 1;

  const result = await adminApiGet<PagedResult<FindingSummary>>("/sentinel/findings", { classification, severity, category, review, state, userId, page, pageSize: 25 });

  return (
    <div className="space-y-4">
      <UrlFilters
        filters={[
          { kind: "select", name: "classification", label: "Evidence", value: classification || "all", options: [{ value: "all", label: "All evidence" }, ...(Object.keys(CLASSIFICATION_LABEL) as Classification[]).map((value) => ({ value, label: CLASSIFICATION_LABEL[value] }))] },
          { kind: "select", name: "severity", label: "Severity", value: severity || "all", width: "w-36", options: [{ value: "all", label: "All severities" }, ...SEVERITIES.map((value) => ({ value, label: SEVERITY_LABEL[value] }))] },
          { kind: "select", name: "category", label: "Area", value: category || "all", width: "w-36", options: [{ value: "all", label: "All areas" }, ...CATEGORIES] },
          { kind: "select", name: "state", label: "Detection state", value: state, width: "w-36", options: [{ value: "open", label: "Open" }, { value: "cleared", label: "Cleared" }, { value: "all", label: "Open and cleared" }] },
          { kind: "select", name: "review", label: "Review status", value: review || "all", options: [{ value: "all", label: "Not dismissed" }, ...(Object.keys(REVIEW_LABEL) as Review[]).map((value) => ({ value, label: REVIEW_LABEL[value] }))] },
          { kind: "text", name: "userId", label: "Customer Telegram ID", value: userId, placeholder: "Telegram ID", pattern: "^[1-9][0-9]{0,19}$", numeric: true },
        ]}
      />
      <p className="text-sm text-muted-foreground">{result.total.toLocaleString("en-US")} {result.total === 1 ? "finding" : "findings"}. One problem is one row, however many times it was checked.</p>
      <Card>
        <CardContent className="p-0">
          {result.items.length ? (
            <div className="px-4"><FindingList items={result.items} /></div>
          ) : (
            <EmptyState title="Nothing here" hint="No finding matches. The check runs on its own every few minutes." />
          )}
        </CardContent>
      </Card>
      <PaginationNav page={result.page} pages={result.pages} />
    </div>
  );
}
