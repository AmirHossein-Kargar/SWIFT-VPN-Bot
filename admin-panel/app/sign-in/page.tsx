import type { Metadata } from "next";

import { SignInForm } from "@/components/auth/sign-in-form";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo variant="stacked" height={72} />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Admin sign-in</h1>
            <p className="text-sm text-muted-foreground">Enter your allowlisted Telegram ID to receive a one-time sign-in code.</p>
          </div>
        </div>
        <SignInForm />
      </div>
    </div>
  );
}
