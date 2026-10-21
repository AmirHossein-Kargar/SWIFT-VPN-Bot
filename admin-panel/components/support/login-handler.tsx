"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { customerMutate } from "@/lib/customerApi.client";
import { ticketErrorMessage } from "@/lib/tickets";

/**
 * Exchanges the one-time code from the bot's link for a session. The code
 * travels in the URL fragment, so it is never sent to the server in a request
 * line, logged, or leaked through a Referer header; it is removed from the
 * address bar immediately.
 */
export function LoginHandler() {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<"working" | "failed" | "missing">("working");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = new URLSearchParams(window.location.hash.slice(1)).get("code");
    window.history.replaceState(null, "", window.location.pathname);
    if (!code) {
      setState("missing");
      return;
    }
    customerMutate("/auth/verify", null, { code })
      .then(() => {
        router.replace("/support");
        router.refresh();
      })
      .catch((error) => {
        setMessage(ticketErrorMessage(error, "ورود انجام نشد."));
        setState("failed");
      });
  }, [router]);

  if (state === "working") return <p className="text-center text-sm text-muted-foreground" role="status">در حال ورود…</p>;
  return (
    <div className="space-y-3 text-center">
      <p className="text-sm" role="alert">
        {state === "missing" ? "لینک ورود کامل نیست. در ربات تلگرام، «پشتیبانی» ← «مشاهده در پنل وب» را بزنید." : message}
      </p>
      <Button variant="outline" onClick={() => router.replace("/support")}>تلاش دوباره</Button>
    </div>
  );
}
