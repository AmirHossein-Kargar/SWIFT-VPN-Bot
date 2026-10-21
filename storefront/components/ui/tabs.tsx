import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn-style Tabs (same API and styling as the Radix version) without the
 * Radix dependency: Radix Tabs cost ~9 kB gzipped of first-load JavaScript on
 * this page, which is paid before any plan can be shown. It implements the WAI-ARIA
 * tabs pattern: roving tabindex, arrow keys that respect the reading direction
 * (in RTL ArrowLeft is "next"), Home/End, wrap-around, and automatic
 * activation on focus (so arrow keys select, as before).
 */
interface TabsContextValue {
  value: string;
  baseId: string;
  select: (value: string) => void;
  dir: "ltr" | "rtl";
}
const TabsContext = React.createContext<TabsContextValue | null>(null);
const useTabs = () => {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error("Tabs components must be used inside <Tabs>");
  return context;
};
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

export function Tabs({ value, onValueChange, dir = "ltr", children }: { value: string; onValueChange: (value: string) => void; dir?: "ltr" | "rtl"; children: React.ReactNode }) {
  const baseId = React.useId();
  const context = React.useMemo(() => ({ value, baseId, dir, select: onValueChange }), [value, baseId, dir, onValueChange]);
  return (
    <TabsContext.Provider value={context}>
      <div dir={dir}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, onKeyDown, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const { dir, select } = useTabs();
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')];
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    let target = -1;
    if (event.key === forward) target = (current + 1) % tabs.length;
    else if (event.key === backward) target = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = tabs.length - 1;
    if (target === -1) return;
    event.preventDefault();
    const next = tabs[target];
    next?.focus();
    if (next?.dataset.value) select(next.dataset.value);
  };
  return (
    <div
      role="tablist"
      className={cn("mx-auto flex w-fit max-w-full flex-wrap justify-center gap-1.5 rounded-2xl border bg-card p-1.5", className)}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

export function TabsTrigger({ className, value, ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "value"> & { value: string }) {
  const { value: selected, baseId, select } = useTabs();
  const active = selected === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${safeId(value)}`}
      aria-selected={active}
      aria-controls={`${baseId}-panel-${safeId(value)}`}
      data-state={active ? "active" : "inactive"}
      data-value={value}
      tabIndex={active ? 0 : -1}
      onClick={() => select(value)}
      className={cn(
        "min-h-11 min-w-24 rounded-xl px-4 font-bold text-muted-foreground transition-colors hover:text-foreground",
        "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground",
        className
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, value, ...props }: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const { value: selected, baseId } = useTabs();
  if (selected !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${safeId(value)}`}
      aria-labelledby={`${baseId}-tab-${safeId(value)}`}
      tabIndex={0}
      className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  );
}
