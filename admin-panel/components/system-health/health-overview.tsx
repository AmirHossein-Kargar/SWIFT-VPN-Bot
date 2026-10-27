"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, HelpCircle } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stripBasePath } from "@/lib/basePath";
import { detailRows } from "@/lib/health-details";
import type { SystemHealth, SystemHealthService } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

const STATUS_ICON: Record<SystemHealthService["status"], typeof CheckCircle2> = {
  healthy: CheckCircle2,
  degraded: AlertTriangle,
  down: XCircle,
  unknown: HelpCircle,
};

const STATUS_VARIANT: Record<SystemHealthService["status"], "success" | "warning" | "destructive" | "outline"> = {
  healthy: "success",
  degraded: "warning",
  down: "destructive",
  unknown: "outline",
};

const SERVICE_LABEL: Record<string, string> = {
  mongodb: "MongoDB",
  redis: "Redis",
  wizardxray: "WizardXray panel",
  hooshpay: "HooshPay",
  nowpayments: "NOWPayments",
  telegram: "Telegram bot",
  orders: "Order fulfillment",
  webhook: "Webhook",
  "background-jobs": "Background jobs",
};

function ServiceDetails({ service }: { service: SystemHealthService }) {
  const rows = detailRows(service);
  if (!rows.length) return null;
  return (
    <dl className="space-y-1 border-t pt-1.5 text-xs" data-testid={`details-${service.name}`}>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={row.warn ? "font-medium text-warning" : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HealthOverview({ health }: { health: SystemHealth }) {
  const router = useRouter();
  const pathname = stripBasePath(usePathname());
  const [refreshing, setRefreshing] = useState(false);

  function refresh() {
    setRefreshing(true);
    router.push(`${pathname}?fresh=1`);
    router.refresh();
    setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>System health</CardTitle>
            <CardDescription>Generated {formatDateTime(health.generatedAt)}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[health.overall]} className="text-sm">
              {health.overall}
            </Badge>
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {health.services.map((service) => {
          const Icon = STATUS_ICON[service.status];
          return (
            <Card key={service.name}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle>{SERVICE_LABEL[service.name] ?? service.name}</CardTitle>
                <Icon
                  className={
                    service.status === "healthy"
                      ? "h-4 w-4 text-success"
                      : service.status === "degraded"
                        ? "h-4 w-4 text-warning"
                        : service.status === "down"
                          ? "h-4 w-4 text-destructive"
                          : "h-4 w-4 text-muted-foreground"
                  }
                />
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={STATUS_VARIANT[service.status]}>{service.status}</Badge>
                </div>
                {service.latencyMs != null ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Latency</span>
                    <span>{service.latencyMs} ms</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last checked</span>
                  <span>{formatDateTime(service.lastCheckedAt)}</span>
                </div>
                <ServiceDetails service={service} />
                {service.error ? <p className="text-xs text-destructive">{service.error}</p> : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
