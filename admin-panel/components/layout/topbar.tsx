"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate } from "@/lib/adminApi.client";
import { stripBasePath } from "@/lib/basePath";

const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/users": "Users",
  "/payments": "Payments",
};

export function Topbar() {
  const { actorTelegramId, csrfToken } = useAdminSession();
  const router = useRouter();
  const pathname = usePathname();
  const title = TITLES[stripBasePath(pathname)] ?? "SWIFT Admin";
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await adminMutate("/auth/logout", "POST", csrfToken);
      router.push("/sign-in");
      router.refresh();
    } catch {
      toast.error("Sign-out failed. Please try again.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border px-6">
      <h1 className="text-sm font-semibold">{title}</h1>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">Signed in as {actorTelegramId}</span>
        <Button variant="outline" size="sm" onClick={handleSignOut} disabled={signingOut}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
