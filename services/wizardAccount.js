/**
 * What the provider says about this account: balance, prices, limits and whether unlimited is sold. All of it differs per bot,
 * so it is read from `me`, never assumed.
 *
 * The answer is cached briefly and shared, because the shop menu reads it on every render and must not turn each browse into a
 * provider call. A failed read is remembered too, for less time, so an outage cannot make every menu wait out a timeout. It
 * never throws: `null` means "not known", and each caller says what not knowing means for it. Selling unlimited needs a known
 * yes, so not knowing hides it. Nothing here is written to a log or a record.
 */
import { getAccount } from "../api/wizardApi.js";

const FRESH_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 10_000;

let cached = null;
let failedAt = 0;
let inFlight = null;
let override;

function load() {
  inFlight ||= getAccount()
    .then((account) => { cached = { account, at: Date.now() }; failedAt = 0; return account; })
    .catch(() => { failedAt = Date.now(); return null; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function getProviderAccount({ maxAgeMs = FRESH_MS } = {}) {
  if (override !== undefined) return override;
  const now = Date.now();
  if (cached && now - cached.at < maxAgeMs) return cached.account;
  if (now - failedAt < RETRY_AFTER_FAILURE_MS) return null;
  return load();
}

/** Forget the stored answer, so the next reader sees what a purchase or an admin change just did. */
export function invalidateProviderAccount() {
  cached = null;
  failedAt = 0;
}

/** `{ known, enabled, perDay }`. `enabled` is true only on a positive answer from the provider. */
export async function unlimitedAvailability(options) {
  const account = await getProviderAccount(options);
  if (!account) return { known: false, enabled: false, perDay: null };
  return { known: true, enabled: account.limits.unlimitedEnabled, perDay: account.prices.unlimitedPerDay };
}

/** The provider's price for these terms by the document's formula. Null when the account or the terms are unusable. */
export function providerCost(account, { gig, days }) {
  if (!account || !Number.isFinite(gig) || !Number.isFinite(days)) return null;
  if (gig === 0) return account.limits.unlimitedEnabled ? days * account.prices.unlimitedPerDay : null;
  return gig * account.prices.perGb + days * account.prices.perDay;
}

export function setProviderAccountForTests(value) {
  override = value;
}

export function resetProviderAccountForTests() {
  override = undefined;
  cached = null;
  failedAt = 0;
  inFlight = null;
}
