"use client";

import { Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/users/user-avatar";
import { ROLE_LABELS, STATUS_LABELS, adminLabel, auditedEvents, formatSince, presenceLabel, type AdminProfile } from "@/lib/admin-directory";
import { cn, formatDate } from "@/lib/utils";

export const STATUS_BADGE = { active: "success", blocked: "warning", removed: "muted" } as const;

export function PresenceIndicator({ presence }: { presence: AdminProfile["presence"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-presence={presence.state}>
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          presence.state === "online" && "bg-success",
          presence.state === "offline" && "bg-muted-foreground/60",
          presence.state === "unknown" && "border border-muted-foreground/60",
        )}
      />
      {presenceLabel(presence)}
    </span>
  );
}

function Fact({ label, value, missing }: { label: string; value: string | null; missing: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-sm", value ? "font-medium" : "text-muted-foreground")}>{value ?? missing}</dd>
    </div>
  );
}

export function AdminCard({ admin, generatedAt, onOpen, onRemove }: { admin: AdminProfile; generatedAt: string; onOpen: () => void; onRemove: () => void }) {
  const label = adminLabel(admin);
  const removable = admin.source === "database" && admin.role !== "owner" && admin.status !== "removed";

  return (
    <article
      data-testid={`admin-card-${admin.telegramId}`}
      className={cn(
        "relative flex min-w-0 flex-col rounded-lg border border-border bg-card text-card-foreground shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring hover:shadow-md",
        admin.status === "removed" && "bg-muted/40",
      )}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <UserAvatar key={admin.telegramId} telegramId={admin.telegramId} label={label} noPhoto={!admin.hasBotProfile} />
        <div className="min-w-0 flex-1">
          {/* The stretched ::after makes the whole card open the profile, while Remove below stays its own button. */}
          <button type="button" onClick={onOpen} className="block max-w-full truncate text-left font-semibold outline-none after:absolute after:inset-0 after:rounded-lg after:content-['']" dir="auto">
            {label}
          </button>
          <p className="truncate text-sm text-muted-foreground" dir="auto">{admin.username ? `@${admin.username}` : "No username on record"}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">ID {admin.telegramId}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4">
        <Badge variant={admin.role === "owner" ? "default" : "secondary"}>{ROLE_LABELS[admin.role]}</Badge>
        <Badge variant={STATUS_BADGE[admin.status]}>{STATUS_LABELS[admin.status]}</Badge>
        <PresenceIndicator presence={admin.presence} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border p-4">
        <Fact label="Joined the bot" value={admin.joinedAt ? formatDate(admin.joinedAt) : null} missing={admin.hasBotProfile ? "Not recorded" : "No bot profile"} />
        <Fact label="Admin since" value={admin.adminSince ? formatDate(admin.adminSince) : null} missing="Not recorded" />
        <Fact label="Last sign-in" value={formatSince(admin.lastLoginAt, generatedAt)} missing="None recorded" />
        <Fact label="Last activity" value={formatSince(admin.lastActivityAt, generatedAt)} missing="None recorded" />
      </dl>

      <div className="mt-auto flex min-h-12 items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">{auditedEvents(admin.eventsLast30Days)}, 30 days</span>
        {removable ? (
          <Button variant="ghost" size="icon" className="relative z-10" aria-label={`Remove ${admin.telegramId}`} onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </article>
  );
}
