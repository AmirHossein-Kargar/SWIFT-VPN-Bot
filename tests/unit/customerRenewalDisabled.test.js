/**
 * Customers cannot renew or upgrade. The catalog has no customer price per day or per gigabyte, and the provider's quote is what it
 * charges this bot, not a retail price. So until a pricing policy exists, these must stay unreachable from anything a customer can
 * trigger, because any such path would charge the provider wallet for a customer who paid nothing.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === "node_modules" || name === "public" || name.startsWith(".")) return [];
  return statSync(path).isDirectory() ? walk(path) : /\.m?js$/.test(name) ? [path] : [];
});
const APPLICATION = ["api", "handlers", "services", "web", "keyboards", "messages", "paymentHandlers", "utils"].flatMap((folder) => walk(join(ROOT, folder)));
const SPENDERS = /\b(renewService|upgradeServiceTime|upgradeServiceSize)\b/;

describe("customer renewal stays off", () => {
  test("the calls that charge the provider for an existing service are used in one place, the admin service", () => {
    const users = APPLICATION.filter((file) => SPENDERS.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file).replaceAll("\\", "/")).sort();
    assert.deepEqual(users, ["api/wizardApi.js", "services/admin/vpns.js"]);
  });

  test("that admin service is reached only through the admin router and the admin bot panel", () => {
    const users = APPLICATION.filter((file) => /(?:admin\/|"\.\/)vpns\.js"/.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file).replaceAll("\\", "/")).sort();
    assert.deepEqual(users, ["handlers/admin/panel.js", "services/admin/orderSettlement.js", "web/adminRouter.js"]);
  });

  test("every action that spends is admin-checked first, and needs a reason", () => {
    const source = read("services/admin/vpns.js");
    const body = source.slice(source.indexOf("export async function performVpnAction"));
    assert.ok(body.indexOf("assertAdminUser(actorId)") < body.indexOf("runAuditedAction"), "authorized before anything is audited or sent");
    assert.match(source, /REASON_REQUIRED = new Set\(\[[^\]]*"extend-time"[^\]]*"increase-traffic"[^\]]*"renew"/);
  });

  test("the bot's admin panel offers no renew action either", () => {
    const panel = read("handlers/admin/panel.js");
    assert.doesNotMatch(panel, /adm:vpact:(renew|extend-time|increase-traffic)/);
  });

  test("both customer buttons answer that the option is off, and call nothing", () => {
    const source = read("handlers/handleCallbackQuery.js");
    const branch = source.slice(source.indexOf('data.startsWith("extend_service_")'), source.indexOf("// ── Admin: HooshPay invoice search prompt"));
    assert.match(branch, /این آپشن در حال حاضر غیرفعال است/);
    assert.match(branch, /answerCallbackQuery/);
    assert.doesNotMatch(branch, /await (?!bot\.answerCallbackQuery)\w/, "nothing else is awaited there");
    assert.equal(branch.includes("Wallet"), false);
    assert.equal(/reserveBalance|purchasePlan/.test(branch), false);
  });

  test("the storefront and support routes expose no way to renew", () => {
    for (const path of ["web/storeRouter.js", "web/supportRouter.js"]) assert.doesNotMatch(read(path), /renew|upg_time|upg_size|extend/i, path);
  });

  test("the catalog has no customer price for a day or a gigabyte, which is why this is off", () => {
    assert.doesNotMatch(read("models/AdminProduct.js"), /perDay|perGb|renew/i);
  });
});
