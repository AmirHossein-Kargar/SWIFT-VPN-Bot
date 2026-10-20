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

export class AdminApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
