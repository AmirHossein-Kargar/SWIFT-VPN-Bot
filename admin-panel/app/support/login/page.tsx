import type { Metadata } from "next";

import { Logo } from "@/components/brand/logo";
import { LoginHandler } from "@/components/support/login-handler";

export const metadata: Metadata = { title: "ورود به پشتیبانی" };

export default function SupportLoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4" dir="rtl" lang="fa">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo variant="stacked" height={72} />
          <h1 className="text-lg font-semibold">ورود به پشتیبانی</h1>
          <p className="text-sm text-muted-foreground">برای امنیت شما، ورود فقط از طریق ربات تلگرام انجام می‌شود.</p>
        </div>
        <LoginHandler />
      </div>
    </div>
  );
}
