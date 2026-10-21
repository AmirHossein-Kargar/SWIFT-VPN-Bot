import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const here = path.dirname(fileURLToPath(import.meta.url));
const token = (name: string) => `hsl(var(--${name}))`;

const config: Config = {
  darkMode: ["class"],
  content: [
    path.join(here, "pages/**/*.{ts,tsx}"),
    path.join(here, "components/**/*.{ts,tsx}"),
    path.join(here, "lib/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      fontFamily: { sans: ["Vazirmatn", "Tahoma", "Segoe UI", "system-ui", "sans-serif"] },
      colors: {
        border: token("border"),
        "border-strong": token("border-strong"),
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        secondary: { DEFAULT: token("secondary"), foreground: token("secondary-foreground") },
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        accent: { DEFAULT: token("accent"), foreground: token("accent-foreground") },
        destructive: { DEFAULT: token("destructive"), foreground: token("destructive-foreground") },
        card: { DEFAULT: token("card"), foreground: token("card-foreground") },
        popover: { DEFAULT: token("popover"), foreground: token("popover-foreground") },
        success: token("success"),
        brand: token("brand"),
        faint: token("faint"),
        alt: token("alt"),
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 4px)", sm: "calc(var(--radius) - 8px)" },
      maxWidth: { page: "1180px" },
    },
  },
  plugins: [animate],
};

export default config;
