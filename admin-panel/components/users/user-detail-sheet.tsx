"use client";

import { useEffect, useState } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { PaymentStatusBadge } from "@/components/payments/status-badge";
import { adminGet } from "@/lib/adminApi.client";
import type { UserDetail } from "@/lib/types";
import { formatDateTime, formatToman } from "@/lib/utils";

export function UserDetailSheet({ telegramId, open, onOpenChange }: { telegramId: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !telegramId) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    adminGet<UserDetail>(`/users/${telegramId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch(() => { if (!cancelled) setDetail(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, telegramId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>User detail</SheetTitle>
          <SheetDescription>Telegram ID {telegramId}</SheetDescription>
        </SheetHeader>
        {loading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : detail ? (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Name</p>
                <p className="font-medium">{detail.user.name ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Username</p>
                <p className="font-medium">{detail.user.username ? `@${detail.user.username}` : "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Balance</p>
                <p className="font-medium">{formatToman(detail.user.balance)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Total spent</p>
                <p className="font-medium">{formatToman(detail.totalSpent)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Active / expired VPNs</p>
                <p className="font-medium">{detail.activeVpns} / {detail.expiredVpns}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Status</p>
                <p className="font-medium">
                  {detail.user.isBanned ? <Badge variant="destructive">Blocked</Badge> : <Badge variant="success">Active</Badge>}
                </p>
              </div>
            </div>
            {detail.blockReason ? (
              <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                Blocked {formatDateTime(detail.blockedAt)} by {detail.blockedBy}: {detail.blockReason}
              </p>
            ) : null}

            <Separator />

            <div>
              <h3 className="mb-2 text-sm font-medium">Referral</h3>
              <p className="text-sm text-muted-foreground">
                Code: {detail.referral.code ?? "—"} · Referrals made: {detail.referral.referralCount}
                {detail.referral.referredBy ? ` · Referred by ${detail.referral.referredBy.name ?? detail.referral.referredBy.telegramId}` : ""}
              </p>
            </div>

            <Separator />

            <div>
              <h3 className="mb-2 text-sm font-medium">Recent payments</h3>
              <div className="space-y-2">
                {detail.payments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payments yet.</p>
                ) : (
                  detail.payments.slice(0, 10).map((payment) => (
                    <div key={`${payment.provider}-${payment.id}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">{formatToman(payment.amount)}</p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(payment.createdAt)}</p>
                      </div>
                      <PaymentStatusBadge status={payment.status} />
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">Could not load this user's detail.</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
