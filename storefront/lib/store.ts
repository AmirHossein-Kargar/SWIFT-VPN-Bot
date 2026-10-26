// Pure storefront logic. No imports, so it is unit-tested directly with Node's
// built-in TypeScript stripping (tests/unit/storefrontLogic.test.js).

export interface StorePlan { id: string; name?: string; days: number; durationLabel?: string | null; gig: number; price: number }
export interface StoreDuration { days: number; title: string }
export interface StoreCatalog {
  currency: { code: string; unit: string };
  durations: StoreDuration[];
  plans: StorePlan[];
  paymentMethods: { id: string; available: boolean }[];
  checkout: { channel?: string; available: boolean; botUrl: string | null };
  support: { url: string | null };
}
export interface PlanCheck {
  plan: StorePlan;
  checkout: { available: boolean; url: string | null };
}

export const DURATION_STORAGE_KEY = "swift.store.duration";
export const THEME_STORAGE_KEY = "swift.theme";

/** Payment methods the page advertises. Anything else the API reports is ignored. */
export const PAY_LABELS: Record<string, { icon: "card" | "coin"; label: string }> = {
  hooshpay: { icon: "card", label: "پرداخت آنلاین کارت به کارت" },
  crypto: { icon: "coin", label: "پرداخت با ارز دیجیتال" },
};

/** The saved duration if it is still sold, otherwise the first one; null when nothing is sold. */
export function pickDuration(durations: StoreDuration[], saved: number | null | undefined): number | null {
  const available = durations.map((entry) => entry.days);
  if (available.length === 0) return null;
  return saved != null && available.includes(saved) ? saved : (available[0] ?? null);
}

export function durationTitle(catalog: Pick<StoreCatalog, "durations">, days: number, fallback: (days: number) => string): string {
  return catalog.durations.find((entry) => entry.days === days)?.title ?? fallback(days);
}

/** Plans for one duration, smallest volume first. */
export function plansFor(catalog: Pick<StoreCatalog, "plans">, days: number | null): StorePlan[] {
  return catalog.plans.filter((plan) => plan.days === days).sort((a, b) => a.gig - b.gig);
}

export function pricePerGb(plan: Pick<StorePlan, "gig" | "price">): number | null {
  return plan.gig > 0 ? Math.round(plan.price / plan.gig) : null;
}

export function visiblePayMethods(catalog: Pick<StoreCatalog, "paymentMethods">) {
  return (catalog.paymentMethods || []).filter((method) => method.available && PAY_LABELS[method.id]);
}

export type CatalogView = "empty" | "ready";
export function catalogView(catalog: Pick<StoreCatalog, "plans">): CatalogView {
  return catalog.plans && catalog.plans.length > 0 ? "ready" : "empty";
}

/** How the review dialog reacts when the server-side plan check fails. */
export type PlanCheckFailure = "gone" | "retry";
export function classifyPlanCheckFailure(status: number | undefined): PlanCheckFailure {
  return status === 404 ? "gone" : "retry";
}

/** Whether a validated plan can be handed off to Telegram. Never trusts the client-side plan. */
export function handoffUrl(check: PlanCheck): string | null {
  return check.checkout?.available && check.checkout.url ? check.checkout.url : null;
}

/** Only https links may be rendered as hand-off targets (defence in depth); every legitimate target is t.me. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}
