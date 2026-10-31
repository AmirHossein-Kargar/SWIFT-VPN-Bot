"use client";

import Link, { useLinkStatus } from "next/link";

function LinkProgress({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return pending ? <span className="nav-progress" role="progressbar" aria-label={label} /> : null;
}

/** A link outside `NavigationPending` (the support portal, page-level tabs): the same thin bar, without a route loading file. */
export function ProgressLink({ children, pendingLabel = "Loading", ...props }: React.ComponentProps<typeof Link> & { pendingLabel?: string }) {
  return <Link {...props}><LinkProgress label={pendingLabel} />{children}</Link>;
}
