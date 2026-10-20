import { adminSession } from "@/lib/adminApi.server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SignOutButton } from "@/components/settings/sign-out-button";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await adminSession();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Authentication is passwordless: a one-time code is sent to your Telegram account on sign-in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Telegram ID</p>
            <p className="font-medium">{session.actorTelegramId ?? "—"}</p>
          </div>
          <SignOutButton />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About this panel</CardTitle>
          <CardDescription>
            This dashboard reads and writes through the same <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/admin</code> REST
            API used by the Telegram-native admin panel, so authorization, auditing, and business logic are identical across both.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
