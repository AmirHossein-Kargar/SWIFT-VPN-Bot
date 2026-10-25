"use client";

import { useEffect, useRef, useState } from "react";

import { UserAvatar } from "@/components/users/user-avatar";
import { UserDetailSheet } from "@/components/users/user-detail-sheet";
import { adminGet } from "@/lib/adminApi.client";
import type { AdminUser } from "@/lib/types";

type Profile = Pick<AdminUser, "name" | "username">;

/** Compact customer identity for the conversation header. Only name, @username and Telegram ID are shown; a missing field is simply omitted. */
export function TicketCustomerView({ telegramId, profile, onOpen, buttonRef }: { telegramId: string; profile: Profile | null; onOpen?: () => void; buttonRef?: React.Ref<HTMLButtonElement> }) {
  const name = profile?.name?.trim() || null;
  const username = profile?.username ? `@${profile.username.replace(/^@/, "")}` : null;
  const content = (
    <>
      <UserAvatar telegramId={telegramId} label={name ?? username ?? telegramId} size={32} />
      <div className="min-w-0 text-xs leading-tight">
        {name ? <p className="truncate text-sm font-medium" dir="auto">{name}</p> : null}
        <p className="flex flex-wrap gap-x-2 text-muted-foreground">
          {username ? <span dir="ltr">{username}</span> : null}
          <span>ID <span className="font-mono">{telegramId}</span></span>
        </p>
      </div>
    </>
  );
  if (!onOpen) return <div className="flex min-w-0 items-center gap-2" data-testid="ticket-customer">{content}</div>;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      aria-label={`Open customer details for ${name ?? username ?? telegramId}`}
      data-testid="ticket-customer"
      className="-mx-1.5 flex min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {content}
    </button>
  );
}

export function TicketCustomer({ telegramId }: { telegramId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let cancelled = false;
    adminGet<{ user: Partial<Profile> }>(`/users/${encodeURIComponent(telegramId)}`)
      .then(({ user }) => { if (!cancelled) setProfile({ name: user?.name ?? null, username: user?.username ?? null }); })
      .catch(() => { /* identity is optional; the Telegram ID alone is still shown */ });
    return () => { cancelled = true; };
  }, [telegramId]);
  return (
    <>
      <TicketCustomerView telegramId={telegramId} profile={profile} onOpen={() => setOpen(true)} buttonRef={button} />
      <UserDetailSheet
        telegramId={telegramId}
        open={open}
        onOpenChange={setOpen}
        onCloseAutoFocus={(event) => { event.preventDefault(); button.current?.focus(); }}
      />
    </>
  );
}
