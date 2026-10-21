const faNumber = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });

/** Persian digits with grouping, e.g. 150000 → ۱۵۰٬۰۰۰. */
export const fa = (value: number) => faNumber.format(value);

export function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
}

/** Current Persian-calendar year as digits, or the Gregorian year if the runtime lacks the calendar. */
export function currentYearLabel(date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric" }).format(date).replace(/[^۰-۹0-9]/g, "");
  } catch {
    return String(date.getFullYear());
  }
}
