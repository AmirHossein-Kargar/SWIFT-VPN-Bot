"use client";

import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { SectionSkeleton } from "@/components/shared/section-skeleton";

interface NavigationPendingValue {
  navigate: (href: string) => void;
  openSection: (event: React.MouseEvent, href: string) => void;
  pending: boolean;
  changingSection: boolean;
}

const NavigationPendingContext = createContext<NavigationPendingValue | null>(null);

/**
 * All in-panel navigation runs in one transition, so the waiting state lives here instead of in a route `loading.tsx`.
 * Filters, sorting and pages keep the current table on screen (and the search box focused) under a thin bar; a new
 * section swaps to a skeleton straight away.
 *
 * Do not add a `loading.tsx` above the pages. Tried here with the skeleton below, it left about one filter-then-clear
 * in 16 stuck in a transition that never committed, and it streamed pages, turning a failed API into a 200.
 */
export function NavigationPending({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sectionChange, setSectionChange] = useState(false);

  const value = useMemo<NavigationPendingValue>(() => {
    const navigate = (href: string) => {
      setSectionChange(false);
      startTransition(() => router.push(href));
    };
    return {
      navigate,
      openSection(event, href) {
        // Ctrl-click and friends keep their normal meaning, which is why these stay real links.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        setSectionChange(true);
        startTransition(() => router.push(href));
      },
      pending,
      changingSection: pending && sectionChange,
    };
  }, [pending, router, sectionChange]);

  return <NavigationPendingContext.Provider value={value}>{children}</NavigationPendingContext.Provider>;
}

export function PendingMain({ children }: { children: React.ReactNode }) {
  const navigation = useContext(NavigationPendingContext);
  const pending = navigation?.pending ?? false;
  const changingSection = navigation?.changingSection ?? false;

  return (
    <>
      {pending ? <div className="nav-progress" role="progressbar" aria-label="Loading" /> : null}
      <main aria-busy={pending} data-pending={pending ? "true" : undefined} className="min-w-0 flex-1 overflow-y-auto p-6">
        {changingSection ? <SectionSkeleton /> : null}
        <div hidden={changingSection}>{children}</div>
      </main>
    </>
  );
}

/** `router.push` with the shared pending feedback; outside the signed-in shell it is a plain push. */
export function useNavigate() {
  const router = useRouter();
  const navigation = useContext(NavigationPendingContext);
  return navigation?.navigate ?? router.push;
}

/** Click handler for sidebar and drawer links. */
export function useOpenSection() {
  return useContext(NavigationPendingContext)?.openSection ?? (() => {});
}
