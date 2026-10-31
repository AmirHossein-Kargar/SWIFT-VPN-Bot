import { adminApiGet } from "@/lib/adminApi.server";
import type { Snapshot } from "@/lib/reliability";
import { ConnectionStatus } from "@/components/reliability/connection-status";
import { ReliabilityFeedProvider } from "@/components/reliability/feed-provider";
import { ReliabilityTabs } from "@/components/reliability/reliability-tabs";

export const dynamic = "force-dynamic";

export default async function ReliabilityLayout({ children }: { children: React.ReactNode }) {
  // A failed read renders the disconnected state rather than an error page: this section must still open during an outage.
  const snapshot = await adminApiGet<Snapshot>("/reliability/snapshot").catch(() => null);

  return (
    <ReliabilityFeedProvider initial={snapshot}>
      <div className="space-y-4">
        <header className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Service Reliability Center</h1>
              <p className="text-sm text-muted-foreground">Is the system working, what is not, who is affected, and what shows it. It reads and reports; it changes nothing.</p>
            </div>
            <ConnectionStatus />
          </div>
          <ReliabilityTabs />
        </header>
        {children}
      </div>
    </ReliabilityFeedProvider>
  );
}
