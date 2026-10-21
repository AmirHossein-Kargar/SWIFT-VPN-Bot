"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useCustomerSession } from "@/components/support/customer-session";
import { customerMutate } from "@/lib/customerApi.client";

export function CustomerSignOut() {
  const { csrfToken } = useCustomerSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await customerMutate("/auth/logout", csrfToken);
      router.replace("/support/login");
      router.refresh();
    } catch {
      toast.error("خروج انجام نشد. دوباره تلاش کنید.");
      setBusy(false);
    }
  }

  return <Button variant="outline" size="sm" onClick={signOut} disabled={busy}>خروج</Button>;
}
