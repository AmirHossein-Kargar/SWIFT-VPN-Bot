import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { adminSession } from "@/lib/adminApi.server";
import { SessionProvider } from "@/components/session-provider";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await adminSession();

  if (session.unavailable) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <AlertTriangle className="h-8 w-8 text-warning" />
        <p className="text-sm font-medium">The admin API is temporarily unavailable.</p>
        <p className="text-sm text-muted-foreground">Please try again in a moment.</p>
      </div>
    );
  }

  if (!session.authenticated || !session.actorTelegramId || !session.csrfToken) {
    redirect("/sign-in");
  }

  const { actorTelegramId, csrfToken } = session;

  return (
    <SessionProvider value={{ actorTelegramId, csrfToken }}>
      <div className="flex min-h-screen bg-background">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
    </SessionProvider>
  );
}
