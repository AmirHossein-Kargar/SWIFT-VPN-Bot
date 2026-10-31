import Link from "next/link";
import { ArrowLeft, CircleCheck, ExternalLink, FlaskConical, ShieldCheck } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ClassificationBadge, ReviewBadge, SeverityBadge } from "@/components/sentinel/labels";
import { FindingList } from "@/components/sentinel/finding-list";
import { FindingReview } from "@/components/sentinel/finding-review";
import { EventTimeline, WalletPanel } from "@/components/sentinel/lifecycle";
import { DIRECTION_LABEL, REVIEW_LABEL, type FindingDetail, type Review } from "@/lib/sentinel";
import { cn, formatDateTime, formatToman } from "@/lib/utils";

const RISK_LABEL = { none: "No risk", low: "Low risk", medium: "Needs care", high: "Moves money" } as const;

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function refHref(ref: { type: string; key: string }) {
  if (ref.type === "payment" || ref.type === "order") return `/sentinel/transactions/${encodeURIComponent(ref.key)}`;
  if (ref.type === "user") return `/users?search=${encodeURIComponent(ref.key.replace("user:", ""))}`;
  if (ref.type === "audit") return "/audit";
  return null;
}

export function FindingDetailView({ finding }: { finding: FindingDetail }) {
  const reproduces = finding.revalidation.stillReproduces;
  const factEntries = Object.entries(finding.facts ?? {}).filter(([, value]) => value != null && typeof value !== "object");

  return (
    <div className="space-y-4">
      <Link href="/sentinel/reconciliation" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" aria-hidden />Reconciliation</Link>

      <section className="mf-surface p-5" aria-labelledby="mf-finding-title">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <ClassificationBadge classification={finding.classification} />
          {finding.state === "cleared" ? <span className="text-xs font-medium text-muted-foreground">Cleared {formatDateTime(finding.clearedAt)}</span> : <ReviewBadge review={finding.review} />}
        </div>
        <h2 id="mf-finding-title" className="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">{finding.explanation.title}</h2>
        {finding.explanation.why ? <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{finding.explanation.why}</p> : null}
        <p className={cn("mt-4 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium", reproduces ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success")} role="status">
          {reproduces ? <FlaskConical className="h-4 w-4" aria-hidden /> : <CircleCheck className="h-4 w-4" aria-hidden />}
          {reproduces ? "Rechecked just now: still reproduces" : "Rechecked just now: the records no longer show this"}
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Expected and observed</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-3">
              <Fact label="Expected" value={finding.expected ?? "—"} />
              <Fact label="Observed" value={finding.observed ?? "—"} />
              {finding.amountToman > 0 ? <Fact label="Amount at stake" value={`${formatToman(finding.amountToman)}, ${DIRECTION_LABEL[finding.direction].toLowerCase()}`} /> : null}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-foreground">Likely cause</CardTitle>
            <CardDescription>A hypothesis. The proven part is on the left and in the evidence below.</CardDescription>
          </CardHeader>
          <CardContent><p className="text-sm">{finding.explanation.likelyCause ?? "Not known."}</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground">Safe ways forward</CardTitle>
          <CardDescription className="flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-success" aria-hidden />Sentinel changes no money. Each option is carried out in its own audited tool, by a person.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {finding.explanation.options.map((option) => (
              <li key={option.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{option.label}</p>
                  <span className="text-xs text-muted-foreground">{RISK_LABEL[option.risk]}{option.amountToman ? ` · ${formatToman(option.amountToman)}` : ""}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{option.consequence}</p>
                {option.href ? <Link href={option.href} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">Open {option.tool}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></Link> : null}
              </li>
            ))}
          </ul>
          <div className="mt-4"><FindingReview finding={finding} /></div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Evidence</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Fact label="Rule" value={<code className="text-xs">{finding.code}</code>} />
              <Fact label="First detected" value={formatDateTime(finding.firstDetectedAt)} />
              <Fact label="Last detected" value={formatDateTime(finding.lastDetectedAt)} />
              <Fact label="Customer" value={finding.userId} />
              {factEntries.map(([key, value]) => <Fact key={key} label={key} value={String(value)} />)}
            </dl>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Records</p>
              <ul className="space-y-1">
                {finding.refs.map((ref) => {
                  const href = refHref(ref);
                  return <li key={`${ref.type}:${ref.key}`} className="break-all font-mono text-xs">{href ? <Link href={href} className="text-primary underline-offset-4 hover:underline">{ref.key}</Link> : ref.key}</li>;
                })}
              </ul>
            </div>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Timeline</CardTitle></CardHeader>
          <CardContent><EventTimeline events={finding.timeline} /></CardContent>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-foreground">Customer wallet</CardTitle>
          <CardDescription>{finding.impact.note}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <Fact label="Owed to this customer" value={formatToman(finding.impact.customer.owedToCustomers)} />
            <Fact label="Excess in this wallet" value={formatToman(finding.impact.customer.excessInWallets)} />
            <Fact label="Other live problems" value={finding.revalidation.otherLiveProblems} />
          </dl>
          <WalletPanel wallet={finding.wallet} />
        </CardContent>
      </Card>

      {finding.related.length ? (
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-foreground">Related findings</CardTitle></CardHeader>
          <CardContent><FindingList items={finding.related} /></CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-foreground">Decision history</CardTitle></CardHeader>
        <CardContent>
          {finding.reviewHistory.length ? (
            <ol className="space-y-3">
              {finding.reviewHistory.map((entry) => (
                <li key={`${entry.at}-${entry.to}`} className="text-sm">
                  <p className="font-medium">{REVIEW_LABEL[entry.to as Review] ?? entry.to}{entry.optionId ? ` · ${finding.explanation.options.find((option) => option.id === entry.optionId)?.label ?? entry.optionId}` : ""}</p>
                  <p className="text-muted-foreground">{entry.reason}</p>
                  <p className="text-xs text-muted-foreground">{entry.actor} · {formatDateTime(entry.at)}</p>
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-muted-foreground">No decisions yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
