"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, FlaskConical, MessageSquare, MinusCircle, PlusCircle, ShieldCheck } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { BalanceDialog } from "@/components/users/balance-dialog";
import { BlockDialog } from "@/components/users/block-dialog";
import { MessageDialog } from "@/components/users/message-dialog";
import { UserAvatar } from "@/components/users/user-avatar";
import { ResetEligibilityDialog } from "@/components/users/reset-eligibility-dialog";
import { adminGet } from "@/lib/adminApi.client";
import { describeError } from "@/lib/errors";
import type { UserDetail } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";

type Action = "credit" | "debit" | "message" | "block" | "eligibility" | null;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

function testServiceLabel(testService: UserDetail["testService"]) {
  if (testService.inFlight) return <Badge variant="warning">In progress · {testService.status}</Badge>;
  if (testService.eligible) return <Badge variant="success">Eligible</Badge>;
  if (testService.received) return <Badge variant="muted">Already received</Badge>;
  return <Badge variant="outline">{testService.status ?? "Unknown"}</Badge>;
}

export function UserDetailSheet({ telegramId, open, onOpenChange }: { telegramId: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);

  const load = useCallback(async (id: string, signal?: { cancelled: boolean }) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await adminGet<UserDetail>(`/users/${encodeURIComponent(id)}`);
      if (!signal?.cancelled) setDetail(data);
    } catch (error) {
      if (!signal?.cancelled) { setDetail(null); setLoadError(describeError(error, "Could not load this user's detail.")); }
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open || !telegramId) return;
    const signal = { cancelled: false };
    setDetail(null);
    load(telegramId, signal);
    return () => { signal.cancelled = true; };
  }, [open, telegramId, load]);

  const afterAction = () => {
    if (telegramId) load(telegramId);
    router.refresh();
  };

  const user = detail?.user;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <div className="flex items-center gap-3">
              {telegramId ? <UserAvatar key={telegramId} telegramId={telegramId} label={user ? user.name ?? user.username ?? telegramId : telegramId} /> : null}
              <div className="min-w-0 space-y-1 text-left">
                <SheetTitle className="break-words">{user ? user.name ?? (user.username ? `@${user.username}` : user.telegramId) : "User detail"}</SheetTitle>
                <SheetDescription className="break-all">Telegram ID {telegramId}{user?.username ? ` · @${user.username}` : ""}</SheetDescription>
              </div>
            </div>
          </SheetHeader>

          {loading && !detail ? (
            <div className="mt-6 space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : detail && user ? (
            <div className="mt-6 space-y-5">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setAction("credit")}><PlusCircle className="h-4 w-4" />Credit</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("debit")} disabled={user.balance <= 0} title={user.balance <= 0 ? "Wallet is empty" : undefined}><MinusCircle className="h-4 w-4" />Debit</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("message")}><MessageSquare className="h-4 w-4" />Message</Button>
                <Button size="sm" variant="outline" onClick={() => setAction("eligibility")} disabled={detail.testService.eligible} title={detail.testService.eligible ? "Already eligible" : undefined}><FlaskConical className="h-4 w-4" />Restore test</Button>
                <Button size="sm" variant={user.isBanned ? "outline" : "destructive"} onClick={() => setAction("block")}>
                  {user.isBanned ? <ShieldCheck className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
                  {user.isBanned ? "Unblock" : "Block"}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-4 rounded-md border border-border p-4">
                <Field label="Wallet balance"><span className="text-base">{formatToman(user.balance)}</span></Field>
                <Field label="Total spent">{formatToman(detail.totalSpent)}</Field>
                <Field label="Successful payments">{user.successfulPayments}</Field>
                <Field label="Active / expired VPNs">{detail.activeVpns} / {detail.expiredVpns}</Field>
                <Field label="Status">{user.isBanned ? <Badge variant="destructive">Blocked</Badge> : <Badge variant="success">Active</Badge>}</Field>
                <Field label="Test service">{testServiceLabel(detail.testService)}</Field>
                <Field label="Registered">{formatDateTime(user.createdAt)}</Field>
                <Field label="Last active">{formatDateTime(user.lastActivityAt)}</Field>
              </div>

              {user.isBanned ? (
                <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  {detail.blockedBy === "system"
                    ? "Flagged automatically because the user blocked the bot. This flag does not restrict access."
                    : `Blocked ${formatDateTime(detail.blockedAt)} by ${detail.blockedBy ?? "unknown"}${detail.blockReason ? `: ${detail.blockReason}` : ""}`}
                </p>
              ) : null}

              <Separator />

              <Tabs defaultValue="payments">
                <TabsList>
                  <TabsTrigger value="payments">Payments</TabsTrigger>
                  <TabsTrigger value="orders">Orders</TabsTrigger>
                  <TabsTrigger value="services">Services</TabsTrigger>
                  <TabsTrigger value="referral">Referral</TabsTrigger>
                </TabsList>

                <TabsContent value="payments" className="space-y-2">
                  {detail.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payments yet.</p> : detail.payments.map((payment) => (
                    <div key={`${payment.provider}-${payment.id}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">{formatToman(payment.amount)} <span className="text-xs font-normal text-muted-foreground">· {payment.provider}</span></p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(payment.createdAt)}</p>
                      </div>
                      <PaymentStatusBadge status={payment.status} />
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="orders" className="space-y-2">
                  {detail.orders.length === 0 ? <p className="text-sm text-muted-foreground">No tracked purchases.</p> : detail.orders.map((order) => (
                    <div key={order.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">{order.product} <span className="text-xs font-normal text-muted-foreground">· {formatToman(order.amount)}</span></p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(order.createdAt)}{order.serviceUsername ? ` · ${order.serviceUsername}` : ""}</p>
                      </div>
                      <Badge variant={order.status === "completed" ? "success" : order.status === "refunded" || order.status === "failed" ? "destructive" : "outline"}>{order.status}</Badge>
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="services" className="space-y-2">
                  {detail.services.length === 0 ? <p className="text-sm text-muted-foreground">No VPN services.</p> : detail.services.map((service, index) => {
                    const expired = service.revokedAt || (service.expiresAt && new Date(service.expiresAt) < new Date());
                    return (
                      <div key={`${service.username}-${index}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                        <div>
                          <p className="font-mono text-xs">{service.username}</p>
                          <p className="text-xs text-muted-foreground">Expires {formatDateTime(service.expiresAt)}</p>
                        </div>
                        <Badge variant={service.revokedAt ? "destructive" : expired ? "muted" : "success"}>{service.revokedAt ? "Revoked" : expired ? "Expired" : "Active"}</Badge>
                      </div>
                    );
                  })}
                </TabsContent>

                <TabsContent value="referral">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <Field label="Code">{detail.referral.code ?? "—"}</Field>
                    <Field label="Referrals made">{detail.referral.referralCount}</Field>
                    <Field label="Referred by">{detail.referral.referredBy ? detail.referral.referredBy.name ?? detail.referral.referredBy.telegramId : "—"}</Field>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <p className="mt-6 text-sm text-muted-foreground">{loadError ?? "Could not load this user's detail."}</p>
          )}
        </SheetContent>
      </Sheet>

      {user ? (
        <>
          <BalanceDialog user={user} direction="add" open={action === "credit"} onOpenChange={(next) => !next && setAction(null)} onDone={afterAction} />
          <BalanceDialog user={user} direction="remove" open={action === "debit"} onOpenChange={(next) => !next && setAction(null)} onDone={afterAction} />
          <MessageDialog user={user} open={action === "message"} onOpenChange={(next) => !next && setAction(null)} />
          <BlockDialog user={user} open={action === "block"} onOpenChange={(next) => !next && setAction(null)} onDone={afterAction} />
          <ResetEligibilityDialog user={user} testService={detail?.testService} open={action === "eligibility"} onOpenChange={(next) => !next && setAction(null)} onDone={afterAction} />
        </>
      ) : null}
    </>
  );
}
