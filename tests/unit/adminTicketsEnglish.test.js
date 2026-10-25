/**
 * The admin panel is English-only. Customer-facing Persian lives in the
 * customer support area (/panel/support) and in the Telegram bot; this guard
 * keeps it from leaking back into admin UI code, and checks that the admin
 * status filter, the status dropdown and the server share one canonical set.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { TICKET_STATUSES } from "../../models/SupportTicket.js";

const root = join(fileURLToPath(new URL("../..", import.meta.url)), "admin-panel");
const PERSIAN = /[؀-ۿ]/;
const RTL_MARKUP = /dir=["']rtl["']|lang=["']fa["']|fa-IR|Asia\/Tehran/;

/** The only places allowed to carry Persian: the customer-facing support area. */
const CUSTOMER_AREA = [
  `app${sep}support${sep}`,
  `components${sep}support${sep}`,
  `lib${sep}customerTickets.ts`,
  `lib${sep}customerApi.client.ts`,
  `lib${sep}customerApi.server.ts`,
];

function sources(dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(tsx?|css|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const isCustomerArea = (file) => CUSTOMER_AREA.some((prefix) => relative(root, file).startsWith(prefix));

describe("admin panel is English-only", () => {
  const adminFiles = sources().filter((file) => !isCustomerArea(file));

  test("no Persian text in any admin-panel source outside the customer support area", () => {
    const offenders = [];
    for (const file of adminFiles) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
        if (PERSIAN.test(line)) offenders.push(`${relative(root, file)}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  test("no RTL layout or Persian locale in admin components", () => {
    const offenders = [];
    for (const file of adminFiles) {
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
        // Analytics labels its reporting timezone; it is a data label, not locale formatting.
        if (RTL_MARKUP.test(line) && !/analytics-view\.tsx$/.test(file)) offenders.push(`${relative(root, file)}:${index + 1}`);
      });
    }
    assert.deepEqual(offenders, []);
  });

  test("the customer area stays Persian (the policy is admin-only)", () => {
    assert.match(read("lib/customerTickets.ts"), PERSIAN);
    assert.match(read("components/support/customer-ticket-actions.tsx"), PERSIAN);
  });

  test("admin ticket labels are plain English", () => {
    const tickets = read("lib/tickets.ts");
    for (const label of ["Open", "Awaiting customer", "Closed"]) assert.ok(tickets.includes(`"${label}"`), label);
  });
});

describe("ticket status: one canonical set", () => {
  const extract = (source, name) => {
    const match = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]+)\\]`).exec(source);
    assert.ok(match, `${name} not found`);
    return [...match[1].matchAll(/"([a-z_]+)"/g)].map((item) => item[1]);
  };

  test("the admin client lists exactly the server's statuses", () => {
    assert.deepEqual(extract(read("lib/tickets.ts"), "TICKET_STATUSES"), [...TICKET_STATUSES]);
    assert.deepEqual([...TICKET_STATUSES], ["open", "pending_customer", "closed"]);
  });

  test("every status has a label, a badge variant and a transition entry", () => {
    const tickets = read("lib/tickets.ts");
    for (const status of TICKET_STATUSES) {
      assert.match(tickets, new RegExp(`\\b${status}:\\s*"`), `${status} label/variant`);
      assert.match(tickets, new RegExp(`\\b${status}:\\s*\\[`), `${status} transitions`);
    }
  });

  test("the filter and the dropdown render from the shared list with the design-system Select", () => {
    for (const file of ["components/tickets/tickets-filters.tsx", "components/tickets/admin-ticket-actions.tsx"]) {
      const source = read(file);
      assert.match(source, /TICKET_STATUSES/, file);
      assert.match(source, /from "@\/components\/ui\/select"/, file);
      assert.doesNotMatch(source, /<select[\s>]/, `${file} must not use a native select (unreadable options in dark mode)`);
    }
  });

  test("the shared Select styles every state with theme tokens", () => {
    const select = read("components/ui/select.tsx");
    for (const token of ["bg-popover", "text-popover-foreground", "data-[highlighted]:bg-accent", "data-[state=checked]", "data-[disabled]", "bg-background"]) {
      assert.ok(select.includes(token), token);
    }
    assert.doesNotMatch(select, /radix-select-trigger-height/);
  });
});
