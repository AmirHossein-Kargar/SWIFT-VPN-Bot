export interface SessionInfo {
  authenticated: boolean;
  actorTelegramId?: string;
  csrfToken?: string;
  expiresAt?: number;
}

export interface DashboardMetrics {
  generatedAt: string;
  metrics: {
    totalUsers: number;
    activeUsers: number;
    newUsersToday: number;
    activeVpns: number | null;
    expiredVpns: number;
    trackedActiveVpns: number;
    orders: { total: number; today: number; week: number; month: number };
    revenue: { today: number; week: number; month: number };
    pendingPayments: number;
    failedPayments: number;
    failedProvisioning: number;
    pendingOrders: number;
    totalPanelVpns: number | null;
    averageOrderValueMonth: number;
    failedPaymentRate: number;
  };
  revenueByProviderMonth: Record<string, number>;
  charts: {
    revenue: { date: string; value: number }[];
    orders: { date: string; value: number }[];
    newUsers: { date: string; value: number }[];
    activeVpns: { date: string; value: number }[];
    popularPackages: { productId: string; name: string; count: number; revenue: number }[];
  };
}

export interface AdminUser {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  balance: number;
  successfulPayments: number;
  totalSpent: number;
  orderCount: number;
  serviceCount: number;
  createdAt: string | null;
  lastActivityAt: string | null;
  isBanned: boolean;
  referralCode: string | null;
  referredByTelegramId: string | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export interface AdminPayment {
  key: string;
  id: string;
  provider: "hooshpay" | "nowpayments" | "bank" | "trx" | "wallet";
  providerLabel: string;
  type: "order" | "top-up";
  userId: string;
  amount: number;
  currency: string;
  product: string;
  trackingCode: string | null;
  status: string;
  rawStatus: string;
  createdAt: string | null;
  paidAt: string | null;
  fulfilledAt: string | null;
  retryCount: number;
  lastRetryAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  recoveryStatus: string;
  recoveryReason: string | null;
}

export interface PaymentDetail extends AdminPayment {
  timeline: { name: string; at: string | null; status: string; detail: string | null }[];
  fulfilled: boolean;
  webhookEvents: { receivedAt: string; event: string | null; status: string | null; amount: number | null; trackingCode: string | null }[];
  purchase: Record<string, unknown> | null;
  actions: { retryVerification: boolean; retryFulfillment: boolean; manualResolve: boolean };
}

export interface UserDetail {
  user: AdminUser;
  blockedAt: string | null;
  blockedBy: string | null;
  blockReason: string | null;
  testService: { received: boolean; status: string | null; inFlight: boolean; eligible: boolean };
  totalSpent: number;
  orderCount: number;
  activeVpns: number;
  expiredVpns: number;
  referral: {
    code: string | null;
    referredByTelegramId: string | null;
    referredBy: AdminUser | null;
    referralCount: number;
    trackingAvailable: boolean;
  };
  payments: { id: string; provider: string; status: string; amount: number; createdAt: string | null; paidAt: string | null; trackingCode: string | null }[];
  orders: Record<string, unknown>[];
  services: Record<string, unknown>[];
}

export interface AdminProduct {
  id: string;
  name: string;
  durationDays: number;
  trafficGb: number;
  priceToman: number;
  costToman: number;
  profitToman: number;
  enabled: boolean;
  displayOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AdminVpn {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  ownerName: string | null;
  clientId: string;
  purchaseId: string | null;
  productId: string | null;
  product: string | null;
  trafficGb: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: "active" | "expired" | "expiring" | "revoked" | "unknown";
}

export interface VpnDetail {
  user: { telegramId: string; username: string | null; name: string | null; isBanned: boolean };
  clientId: string;
  product: string | null;
  productId: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  panelExpiry: string | null;
  durationDays: number | null;
  trafficGb: number | null;
  trafficUsed: string | null;
  trafficRemainingGb: number | null;
  status: string;
  wizardXray: { status: "connected" | "unavailable"; latencyMs: number | null; error: string | null };
  wizardStatus: string | null;
  purchaseStatus: string | null;
  availableActions: {
    changeLink: boolean;
    disable: boolean;
    revoke: boolean;
    extendTime: boolean;
    increaseTraffic: boolean;
    regenerateConfig: boolean;
  };
  unavailableActions: Record<string, string>;
}

export interface RecoveryItem {
  key: string;
  provider: "hooshpay" | "nowpayments" | "bank" | "trx" | "wallet";
  kind: string;
  userId: string;
  amount: number;
  createdAt: string | null;
  lastEventAt: string | null;
  status: string;
  retryCount: number;
  lastRetryAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  retrySafe: boolean;
}

export interface RecoveryQueue extends PagedResult<RecoveryItem> {
  counts: Record<string, number>;
}

export interface AdminAccountRow {
  telegramId: string;
  source: "environment" | "database";
  role: "owner" | "admin";
  displayName: string | null;
  addedBy: string | null;
  addedAt: string | null;
}

export interface SystemHealthService {
  name: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  latencyMs: number | null;
  error: string | null;
  details: Record<string, unknown>;
  lastCheckedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorMessage: string | null;
}

export interface SystemHealth {
  generatedAt: string;
  overall: "healthy" | "degraded" | "down";
  services: SystemHealthService[];
  notes: Record<string, string>;
}

export interface MockScenarioResult {
  id: string;
  title: string;
  titleFa: string;
  status: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  counts: { total: number; passed: number; failed: number; skipped: number };
  notes: string[];
  explanation: string | null;
  errorDetail?: string | null;
}

export interface MockTestSummary {
  PASS: number;
  FAIL: number;
  BLOCKED: number;
  "NOT RUN": number;
  assertions: number;
  assertionsFailed: number;
  overall: "PASS" | "FAIL" | "BLOCKED" | "NOT RUN" | "PARTIAL";
}

export interface MockTestRunReport {
  runId: string;
  trigger: "telegram" | "web" | "test";
  requestedScenarios: string[];
  startedAt: string;
  completedAt: string;
  summary: MockTestSummary;
  scenarios: MockScenarioResult[];
  enabled?: boolean;
  persisted?: boolean;
}

export interface AuditLogEntry {
  actorTelegramId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetUserId: string | null;
  status: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AnalyticsKpi {
  id: string;
  group: "operational" | "financial" | "sales";
  value: number | null;
  previous: number | null | undefined;
  change: { pct: number | null; delta: number | null; state: "unavailable" | "flat" | "no_baseline" | "up" | "down" };
  unit: "count" | "toman" | "ratio";
  exact?: boolean;
}

export interface AnalyticsReport {
  generatedAt: string;
  range: { key: string; from: string; to: string; days: number; previous: { from: string; to: string } };
  granularity: { bucketMs: number; label: string };
  kpis: AnalyticsKpi[];
  series: { start: string; topups: number; sales: number; orders: number; newUsers: number }[];
  distributions: {
    providers: { provider: string; amount: number; count: number }[];
    crypto: { ticker: string | null; network: string | null; amount: number; count: number }[];
    plans: { planId: string; name: string; count: number; amount: number }[];
  };
  definitions: Record<string, string>;
  unavailable: { id: string; reason: string }[];
}

export interface BroadcastButton {
  text: string;
  url: string;
}

export interface BroadcastSummary {
  operationId: string;
  adminTelegramId: string;
  audience: "all" | "active" | "expired" | "paying" | "custom";
  status: "queued" | "running" | "cancel_requested" | "cancelled" | "interrupted" | "completed" | "failed";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  createdAt: string | null;
  finishedAt: string | null;
  lastErrorCode: string | null;
}

export interface BroadcastPreview {
  preview: { message: string; lineCount: number; characterCount: number; buttons: BroadcastButton[] };
  warnings: string[];
  validationErrors: string[];
}

export interface CustodyBalance {
  code: string;
  ticker: string;
  name: string;
  network: string;
  availableAmount: number | null;
  availableDisplay: string;
  pendingAmount: number;
  pendingDisplay: string;
}

export interface CustodyConversion {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  fromAmountDisplay: string;
  toAmountDisplay: string;
  rate: number | null;
  status: string;
  createdAt: string | null;
}

export interface CustodyPayout {
  id: string;
  batchWithdrawalId: string | null;
  currency: string;
  ticker: string;
  address: string;
  amountDisplay: string;
  status: string;
  hash: string | null;
  createdAt: string | null;
}

export interface CustodyLocalInvoice {
  orderId: string;
  invoiceId: string | null;
  userId: string;
  amountToman: number;
  payCurrency: string;
  ticker: string;
  status: string;
  balanceCredited: boolean;
  recoveryStatus: string;
  createdAt: string | null;
  paidAt: string | null;
}

export interface CustodyOverview {
  lastSyncedAt: string;
  providerHealth: { status: "healthy" | "down"; message: string };
  capabilities: {
    apiConfigured: boolean;
    ipnConfigured: boolean;
    custodyJwtConfigured: boolean;
    isOwner: boolean;
    apiHealthy: boolean;
    balanceEnabled: boolean;
    conversionsEnabled: boolean;
    payoutsEnabled: boolean;
  };
  balances: CustodyBalance[];
  totalTrackedAssets: number;
  balanceError: string | null;
  recentConversions: CustodyConversion[];
  conversionsError: string | null;
  recentPayouts: CustodyPayout[];
  payoutsError: string | null;
  localSummary: { finishedCount: number; finishedToman: number; pendingCount: number; recoveryRequiredCount: number; underpaidCount: number };
  recentDeposits: CustodyLocalInvoice[];
  reconciliationWarnings: { orderId: string; userId: string; status: string; payCurrency: string; amountToman: number; reason: string }[];
}

export interface CustodyReconcileFinding {
  orderId: string;
  userId: string;
  amountToman: number;
  payCurrency: string;
  localStatus: string;
  providerStatus: string | null;
  balanceCredited: boolean;
  classification: string;
  severity: "ok" | "info" | "warning" | "critical";
  detail: string;
}

export interface CustodyReconcileResult {
  checkedAt: string;
  checkedCount: number;
  discrepancyCount: number;
  findings: CustodyReconcileFinding[];
}

export class AdminApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
