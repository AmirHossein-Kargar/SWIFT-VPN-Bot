import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { storageSet } from "@/lib/format";
import { THEME_STORAGE_KEY } from "@/lib/store";

const THEME_COLOR = { light: "#FAFAFA", dark: "#0B0F0D" } as const;

/**
 * The first paint theme is applied by the external /store/theme-init.js (the
 * CSP forbids inline scripts). This only flips it afterwards. Icons swap with
 * CSS (`dark:` variants), so there is no theme state to hydrate-mismatch.
 */
export function toggleTheme() {
  const root = document.documentElement;
  const next = root.classList.contains("dark") ? "light" : "dark";
  root.classList.toggle("dark", next === "dark");
  root.setAttribute("data-theme", next);
  storageSet(THEME_STORAGE_KEY, next);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[next]);
}

export function ThemeToggle() {
  return (
    <Button variant="outline" size="icon" aria-label="تغییر پوسته (روشن/تیره)" title="تغییر پوسته" onClick={toggleTheme}>
      <Sun className="hidden size-[19px] dark:block" />
      <Moon className="size-[19px] dark:hidden" />
    </Button>
  );
}
