"use client";

import { useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";

/**
 * Telegram profile photo, served by the authenticated admin API (the bot token
 * never reaches the browser). Many users have no photo or hide it, so a failed
 * or 404 load quietly falls back to initials, or a person icon when the label
 * is only an ID. A server-rendered image can fail before hydration attaches
 * onError, so the mount effect checks for that too.
 */
export function UserAvatar({ telegramId, label, size = 56 }: { telegramId: string; label: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth === 0) setFailed(true);
  }, []);
  const initials = (label.replace(/^@/, "").trim().slice(0, 2) || "?").toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {failed ? (
        /\p{L}/u.test(label) ? <span aria-hidden dir="auto">{initials}</span> : <UserRound className="h-1/2 w-1/2" aria-hidden data-testid="avatar-fallback-icon" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated API response, not a static asset
        <img
          ref={image}
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
