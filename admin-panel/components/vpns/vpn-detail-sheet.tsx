"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VpnActionDialog, type VpnAction } from "@/components/vpns/vpn-action-dialog";
import { adminGet, adminMutate, newOperationId } from "@/lib/adminApi.client";
import { useAdminSession } from "@/components/session-provider";
import { AdminApiError } from "@/lib/types";
import type { VpnDetail } from "@/lib/types";
import { formatDateTime, formatNumber } from "@/lib/utils";

export function VpnDetailSheet({ clientId, open, onOpenChange }: { clientId: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
  const [detail, setDetail] = useState<VpnDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [changingLink, setChangingLink] = useState(false);
  const [actionDialog, setActionDialog] = useState<VpnAction | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!open || !clientId) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    adminGet<VpnDetail>(`/vpns/${clientId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, clientId, refreshKey]);

  async function changeLink() {
    if (!clientId) return;
    setChangingLink(true);
    try {
      await adminMutate(`/vpns/${clientId}/actions`, "POST", csrfToken, { operationId: newOperationId(), action: "change-link" });
      toast.success("Connection link rotated.");
      setRefreshKey((key) => key + 1);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not change the link.");
    } finally {
      setChangingLink(false);
    }
  }

  function afterAction() {
    setRefreshKey((key) => key + 1);
    router.refresh();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>VPN service detail</SheetTitle>
          <SheetDescription>{clientId}</SheetDescription>
        </SheetHeader>
        {loading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detail ? (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Owner</p>
                <p className="font-medium">{detail.user.name ?? detail.user.username ?? detail.user.telegramId}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Plan</p>
                <p className="font-medium">{detail.product ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Expires</p>
                <p className="font-medium">{formatDateTime(detail.expiresAt)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Traffic</p>
                <p className="font-medium">
                  {detail.trafficUsed ?? "—"} {detail.unlimited ? "/ Unlimited" : detail.trafficGb != null ? `/ ${formatNumber(detail.trafficGb)} GB` : ""}
                </p>
                {detail.trafficRemainingGb != null ? <p className="text-xs text-muted-foreground">{formatNumber(detail.trafficRemainingGb)} GB left</p> : null}
              </div>
              <div>
                <p className="text-muted-foreground">Status</p>
                <p className="font-medium">
                  <Badge variant={detail.status === "revoked" ? "muted" : detail.wizardStatus === "active" ? "success" : "outline"}>
                    {detail.status}
                  </Badge>
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">WizardXray panel</p>
                <p className="font-medium">
                  <Badge variant={detail.wizardXray.status === "connected" ? "success" : detail.wizardXray.status === "stale" ? "warning" : "destructive"}>
                    {detail.wizardXray.status}
                  </Badge>
                </p>
              </div>
            </div>
            {detail.wizardXray.error ? (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{detail.wizardXray.error}</p>
            ) : null}

            <Separator />

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!detail.availableActions.changeLink || changingLink} onClick={changeLink}>
                {changingLink ? "Changing…" : "Change link"}
              </Button>
              <Button variant="outline" size="sm" disabled={!detail.availableActions.extendTime} onClick={() => setActionDialog("extend-time")}>
                Extend time
              </Button>
              <Button variant="outline" size="sm" disabled={!detail.availableActions.increaseTraffic} onClick={() => setActionDialog("increase-traffic")}>
                Add traffic
              </Button>
              <Button variant="outline" size="sm" disabled={!detail.availableActions.renew} onClick={() => setActionDialog("renew")}>
                Renew
              </Button>
              {detail.availableActions.enable ? (
                <Button variant="outline" size="sm" onClick={() => setActionDialog("enable")}>
                  Enable
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={!detail.availableActions.disable} onClick={() => setActionDialog("disable")}>
                  Disable
                </Button>
              )}
              <Button variant="destructive" size="sm" disabled={!detail.availableActions.revoke} onClick={() => setActionDialog("revoke")}>
                Revoke
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">Could not load this service's detail.</p>
        )}
      </SheetContent>

      {clientId && actionDialog ? (
        <VpnActionDialog
          clientId={clientId}
          action={actionDialog}
          unlimited={detail?.unlimited ?? false}
          open={Boolean(actionDialog)}
          onOpenChange={(nextOpen) => !nextOpen && setActionDialog(null)}
          onDone={afterAction}
        />
      ) : null}
    </Sheet>
  );
}
