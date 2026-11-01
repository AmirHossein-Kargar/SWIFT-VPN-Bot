import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";

import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: { default: "Swift Admin", template: "%s · Swift Admin" },
  description: "Swift VPN admin dashboard",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F2F8F5" },
    { media: "(prefers-color-scheme: dark)", color: "#0B0F0D" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set per request by web/nextAdminMiddleware.js. Reading it also keeps every page out of prerendering, which the
  // Content-Security-Policy needs: a prerendered page would have no nonce and its inline scripts would be blocked.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    // next-themes sets the class on <html> before hydration; the attribute
    // difference between server and client is expected there.
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
