"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { THEME_OPTIONS } from "@/components/theme-toggle";

export function ThemePreference() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme ?? "system" : undefined;

  return (
    <div className="space-y-3">
      <RadioGroup value={current} onValueChange={setTheme} className="grid-cols-1 sm:grid-cols-3" aria-label="Color theme">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <Label
            key={value}
            htmlFor={`theme-${value}`}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 font-normal hover:bg-accent has-[[data-state=checked]]:border-foreground"
          >
            <RadioGroupItem id={`theme-${value}`} value={value} />
            <Icon className="h-4 w-4 text-muted-foreground" />
            {label}
          </Label>
        ))}
      </RadioGroup>
      <p className="text-xs text-muted-foreground">
        Saved in this browser only. {mounted && theme === "system" ? `Following your system setting (currently ${resolvedTheme}).` : ""}
      </p>
    </div>
  );
}
