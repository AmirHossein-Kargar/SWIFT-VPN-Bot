"use client";

import { useState } from "react";

/**
 * Telegram profile photo, served by the authenticated admin API (the bot token
 * never reaches the browser). Many users have no photo or hide it, so a failed
 * or 404 load quietly falls back to initials.
 */
export function UserAvatar({ telegramId, label, size = 56 }: { telegramId: string; label: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = (label.replace(/^@/, "").trim().slice(0, 2) || "?").toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {failed ? (
        <span aria-hidden>{initials}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated API response, not a static asset
        <img
          src={`/api/admin/users/${encodeURIComponent(telegramId)}/photo`}
          alt={`Profile photo of ${label}`}
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
