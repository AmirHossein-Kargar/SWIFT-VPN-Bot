"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { AdminApiError } from "@/lib/types";

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/admin${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new AdminApiError(data?.message || "The request failed.", response.status, data?.error || "request_failed");
  }
  return data;
}

export function SignInForm() {
  const router = useRouter();
  const [step, setStep] = useState<"id" | "code">("id");
  const [telegramId, setTelegramId] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [expiresInSeconds, setExpiresInSeconds] = useState<number | null>(null);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await postJson("/auth/request-code", { telegramId });
      setExpiresInSeconds(result.expiresInSeconds ?? 300);
      setStep("code");
      toast.success("If that ID is an allowlisted admin, a sign-in code was sent via Telegram.");
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Could not request a sign-in code.");
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await postJson("/auth/verify", { code });
      router.push("/");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof AdminApiError ? error.message : "Sign-in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-5">
        {step === "id" ? (
          <form className="space-y-4" onSubmit={requestCode}>
            <div className="space-y-1.5">
              <Label htmlFor="telegramId">Telegram ID</Label>
              <Input
                id="telegramId"
                inputMode="numeric"
                autoComplete="off"
                placeholder="123456789"
                value={telegramId}
                onChange={(event) => setTelegramId(event.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              Send sign-in code
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={verifyCode}>
            <div className="space-y-1.5">
              <Label htmlFor="code">Sign-in code</Label>
              <Input
                id="code"
                autoComplete="one-time-code"
                placeholder="Paste the code from Telegram"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Valid for {expiresInSeconds ? Math.floor(expiresInSeconds / 60) : 5} minutes. Check your Telegram DM from the bot.
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              Sign in
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => setStep("id")} disabled={loading}>
              Use a different Telegram ID
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
