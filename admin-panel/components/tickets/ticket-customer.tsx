"use client";

import { useEffect, useState } from "react";

import { UserAvatar } from "@/components/users/user-avatar";
import { adminGet } from "@/lib/adminApi.client";
import type { AdminUser } from "@/lib/types";

type Profile = Pick<AdminUser, "name" | "username">;

/** Compact customer identity for the conversation header. Only name, @username and Telegram ID are shown; a missing field is simply omitted. */
export function TicketCustomerView({ telegramId, profile }: { telegramId: string; profile: Profile | null }) {
  const name = profile?.name?.trim() || null;
  const username = profile?.username ? `@${profile.username.replace(/^@/, "")}` : null;
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="ticket-customer">
      <UserAvatar telegramId={telegramId} label={name ?? username ?? telegramId} size={32} />
      <div className="min-w-0 text-xs leading-tight">
        {name ? <p className="truncate text-sm font-medium" dir="auto">{name}</p> : null}
        <p className="flex flex-wrap gap-x-2 text-muted-foreground">
          {username ? <span dir="ltr">{username}</span> : null}
          <span>ID <span className="font-mono">{telegramId}</span></span>
        </p>
      </div>
    </div>
  );
}

export function TicketCustomer({ telegramId }: { telegramId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    let cancelled = false;
    adminGet<{ user: Partial<Profile> }>(`/users/${encodeURIComponent(telegramId)}`)
      .then(({ user }) => { if (!cancelled) setProfile({ name: user?.name ?? null, username: user?.username ?? null }); })
      .catch(() => { /* identity is optional; the Telegram ID alone is still shown */ });
    return () => { cancelled = true; };
  }, [telegramId]);
  return <TicketCustomerView telegramId={telegramId} profile={profile} />;
}
