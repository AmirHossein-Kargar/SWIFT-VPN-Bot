"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useAdminSession } from "@/components/session-provider";
import { adminMutate } from "@/lib/adminApi.client";

export function SignOutButton() {
  const { csrfToken } = useAdminSession();
  const router = useRouter();
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
    <Button variant="outline" onClick={handleSignOut} disabled={signingOut}>
      <LogOut className="h-4 w-4" />
      {signingOut ? "Signing out…" : "Sign out everywhere"}
    </Button>
  );
}
