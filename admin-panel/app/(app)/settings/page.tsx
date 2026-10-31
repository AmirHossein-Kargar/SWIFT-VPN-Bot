import type { Metadata } from "next";
import { ProgressLink } from "@/components/shared/progress-link";
import { CheckCircle2, CircleSlash, Lock } from "lucide-react";

import { adminApiGet, adminSession } from "@/lib/adminApi.server";
import type { AuditLogPage, SettingsOverview, SystemHealth } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SignOutButton } from "@/components/settings/sign-out-button";
import { ThemePreference } from "@/components/settings/theme-preference";
import { Logo } from "@/components/brand/logo";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

function duration(seconds: number) {
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm">{label}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

function Configured({ value, on = "Configured", off = "Not configured" }: { value: boolean; on?: string; off?: string }) {
  return value ? (
    <span className="inline-flex items-center gap-1.5 text-success"><CheckCircle2 className="h-4 w-4" />{on}</span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground"><CircleSlash className="h-4 w-4" />{off}</span>
  );
}

function ReadOnlyNote({ what = "these values" }: { what?: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      Read-only. {what[0]?.toUpperCase()}{what.slice(1)} come from the server environment and change only with a redeploy. Secret values are never sent to the browser — only whether they are set.
    </p>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default async function SettingsPage() {
  // Independent reads; one failing section must not blank the whole page.
  const [session, overviewResult, healthResult, auditResult] = await Promise.all([
    adminSession(),
    adminApiGet<SettingsOverview>("/settings/overview").then((data) => ({ data }), () => ({ data: null })),
    adminApiGet<SystemHealth>("/system/health").then((data) => ({ data }), () => ({ data: null })),
    adminApiGet<AuditLogPage>("/audit", { pageSize: 8 }).then((data) => ({ data }), () => ({ data: null })),
  ]);
  const overview = overviewResult.data;
  const health = healthResult.data;
  const audit = auditResult.data;
  const unavailable = <p className="text-sm text-muted-foreground">This section could not be loaded. Refresh to try again.</p>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Panel preferences, plus a read-only view of how this server is configured.</p>
      </div>

      <Tabs defaultValue="general">
        <div className="overflow-x-auto pb-1">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="vpn">VPN</TabsTrigger>
            <TabsTrigger value="system">System</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="general" className="space-y-4">
          <Section title="Account" description="Sign-in is passwordless: a one-time code is sent to your Telegram account.">
            <Row label="Telegram ID"><span className="font-mono">{session.actorTelegramId ?? "—"}</span></Row>
            {overview ? (
              <>
                <Row label="Role">{overview.account.isOwner ? <Badge>Primary owner</Badge> : <Badge variant="outline">Admin</Badge>}</Row>
                <Row label="Admins defined in the environment" hint="Additional admins can be managed on the Admins page (owner only).">
                  {overview.account.environmentAdminCount}
                </Row>
              </>
            ) : null}
            <div className="pt-4"><SignOutButton /></div>
          </Section>
          <Section title="Application">
            {overview ? (
              <>
                <Row label="Brand"><Logo height={22} /></Row>
                <Row label="Version"><span className="font-mono">{overview.application.version}</span></Row>
                <Row label="Environment"><Badge variant={overview.application.environment === "production" ? "default" : "warning"}>{overview.application.environment}</Badge></Row>
                <Row label="Panel language" hint="The admin panel is English-only. Customer-facing bot messages stay Persian.">English</Row>
              </>
            ) : unavailable}
          </Section>
        </TabsContent>

        <TabsContent value="appearance">
          <Section title="Theme" description="Choose how the admin panel looks on this device.">
            <ThemePreference />
          </Section>
        </TabsContent>

        <TabsContent value="security">
          <Section title="Sessions & sign-in" description="Enforced by the server for every admin request.">
            {overview ? (
              <>
                <Row label="Session lifetime">{duration(overview.security.sessionTtlSeconds)}</Row>
                <Row label="Sign-in code lifetime">{duration(overview.security.loginCodeTtlSeconds)}</Row>
                <Row label="Session store">{overview.security.sessionStore === "redis" ? "Redis (server-side)" : overview.security.sessionStore}</Row>
                <Row label="Session cookie" hint={`Scoped to ${overview.security.cookie.paths.join(" and ")}`}>
                  {[overview.security.cookie.httpOnly && "HttpOnly", overview.security.cookie.secure && "Secure", `SameSite=${overview.security.cookie.sameSite}`].filter(Boolean).join(" · ")}
                </Row>
                <Row label="CSRF protection"><Configured value={overview.security.csrfProtection} on="Enabled" off="Disabled" /></Row>
                <Row label="Cross-origin request blocking"><Configured value={overview.security.originCheck} on="Enabled" off="Disabled" /></Row>
                <Row label="Sign-in rate limits">{overview.security.loginRateLimitPerMinute} code requests / {overview.security.codeVerifyRateLimitPerMinute} verifications per minute</Row>
                <div className="pt-3"><ReadOnlyNote what="security settings" /></div>
              </>
            ) : unavailable}
          </Section>
        </TabsContent>

        <TabsContent value="notifications">
          <Section title="Where alerts go" description="The bot posts operational alerts (payments needing review, recovery, failures) to the admin Telegram group.">
            {overview ? (
              <>
                <Row label="Admin alert group"><Configured value={overview.telegram.adminGroup} /></Row>
                <Row label="Support contact button" hint="Attached to customer messages, including ones you send from the Users page."><Configured value={overview.telegram.supportContact} /></Row>
                <p className="pt-3 text-xs text-muted-foreground">There are no per-admin notification preferences; the server does not store any. Broadcasts are sent from the Broadcasts page.</p>
              </>
            ) : unavailable}
          </Section>
        </TabsContent>

        <TabsContent value="payments">
          <Section title="Payment providers" description="Whether each provider's credentials are present. Signature and IPN verification are always enforced in code.">
            {overview ? (
              <>
                <Row label="HooshPay API key"><Configured value={overview.payments.hooshpay.apiKey} /></Row>
                <Row label="HooshPay webhook secret"><Configured value={overview.payments.hooshpay.webhookSecret} /></Row>
                <Row label="NOWPayments API key"><Configured value={overview.payments.nowpayments.apiKey} /></Row>
                <Row label="NOWPayments IPN verification" hint="Requires the IPN secret and callback URL."><Configured value={overview.payments.nowpayments.ipnVerification} on="Ready" off="Incomplete" /></Row>
                <Row label="NOWPayments configuration valid"><Configured value={overview.payments.nowpayments.valid} on="Valid" off="Invalid or missing" /></Row>
                <Row label="NOWPayments custody access"><Configured value={overview.payments.nowpayments.custodyAuth} /></Row>
                <Row label="TRX wallet"><Configured value={overview.payments.trxWallet} /></Row>
                <Row label="Public webhook base URL"><Configured value={overview.payments.webhookBaseUrl} /></Row>
                <div className="pt-3"><ReadOnlyNote what="payment credentials" /></div>
              </>
            ) : unavailable}
          </Section>
        </TabsContent>

        <TabsContent value="vpn">
          <Section title="VPN panel" description="Connection to the panel that provisions customer services.">
            {overview ? (
              <>
                <Row label="Panel API URL"><Configured value={overview.vpn.wizardApiUrl} /></Row>
                <Row label="Panel API key"><Configured value={overview.vpn.wizardApiKey} /></Row>
                <p className="pt-3 text-xs text-muted-foreground">
                  Live reachability is on <ProgressLink href="/system-health" className="underline underline-offset-2">System health</ProgressLink>; plans are managed on <ProgressLink href="/products" className="underline underline-offset-2">Products</ProgressLink>.
                </p>
                <div className="pt-3"><ReadOnlyNote what="VPN panel settings" /></div>
              </>
            ) : unavailable}
          </Section>
        </TabsContent>

        <TabsContent value="system" className="space-y-4">
          <Section title="Runtime">
            {overview ? (
              <>
                <Row label="Node.js"><span className="font-mono">{overview.application.nodeVersion}</span></Row>
                <Row label="Process started">{formatDateTime(overview.application.startedAt)}</Row>
                <Row label="Uptime">{duration(overview.application.uptimeSeconds)}</Row>
                <Row label="Telegram bot token"><Configured value={overview.telegram.botToken} /></Row>
                <Row label="Mock tests" hint="Controlled by MOCK_TESTS_ENABLED on the server."><Configured value={overview.features.mockTests} on="Enabled" off="Disabled" /></Row>
              </>
            ) : unavailable}
          </Section>
          <Section title="Dependencies" description={health ? `Checked ${formatDateTime(health.generatedAt)}` : undefined}>
            {health ? (
              <>
                {health.services.map((service) => (
                  <Row key={service.name} label={service.name} hint={service.error ?? undefined}>
                    <Badge variant={service.status === "healthy" ? "success" : service.status === "degraded" ? "warning" : service.status === "down" ? "destructive" : "muted"}>
                      {service.status}{service.latencyMs != null ? ` · ${service.latencyMs} ms` : ""}
                    </Badge>
                  </Row>
                ))}
                <p className="pt-3 text-xs text-muted-foreground"><ProgressLink href="/system-health" className="underline underline-offset-2">Open System health</ProgressLink> for history and a fresh check.</p>
              </>
            ) : unavailable}
          </Section>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle>Recent admin activity</CardTitle>
              <CardDescription>Every admin action is recorded. <ProgressLink href="/audit" className="underline underline-offset-2">Open the full audit log</ProgressLink>.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {audit ? (
                audit.items.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No admin activity recorded yet.</p> : (
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>When</TableHead><TableHead>Admin</TableHead><TableHead>Action</TableHead><TableHead>Target</TableHead><TableHead>Status</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {audit.items.map((entry, index) => (
                        <TableRow key={`${entry.createdAt}-${index}`}>
                          <TableCell className="text-muted-foreground">{formatDateTime(entry.createdAt)}</TableCell>
                          <TableCell className="font-mono text-xs">{entry.actorTelegramId}</TableCell>
                          <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                          <TableCell className="font-mono text-xs">{entry.targetId ?? "—"}</TableCell>
                          <TableCell><Badge variant={entry.status === "succeeded" ? "success" : entry.status === "failed" ? "destructive" : "muted"}>{entry.status}</Badge></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : <div className="p-6">{unavailable}</div>}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
