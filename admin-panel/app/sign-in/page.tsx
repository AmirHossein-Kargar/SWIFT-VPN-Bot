import { ShieldCheck } from "lucide-react";

import { SignInForm } from "@/components/auth/sign-in-form";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <ShieldCheck className="h-8 w-8 text-primary" />
          <h1 className="text-lg font-semibold">SWIFT Admin sign-in</h1>
          <p className="text-sm text-muted-foreground">Enter your allowlisted Telegram ID to receive a one-time sign-in code.</p>
        </div>
        <SignInForm />
      </div>
    </div>
  );
}
