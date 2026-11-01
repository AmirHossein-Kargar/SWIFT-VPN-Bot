# WizardXray integration

How this application uses the provider's web service (REST API v1). The client is `api/wizardApi.js`, and the error table it runs
on is `api/wizardErrors.js`. The provider's document is not in this repository: this page records what was read from it and
what the code does about each part.

**What has been proven.** Everything here is tested against a local server that follows the document
(`tests/helpers/fakeWizardPanel.js`, `tests/unit/wizardApiEndpoints.test.js`, `tests/unit/wizardErrorCatalog.test.js`). That shows the
application keeps its side of the contract. **Nothing authenticated has been run against the live provider**, because no credentials
were available when this was written. See [What the live provider has confirmed](#what-the-live-provider-has-confirmed).

- [Connection](#connection)
- [Methods](#methods)
- [Aliases](#aliases)
- [Which answers are final](#which-answers-are-final)
- [Errors](#errors)
- [The service object](#the-service-object)
- [Subscription links](#subscription-links)
- [Unlimited](#unlimited)
- [Renewal](#renewal)
- [What the live provider has confirmed](#what-the-live-provider-has-confirmed)
- [What is deliberately not done](#what-is-deliberately-not-done)

## Connection

Each bot account has its own address, so `WIZARD_API_URL` comes from the provider's bot and always ends in `/api/v1/`. Balance, prices,
limits, locations and whether unlimited is sold all differ per account, so they are read from `me` and `get_hosts`, never assumed.

- **Auth:** `Authorization: Bearer <VPN_API_KEY>`. The key stays on the server.
- **Requests:** reads are GET; anything that changes a service is a form POST, sent once.
- **Timeouts:** 60 seconds for anything that changes a service, because the document says `create` and `renew` make several calls to
  the service panel. 15 seconds for reads.
- **Redirects** are never followed: axios would turn a POST into a GET, or re-send a paid call somewhere else.
- **No client retries.** A read is asked again by whoever needs it next. A paid call is never repeated, because `create` has no idempotency key.
- **Provider text stays in the client.** Callers get stable codes, so supplier prices cannot reach a log or a record.

## Methods

| Method | Client function | Used by | Notes |
|---|---|---|---|
| `me` | `getAccount` | `services/wizardAccount.js`, read by the catalog gate, System Health, the dashboard, `/panel/vpns/remote`, the admin API purchase | Cached 60 seconds and shared. Never throws: `null` means not known |
| `status` | `StatusApi` | System Health, `/status` command, admin status screen, admin API purchase | `system` says whether the bot reaches its service panel. `ping` is in **seconds** |
| `price` | `quotePrice` | `/api/admin/provider/quote`, the renew dialog, System Health | A read. Its answer is compared with `me`'s prices as a health check |
| `get_hosts` | `getHosts` | `/panel/vpns/remote`, System Health | Node addresses and ports are dropped in the client. 403 with an empty `error` means none |
| `create` | `createVpnService`, `createTestService` | Wallet purchase, reserved-order approval, admin API purchase, test service | The answer is checked against what was asked for |
| `info` | `getServiceInfo` | My Services, QR code, on/off button, admin detail and actions | The live read. `source: "cache"` becomes `live: false` |
| `clients` | `listClients` | `/panel/vpns/remote`, the recovery lead | Reads `result.list`. 404 `no service` is an empty page |
| `find` | none | | Legacy. The document says to use `info` for new work, and `info` replaces it everywhere |
| `renew` | `renewService` | Admin only (`renew` action) | See [Renewal](#renewal) |
| `upg_time` | `upgradeServiceTime` | Admin (`extend-time`) | Also reactivates a disabled service |
| `upg_size` | `upgradeServiceSize` | Admin (`increase-traffic`) | Minimum 1 GB. An unlimited service refuses it |
| `change_link` | `changeLinkService` | Customer button, admin action | Every stored copy is updated, or the old link gets rebuilt |
| `reverse_mode` | `setServiceStatus` | Customer button, admin `disable`/`enable` | **Always sends `status`.** Without it the method toggles, so a repeat undoes itself |
| `delsv` | `deleteService` | Customer delete, admin `revoke` | `alreadyGone` when it answers without `return_price`. The refund goes to the provider wallet |

## Aliases

The provider treats these as the same method, and matches names regardless of case, `-` or `_`. This application calls only the primary
names, so an alias never reaches the provider from here.

| Primary | Aliases, not used |
|---|---|
| `me` | `account`, `balance` |
| `price` | `quote` |
| `get_hosts` | `hosts`, `locations` |
| `create` | `buy` |
| `info` | `service` |
| `clients` | `list`, `services` |
| `upg_time` | `add_time`, `upgrade_time`, `extend` |
| `upg_size` | `add_volume`, `add_traffic`, `upgrade_size` |
| `change_link` | `revoke_sub`, `new_link` |
| `reverse_mode` | `mode_reverse`, `toggle_status`, `set_status` |
| `delsv` | `delete`, `remove` |

`status`, `find` and `renew` have none.

## Which answers are final

This decides whether money can move, so it is one rule, in one place (`api/wizardApi.js`):

| The panel answers | Verdict | A paid call then |
|---|---|---|
| `ok: true` with the terms asked for | Done | Records the service |
| `ok: true` with **other** terms | Ambiguous (`provisioning_terms_mismatch`) | Held for review: the service exists and was charged |
| `ok: false` on a 2xx or 4xx, with a matching `http_code` | Definite refusal | Refunds the customer, or parks on a shortage |
| 500 with the exact text the document lists **for that method** | Definite, because the document states the outcome | Refunds the customer |
| `internal error`, any other 5xx, a 3xx, a 408, a timeout, a dropped connection, a body that contradicts itself | **Ambiguous** | Held for review, never replayed, never refunded by itself |

An ambiguous order stays `manual_review` with the debit held. Nothing settles it by itself. On the recovery page **Check provider**
(`findProviderCandidates`) lists services nobody here knows about with the same terms from around that time, which is the document's
advice after a lost answer, with `clients` standing in for an idempotency key. An admin then settles the order
(`services/admin/orderSettlement.js`), and neither way calls a provider method that changes anything:

| Decision | The server requires | What happens |
|---|---|---|
| **Link** a found service | `info` answering live, with the sold traffic, not a test service, created between 2 minutes before the attempt and 15 after, and on no other order or customer | The order takes the service and is delivered. The held debit pays for it |
| **Refund** | The whole of `clients` read, with no candidate in it | The held debit goes back once through the normal refund path |

Both need a reason of 10 to 240 characters, are audited under `ORDER_UNKNOWN_SETTLED`, and are refused while the attempt is under 15
minutes old, because `create` may still answer and the list can lag. A list that cannot be read, or a stale `info`, moves nothing. A
late provider answer after a refund cannot deliver: the order is no longer `manual_review`. If a service does appear after a
refund, it stays at the provider as an orphan, which the refund dialog warns about.

## Errors

Every row is replayed over HTTP by `tests/unit/wizardErrorCatalog.test.js`, from a list kept separately from the table in the code.
"Retry" means the same request can be sent again as it is. "Money" is what the document says happened to the charge.

| HTTP | `error` | Methods | Reason in code | Retry | Money | What this application does |
|---|---|---|---|---|---|---|
| 400 | `invalid JSON body ( … )` | all | `invalid_json` | No | | Cannot occur: requests are forms. Treated as a refusal |
| 402 | `You don't have enough fund!` | create, renew, upg_time, upg_size | `provider_insufficient_balance` | No | None | Purchase parks as `awaiting_provider`. Admin action reports it |
| 403 | `method is invalid` | | `method_invalid` | No | | Refusal; counts as an outage. Means a wrong `WIZARD_API_URL` |
| 403 | `not authorized` | all | `auth_missing` | No | | System Health reads down and names the key |
| 403 | `apikey is invalid` | all | `auth_invalid` | No | | Same |
| 404 | `apikey is invalid or not found!` | all | `auth_invalid` | No | | Same |
| 403 | `API is not available` | all | `api_disabled` | Yes | | Same, with its own wording. A purchase is refunded |
| 404 | `method "…" not found!` | | `method_not_found` | No | | Refusal; counts as an outage |
| 403 | `username format is incorrect!` | service methods | `invalid_username` | No | | Local validation normally stops it first |
| 404 | `service not found!` | service methods except delsv | `service_not_found` | No | | My Services shows it as missing, not as an outage |
| 409 | `service is busy, try again` | renew, upg_time, upg_size, delsv, change_link, reverse_mode, create (test) | `provider_busy` | Yes | None | Reported, nothing retried automatically |
| 403 | `gig & day is required!` | create, renew, price | `terms_missing` | No | None | Local validation stops it first |
| 403 | `Minimum gig: 0.5 Minimum day: 1` | create, renew, price | `terms_below_minimum` | No | None | Same |
| 403 | `Maximum gig: 10000 Maximum day: 3650` | create, renew, price | `terms_above_maximum` | No | None | Same |
| 403 | `Minimum day: 1 Maximum day: 3650` | create, renew, price | `unlimited_days_out_of_range` | No | None | Catalog durations are inside it |
| 403 | `unlimited is not enabled` | create, renew, price, upg_time | `unlimited_disabled` | No | None | Hidden from sale first. If it arrives anyway, a purchase is refunded |
| 404 | `test paramter is required!` | create | `test_param_missing` | No | None | Cannot occur: the client always sends it |
| 403 | `test must be 0 or 1` | create | `test_param_invalid` | No | None | Local validation stops it |
| 403 | `Maximum test is N` | create | `test_unavailable` | No | None | The customer is told tests are off |
| 403 | `day is required!` | upg_time | `day_missing` | No | None | Local validation stops it |
| 404 | `Minimum day: 1` | upg_time | `add_day_below_minimum` | No | None | Same |
| 403 | `Maximum day: 3650` | upg_time | `add_day_above_maximum` | No | None | Same |
| 403 | `gig is required!` | upg_size | `gig_missing` | No | None | Same |
| 404 | `Minimum gig: 1` | upg_size | `add_gig_below_minimum` | No | None | Same |
| 403 | `Maximum gig: 10000` | upg_size | `add_gig_above_maximum` | No | None | Same |
| 403 | `service is unlimited` | upg_size | `service_is_unlimited` | No | None | The action is not offered for an unlimited service |
| 403 | `status must be active or disabled` | reverse_mode | `status_invalid` | No | | Local validation stops it |
| 404 | `no service` | clients | `no_services` | | | An empty list, not an error |
| 403 | `""` (empty) | get_hosts | `hosts_unavailable` | No | | System Health reads degraded |
| 500 | `cant create service` | create | `create_failed` | No | Refunded | Definite: the customer is refunded |
| 500 | `cant get info` | renew, delsv | `panel_read_failed` | Yes | None | Definite: nothing changed |
| 500 | `cant get service info` | upg_time, upg_size, reverse_mode | `panel_read_failed` | Yes | None | Definite: nothing changed |
| 500 | `cant reset usage` | renew | `update_failed` | No | Refunded | Definite |
| 500 | `cant update service` | renew, upg_time, upg_size | `update_failed` | No | Refunded | Definite |
| 500 | `cant update service` | change_link, reverse_mode | `update_failed` | No | | Definite |
| 500 | `cant delete service` | delsv | `delete_failed` | No | None | The service stays in the customer's list |
| 500 | `internal error` | all | none | | **Unknown** | **Ambiguous on purpose**: the document promises nothing about it |

## The service object

`normalizeService` is the only reader. `info` returns the object in `result`, and the methods that change a service return it in
`result.service`.

- **Unlimited is not zero.** `data_limit: 0` and `remaining_traffic: null` mean no limit. `remainingGb` is `null` for an unlimited
  service, and nothing may treat it as an empty quota.
- **Unlimited traffic is not unlimited time.** `expire` still applies. Only `expire: 0` means no date.
- **`source`:** `panel` is live. `cache` is the bot's last stored copy, with empty `links` and old usage, so it reads `live: false`,
  is labelled for the customer, is never cached here, and admin actions are disabled on it.
- **Statuses:** `active`, `disabled`, `limited` (traffic used up), `expired`, `on_hold` (waiting for the first connection). The customer's
  on/off button appears only for `active` and `disabled`: the others stopped for a reason a switch must not override.

Anything that changes a service calls `invalidateServiceStatus`, or the 90-second cache would show the link that was just revoked.

## Subscription links

The document says to give the customer `sub_link`. `services/subscriptionLink.js` does, and falls back to the older link built from `hash`
only for a record with no stored link. A built link does not follow `change_link`, which issues a new hash.

A subscription link is a credential: it is never logged, never returned by the remote client list, and never passed to monitoring.

QR codes are drawn in this process (`services/qrCode.js`), so a link goes nowhere but Telegram. If the picture fails, the same text goes
out as a message. A chat that refuses the bot would refuse the text as well, so that error goes to the caller's retry instead.

## Unlimited

The document's rule is `gig = 0`. Here that is `UNLIMITED_GIG`, and a product or order stores `0` (`utils/serviceTerms.js`).

- **Only a real zero means unlimited.** `Number("")`, `Number(null)` and `Number(false)` are all 0 in JavaScript, so a blank field would
  otherwise buy unlimited. The client takes a literal `0`, `parseTraffic` and the panel's form schema refuse blank, and an admin
  renewal needs an explicit `unlimited: true`.
- **The provider decides what is on sale.** `services/plans.js` offers an unlimited product only while `me` reports it enabled, which takes
  both `limits.unlimited_enabled` and a `prices.unlimited_per_day` above zero. Not being able to ask counts as no. The admin's product row
  is not changed, so it comes back by itself. Nothing in this application turns unlimited on: an admin creates the product.
- **Prices.** The customer pays the catalog price. The provider charges `day × unlimited_per_day` from its own wallet.
- **Durations** stay the catalog's 30, 90, 180 and 365 days, inside the provider's limits.
- **Display.** `نامحدود ♾` in the bot and storefront, Unlimited in the panel. Never 0 GB, and the expiry always shows.
- **Reports.** An unlimited order adds 0 to the estimated gigabytes sold in the financial report.

## Renewal

Admin only. Usage resets and the days are added. What carries over depends on the conversion, and the renew dialog says so before confirming.

| Service, then renewed as | New expiry | New traffic |
|---|---|---|
| Volume to volume | Current expiry (or now, if expired) + days | Remaining + `gig` |
| Unlimited to unlimited | Current expiry (or now) + days | Unlimited |
| Unlimited to volume | Current expiry (or now) + days | Exactly `gig` |
| Volume to unlimited | **Now** + days | Unlimited. The remaining days and traffic are lost, not refunded |
| Test service to anything | **Now** + days | Exactly `gig` (or unlimited). It becomes a normal service |

Stored dates and volumes come from the `service` in the answer, not from local arithmetic.

## What the live provider has confirmed

Nothing about the authenticated API, as of the probes behind this page. Those ran without a key, so they could only show who answers:

| Provider | Unauthenticated probe | Shows | Still unproven |
|---|---|---|---|
| WizardXray | The document's example host did not complete TLS from the test machine, and each bot has its own address | Nothing | The whole API, including every answer shape on this page |
| HooshPay | `GET /api/v1/balance` and `/account` answer 401 with a JSON `detail`; an unknown route answers 404 | The routes exist and require a key. A 401 can carry `detail` with no `success`, despite the document's statement that every answer has `success` | The authenticated answer |

**`/balance` is two different things.** For WizardXray, `balance` is only an alias of `me`, and this application calls `me` for the wallet.
The HooshPay `GET /balance` is the one a health check calls, and its document gives only the method, the path and the `X-API-KEY`
header: no fields, no rate limit. It lists 401 for a bad key, 403 for a blocked account and 503 for a disabled gateway or no active
card, and `probeHooshPay` reports each as itself. Only the `success` field is relied on.

`scripts/verify-production.mjs` runs the read-only half of this with real credentials: `railway run node scripts/verify-production.mjs`.
It prints the field names of the HooshPay answer and never their values, so the real shape can be read without exposing a balance.

## What is deliberately not done

- **Customers cannot renew or upgrade.** The bot's buttons answer that the option is off and to buy a new service. The catalog has no
  customer price per day or per gigabyte, and the provider's quote is what it charges this bot, not a retail price. The provider methods
  are integrated for admins only, `tests/unit/customerRenewalDisabled.test.js` fails if a customer route reaches them, and opening
  this needs a pricing policy from the owner.
- **A customer's delete refunds nothing to the customer.** `delsv` returns the unused value to this bot's provider wallet. The confirmation
  screen says so. Passing it on would be a new money path, and is the owner's call.
- **Provider cost is not stored on the order.** `result.charged` is ignored, as all supplier figures are, so profit reports use the
  catalog's `costToman`.
