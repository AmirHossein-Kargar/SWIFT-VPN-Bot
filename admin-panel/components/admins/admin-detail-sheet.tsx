"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, RefreshCw } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PresenceIndicator, STATUS_BADGE } from "@/components/admins/admin-card";
import { UserAvatar } from "@/components/users/user-avatar";
import { adminGet } from "@/lib/adminApi.client";
import {
  NOT_RECORDED, ROLE_LABELS, SOURCE_LABELS, STATUS_LABELS, actionLabel, adminLabel, blockExplanation, formatSince, presenceLabel, telegramProfileUrl,
  type AdminAuditRow, type AdminProfile, type AdminProfileDetail,
} from "@/lib/admin-directory";
import { describeError } from "@/lib/errors";
import { cn, formatDateTime, formatNumber } from "@/lib/utils";

function Field({ label, children, missing }: { label: string; children?: React.ReactNode; missing?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("break-words text-sm", missing ? "text-muted-foreground" : "font-medium")}>{children}</dd>
    </div>
  );
}

function DateField({ label, value, missing = "Not recorded", generatedAt }: { label: string; value: string | null; missing?: string; generatedAt: string }) {
  if (!value) return <Field label={label} missing>{missing}</Field>;
  return <Field label={label}>{formatDateTime(value)} <span className="block text-xs font-normal text-muted-foreground">{formatSince(value, generatedAt)}</span></Field>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xl font-semibold tracking-tight">{formatNumber(value)}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

function statusVariant(status: string) {
  if (status === "succeeded") return "success" as const;
  return status === "failed" ? "destructive" as const : "outline" as const;
}

function AuditRow({ row, detail }: { row: AdminAuditRow; detail: string | null }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{actionLabel(row.action)}</p>
        <p className="truncate text-xs text-muted-foreground">{formatDateTime(row.createdAt)}{detail ? ` · ${detail}` : ""}</p>
      </div>
      <Badge variant={statusVariant(row.status)} className="shrink-0">{row.status}</Badge>
    </li>
  );
}

function ProfileTab({ detail }: { detail: AdminProfileDetail }) {
  const { profile, generatedAt } = detail;
  const profileUrl = telegramProfileUrl(profile.username);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-4 rounded-md border border-border p-4">
        <Field label="Full name" missing={!profile.name}>{profile.name ? <span dir="auto">{profile.name}</span> : profile.hasBotProfile ? "Not shared with the bot" : "No bot profile"}</Field>
        <Field label="Display name" missing={!profile.displayName}>{profile.displayName ? <span dir="auto">{profile.displayName}</span> : "Not set"}</Field>
        <Field label="Username" missing={!profile.username}>
          {profileUrl ? <a href={profileUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">@{profile.username}</a> : profile.username ? `@${profile.username}` : "No username on record"}
        </Field>
        <Field label="Telegram ID"><span className="font-mono">{profile.telegramId}</span></Field>
        <Field label="Role">{ROLE_LABELS[profile.role]}</Field>
        <Field label="Listed through">{SOURCE_LABELS[profile.source]}</Field>
        <DateField label="Joined the bot" value={profile.joinedAt} missing={profile.hasBotProfile ? "Not recorded" : "No bot profile"} generatedAt={generatedAt} />
        <DateField label="Admin since" value={profile.adminSince} missing={profile.source === "environment" ? "Not recorded for ADMINS entries" : "Not recorded"} generatedAt={generatedAt} />
        <Field label="Added by" missing={!profile.addedBy}>{profile.addedBy ?? (profile.source === "environment" ? "Server configuration" : "Not recorded")}</Field>
        {profile.status === "removed" ? <DateField label="Removed" value={profile.removedAt} generatedAt={generatedAt} /> : null}
        {profile.status === "removed" ? <Field label="Removed by" missing={!profile.removedBy}>{profile.removedBy ?? "Not recorded"}</Field> : null}
      </dl>
      {!profile.hasBotProfile ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          This account has not messaged the bot, so Telegram&apos;s name, username, photo and join date are not available.
        </p>
      ) : null}
      {profile.block ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{profile.block.kind === "by_admin" ? "Blocked in the bot" : "This account blocked the bot"}</p>
          <p className="mt-1 text-muted-foreground">{blockExplanation(profile.block)}</p>
          {profile.block.at || profile.block.by || profile.block.reason ? (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {[profile.block.at ? formatDateTime(profile.block.at) : null, profile.block.by ? `by ${profile.block.by}` : null, profile.block.reason].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ActivityTab({ detail }: { detail: AdminProfileDetail }) {
  const { stats, recentActions, profile, generatedAt } = detail;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Events, 7 days" value={stats.eventsLast7Days} />
        <Stat label="Events, 30 days" value={stats.eventsLast30Days} />
        <Stat label="Failed, 30 days" value={stats.failedLast30Days} />
        <Stat label="All time" value={stats.totalEvents} />
      </div>
      <dl className="grid grid-cols-2 gap-4">
        <DateField label="Last audited event" value={profile.lastActionAt} missing="None recorded" generatedAt={generatedAt} />
        <DateField label="Last panel request" value={profile.lastSeenAt} missing="None recorded" generatedAt={generatedAt} />
      </dl>

      <section className="space-y-2" aria-label="Most frequent actions">
        <SectionTitle>Most frequent, 30 days</SectionTitle>
        {stats.topActions.length === 0 ? <p className="text-sm text-muted-foreground">No audited events in the last 30 days.</p> : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {stats.topActions.map((row) => (
              <li key={row.action} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">{actionLabel(row.action)}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatNumber(row.count)}{row.failed > 0 ? ` (${formatNumber(row.failed)} failed)` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-label="Recent actions">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle>Recent actions</SectionTitle>
          <Link href={`/audit?actor=${encodeURIComponent(profile.telegramId)}`} className="inline-flex items-center gap-1 text-xs underline underline-offset-2">
            Open audit log<ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>
        {recentActions.length === 0 ? <p className="text-sm text-muted-foreground">No actions recorded. Sign-ins are listed under Security.</p> : (
          <ul className="space-y-2">
            {recentActions.map((row, index) => (
              <AuditRow key={`${row.createdAt}-${index}`} row={row} detail={[row.targetType, row.targetId].filter(Boolean).join(" ") || null} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SecurityTab({ detail }: { detail: AdminProfileDetail }) {
  const { profile, stats, sessionHistory, accountHistory, presence, generatedAt } = detail;
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-4 rounded-md border border-border p-4">
        <DateField label="Last sign-in" value={profile.lastLoginAt} missing="None recorded" generatedAt={generatedAt} />
        <DateField label="Last sign-out" value={profile.lastLogoutAt} missing="None recorded" generatedAt={generatedAt} />
        <Field label="Sign-ins, 30 days">{formatNumber(stats.signInsLast30Days)}</Field>
        <Field label="Panel status" missing={profile.presence.state === "unknown"}>{presenceLabel(profile.presence)}</Field>
      </dl>
      <p className="text-xs text-muted-foreground">
        {presence.available
          ? `Online means a signed-in panel request in the last ${Math.round(presence.windowSeconds / 60)} minutes. Telegram panel use does not count.`
          : "Panel status needs Redis, which could not be read just now."}
      </p>

      <section className="space-y-2" aria-label="Web sign-in history">
        <SectionTitle>Web sign-in history</SectionTitle>
        {sessionHistory.length === 0 ? <p className="text-sm text-muted-foreground">No web sign-ins recorded. The Telegram panel has no sign-in step.</p> : (
          <ul className="space-y-2">
            {sessionHistory.map((row, index) => (
              <AuditRow key={`${row.createdAt}-${index}`} row={{ ...row, action: row.action === "ADMIN_LOGIN" ? "SIGNED_IN" : "SIGNED_OUT" }} detail={row.ipAddress ? `IP ${row.ipAddress}` : "IP not recorded"} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-label="Account changes">
        <SectionTitle>Account changes</SectionTitle>
        {accountHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">{profile.source === "environment" ? "None recorded. ADMINS changes happen in server configuration." : "None recorded."}</p>
        ) : (
          <ul className="space-y-2">
            {accountHistory.map((row, index) => <AuditRow key={`${row.createdAt}-${index}`} row={row} detail={row.actorTelegramId ? `by ${row.actorTelegramId}` : null} />)}
          </ul>
        )}
      </section>

      <section className="space-y-2 rounded-md border border-dashed border-border p-3" aria-label="Not recorded">
        <SectionTitle>Not recorded by this system</SectionTitle>
        <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
          {NOT_RECORDED.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>
    </div>
  );
}

/**
 * `admin` is the row already on screen, so the header is right straight away and survives a failed load. The history is
 * fetched when the drawer opens, because the list does not need it.
 */
export function AdminDetailSheet({ admin, open, onOpenChange, onCloseAutoFocus }: { admin: AdminProfile | null; open: boolean; onOpenChange: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  const [detail, setDetail] = useState<AdminProfileDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const telegramId = admin?.telegramId ?? null;

  const load = useCallback(async (id: string, signal: { cancelled: boolean }) => {
    setDetail(null);
    setLoadError(null);
    try {
      const data = await adminGet<AdminProfileDetail>(`/admins/directory/${encodeURIComponent(id)}`);
      if (!signal.cancelled) setDetail(data);
    } catch (error) {
      if (!signal.cancelled) setLoadError(describeError(error, "Could not load this profile."));
    }
  }, []);

  useEffect(() => {
    if (!open || !telegramId) return;
    const signal = { cancelled: false };
    void load(telegramId, signal);
    return () => { signal.cancelled = true; };
  }, [open, telegramId, load]);

  const shown = detail?.profile ?? admin;
  const label = shown ? adminLabel(shown) : "Admin profile";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl" onCloseAutoFocus={onCloseAutoFocus}>
        <SheetHeader>
          <div className="flex items-center gap-3">
            {shown ? <UserAvatar key={shown.telegramId} telegramId={shown.telegramId} label={label} noPhoto={!shown.hasBotProfile} /> : null}
            <div className="min-w-0 space-y-1 text-left">
              <SheetTitle className="break-words" dir="auto">{label}</SheetTitle>
              <SheetDescription className="break-all">Telegram ID {shown?.telegramId}{shown?.username ? ` · @${shown.username}` : ""}</SheetDescription>
            </div>
          </div>
          {shown ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge variant={shown.role === "owner" ? "default" : "secondary"}>{ROLE_LABELS[shown.role]}</Badge>
              <Badge variant={STATUS_BADGE[shown.status]}>{STATUS_LABELS[shown.status]}</Badge>
              <PresenceIndicator presence={shown.presence} />
            </div>
          ) : null}
        </SheetHeader>

        {detail ? (
          <Tabs defaultValue="profile" className="mt-5">
            <TabsList>
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="security">Security</TabsTrigger>
            </TabsList>
            <TabsContent value="profile"><ProfileTab detail={detail} /></TabsContent>
            <TabsContent value="activity"><ActivityTab detail={detail} /></TabsContent>
            <TabsContent value="security"><SecurityTab detail={detail} /></TabsContent>
          </Tabs>
        ) : loadError ? (
          <div role="alert" className="mt-6 flex flex-col items-center gap-2 py-8 text-center">
            <AlertTriangle className="h-6 w-6 text-warning" aria-hidden />
            <p className="text-sm text-muted-foreground">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => { if (telegramId) void load(telegramId, { cancelled: false }); }}>
              <RefreshCw className="h-4 w-4" />Try again
            </Button>
          </div>
        ) : (
          <div className="mt-6 space-y-3" role="status" aria-label="Loading profile">
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
