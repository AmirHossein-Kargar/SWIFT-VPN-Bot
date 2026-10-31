import { adminApiGet } from "@/lib/adminApi.server";
import type { SyncStatus } from "@/lib/sentinel";
import { SentinelTabs } from "@/components/sentinel/sentinel-tabs";
import { SyncStatusBar } from "@/components/sentinel/sync-status";

export const dynamic = "force-dynamic";

export default async function SentinelLayout({ children }: { children: React.ReactNode }) {
  const sync = await adminApiGet<SyncStatus>("/sentinel/sync").catch(() => null);

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Money Flow Sentinel</h1>
            <p className="text-sm text-muted-foreground">Traces every Toman from payment to service, and explains what does not add up. It never changes money.</p>
          </div>
          <SyncStatusBar initial={sync} />
        </div>
        <SentinelTabs />
      </header>
      {children}
    </div>
  );
}
