"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export const THEME_STORAGE_KEY = "swift-admin-theme";

export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
