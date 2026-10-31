import { Check, CircleDashed, Minus, TriangleAlert, X } from "lucide-react";

import { BasisTag } from "@/components/sentinel/labels";
import { STAGE_LABEL, type FeedEvent, type FlowStage, type StageState, type WalletView } from "@/lib/sentinel";
import { cn, formatDateTime, formatNumber, formatToman } from "@/lib/utils";

const STATE: Record<StageState, { label: string; icon: typeof Check }> = {
  done: { label: "Done", icon: Check },
  pending: { label: "Not yet", icon: CircleDashed },
  failed: { label: "Failed", icon: X },
  skipped: { label: "Skipped", icon: Minus },
  contradiction: { label: "Contradiction", icon: TriangleAlert },
};

/** Vertical on a phone, horizontal where it fits. A step with no evidence says so instead of showing a guessed time. */
export function LifecycleTrack({ stages }: { stages: FlowStage[] }) {
  return (
    <ol className="mf-track">
      {stages.map((stage) => {
        const { label, icon: Icon } = STATE[stage.state];
        return (
          <li key={stage.stage} className="mf-track-step" data-state={stage.state}>
            <span className="mf-track-dot"><Icon className="h-3.5 w-3.5" aria-hidden /></span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{STAGE_LABEL[stage.stage] ?? stage.stage}</p>
              <p className="text-xs text-muted-foreground"><span className="sr-only">{label}. </span>{stage.at ? formatDateTime(stage.at) : label}</p>
              {stage.detail ? <p className="mt-1 text-xs text-muted-foreground">{stage.detail}</p> : null}
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{stage.source}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function EventTimeline({ events }: { events: FeedEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">No dated events are on record for this.</p>;
  return (
    <ol className="space-y-3 border-l border-border pl-4">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden />
          <p className="text-sm font-medium">{STAGE_LABEL[event.stage] ?? event.stage}{event.stage === "callback" ? `: ${event.status}` : ""}</p>
          <p className="text-xs text-muted-foreground">
            <time dateTime={event.at}>{formatDateTime(event.at)}</time>
            {event.amount != null ? ` · ${formatToman(event.amount)}` : ""}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="break-all font-mono">{event.source}</span>
            <BasisTag basis={event.basis} />
          </p>
        </li>
      ))}
    </ol>
  );
}

const ENTRY_LABEL: Record<string, string> = { credit: "Top-up credit", debit: "Order debit", refund: "Order refund", admin_credit: "Admin credit", admin_debit: "Admin debit" };

export function WalletPanel({ wallet }: { wallet: WalletView }) {
  if (!wallet.available) return <p className="text-sm text-muted-foreground">This customer has no wallet record.</p>;
  const drift = wallet.drift ?? 0;
  const totals = wallet.totals ?? {};
  const inferred = (totals.inferredCredits ?? 0) + (totals.inferredDebits ?? 0) + (totals.inferredRefunds ?? 0) + Math.abs(totals.inferredAdmin ?? 0);
  return (
    <div className="space-y-4">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Stored balance</dt>
          <dd className="font-semibold tabular-nums">{wallet.balance == null ? "—" : formatToman(wallet.balance)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Ledger implies</dt>
          <dd className="font-semibold tabular-nums">{formatToman(wallet.expected ?? 0)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Difference</dt>
          <dd className={cn("font-semibold tabular-nums", drift !== 0 && "text-destructive")}>{drift > 0 ? "+" : ""}{formatToman(drift)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        {wallet.coverage === "complete"
          ? "Complete: every ledger entry resolved to its record, so this difference is exact."
          : `Partial: ${[
            wallet.unresolved ? `${formatNumber(wallet.unresolved)} entries have no record` : null,
            inferred ? `${formatToman(inferred)} comes from records older than the ledger and is inferred` : null,
            wallet.uncountedCredits ? `${formatNumber(wallet.uncountedCredits)} past credits left no trace` : null,
          ].filter(Boolean).join("; ") || "this history cannot be fully rebuilt"}. Treat the difference as a hint.`}
      </p>
      {wallet.entries?.length ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Wallet ledger entries">
          <table className="w-full min-w-[30rem] text-sm">
            <caption className="sr-only">Wallet ledger entries, newest first</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">When</th>
                <th scope="col" className="py-2 pr-3 font-medium">Entry</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Change</th>
                <th scope="col" className="py-2 text-right font-medium">Balance after</th>
              </tr>
            </thead>
            <tbody>
              {wallet.entries.map((entry) => (
                <tr key={entry.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(entry.at)}</td>
                  <td className="py-2 pr-3">
                    <span className="block">{ENTRY_LABEL[entry.type] ?? entry.type}</span>
                    <span className="block break-all font-mono text-[11px] text-muted-foreground">{entry.ledgerKey}</span>
                  </td>
                  <td className={cn("py-2 pr-3 text-right font-medium tabular-nums", (entry.delta ?? 0) < 0 ? "text-warning" : "text-success")}>{(entry.delta ?? 0) > 0 ? "+" : ""}{formatNumber(entry.delta ?? 0)}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">{entry.balanceAfter == null ? "—" : formatNumber(entry.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
