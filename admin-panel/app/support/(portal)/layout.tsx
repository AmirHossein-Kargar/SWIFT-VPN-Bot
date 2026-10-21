import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { customerSession } from "@/lib/customerApi.server";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { CustomerSessionProvider } from "@/components/support/customer-session";
import { CustomerSignOut } from "@/components/support/customer-sign-out";

export default async function SupportPortalLayout({ children }: { children: React.ReactNode }) {
  const session = await customerSession();

  if (session.unavailable) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center" dir="rtl" lang="fa">
        <AlertTriangle className="h-8 w-8 text-warning" />
        <p className="text-sm font-medium">پنل پشتیبانی موقتاً در دسترس نیست.</p>
        <p className="text-sm text-muted-foreground">لطفاً چند لحظه بعد دوباره تلاش کنید.</p>
      </div>
    );
  }
  if (!session.authenticated || !session.csrfToken) redirect("/support/login");

  return (
    <CustomerSessionProvider csrfToken={session.csrfToken}>
      <div className="min-h-screen bg-background" dir="rtl" lang="fa">
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 sm:px-6">
          <Link href="/support" className="flex items-center gap-2.5" aria-label="پشتیبانی سوییفت">
            <Logo height={24} />
            <span className="text-sm font-semibold">پشتیبانی</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <CustomerSignOut />
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl p-4 sm:p-6">{children}</main>
      </div>
    </CustomerSessionProvider>
  );
}
