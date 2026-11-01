import http from "node:http";

const GIB = 1_073_741_824;
const DAY = 86_400;

/**
 * A local WizardXray that follows the document: one account, services kept in memory, the renew conversion table, and each
 * method's real response shape. It is a stand-in for proving this application's side of the contract. It says nothing about the
 * live provider. `fail(path, answer)` makes the next call to a method answer as given.
 */
export async function startFakeWizardPanel({ unlimitedPerDay = 3000 } = {}) {
  const now = () => Math.floor(Date.now() / 1000);
  const services = new Map();
  const calls = [];
  const failures = new Map();
  const state = { balance: 5_000_000, perGb: 1500, perDay: 500, unlimitedPerDay };
  let serial = 0;

  const view = (service, source = "panel") => {
    const unlimited = service.unlimited;
    const limit = unlimited ? 0 : Math.round(service.gig * GIB);
    const used = Math.round((service.usedGb ?? 0) * GIB);
    return {
      username: service.username, status: service.status, source, test: false, unlimited,
      sub_link: `https://sub.example.test/sub/${service.hash}`, links: source === "panel" ? [`vless://${service.hash}@de.example.test:443#Germany`] : [],
      expire: service.expire, expire_jalali: "1405/9/3 18:27", days_left: Math.round(((service.expire - now()) / DAY) * 100) / 100,
      data_limit: limit, used_traffic: used, remaining_traffic: unlimited ? null : limit - used,
      data_limit_gb: service.unlimited ? 0 : service.gig, used_traffic_gb: service.usedGb ?? 0, remaining_traffic_gb: unlimited ? 0 : service.gig - (service.usedGb ?? 0),
      online_at: null, online_at_jalali: null, last_client: null, created_at: service.createdAt, created_at_jalali: "1405/8/3 18:27",
    };
  };

  const add = (fields = {}) => {
    serial += 1;
    const username = fields.username ?? `SVC${String(serial).padStart(6, "0")}`;
    const service = { username, status: "active", gig: 20, unlimited: false, usedGb: 0, hash: `hash${serial}`, expire: now() + 30 * DAY, createdAt: now(), day: 30, ...fields };
    services.set(username, service);
    return service;
  };

  const refused = (http_code, error, result = []) => ({ status: http_code, body: { ok: false, error, result, http_code } });
  const done = (result, extra = {}) => ({ status: 200, body: { ok: true, error: "", result, http_code: 200, ...extra } });

  const METHODS = {
    me: () => done({ user_id: 1, balance: state.balance, currency: "toman", prices: { per_gb: state.perGb, per_day: state.perDay, unlimited_per_day: state.unlimitedPerDay, test: 1500, activation: 300000, custom: false }, limits: { min_gig: 0.5, max_gig: 10000, min_day: 1, max_day: 3650, min_add_gig: 1, min_add_day: 1, unlimited_enabled: state.unlimitedPerDay > 0, test_enabled: true, test_gig: 0.3, test_day: 1, max_tests: 100, tests_used: 0 }, services: { total: services.size, active: services.size } }),
    get_hosts: () => done({ "VLESS TCP REALITY": [{ id: 1, remark: "Germany", address: "de.example.test", port: 443, is_disabled: false }] }),
    price: ({ gig, day }) => {
      const unlimited = Number(gig) === 0;
      if (unlimited && !state.unlimitedPerDay) return refused(403, "unlimited is not enabled");
      const price = unlimited ? day * state.unlimitedPerDay : gig * state.perGb + day * state.perDay;
      return done({ gig: Number(gig), day: Number(day), unlimited, price, balance: state.balance, enough: state.balance >= price });
    },
    info: ({ username }) => (services.has(username) ? done(view(services.get(username))) : refused(404, "service not found!")),
    clients: ({ limit, offset = 0 }) => {
      const rows = [...services.values()].sort((a, b) => a.expire - b.expire);
      const page = rows.slice(Number(offset), limit ? Number(offset) + Number(limit) : undefined);
      if (!page.length) return refused(404, "no service");
      return done({ count: page.length, total: rows.length, list: page.map((service) => ({ ...view(service, "cache"), usage: 0, gig: service.unlimited ? 0 : service.gig, day: service.day, expiration_time: service.expire, package_size: service.unlimited ? 0 : service.gig * GIB })) });
    },
    renew: ({ username, gig, day }) => {
      const service = services.get(username);
      if (!service) return refused(404, "service not found!");
      const toUnlimited = Number(gig) === 0;
      if (toUnlimited && !state.unlimitedPerDay) return refused(403, "unlimited is not enabled");
      const base = !service.unlimited && toUnlimited ? now() : Math.max(service.expire, now());
      const left = !service.unlimited && !toUnlimited ? service.gig - service.usedGb : 0;
      Object.assign(service, { unlimited: toUnlimited, gig: toUnlimited ? 0 : left + Number(gig), usedGb: 0, status: "active", expire: base + Number(day) * DAY });
      return done({ username, new_datalimit: service.gig * GIB, new_exp: service.expire, new_usage: 0, left_data: left * GIB, price: 1, unlimited: toUnlimited, service: view(service) });
    },
    upg_time: ({ username, day }) => {
      const service = services.get(username);
      if (!service) return refused(404, "service not found!");
      service.expire = Math.max(service.expire, now()) + Number(day) * DAY;
      service.status = "active";
      return done({ new_exp: service.expire, day_added: Number(day), price: 2500, service: view(service) });
    },
    upg_size: ({ username, gig }) => {
      const service = services.get(username);
      if (!service) return refused(404, "service not found!");
      if (service.unlimited) return refused(403, "service is unlimited");
      if (Number(gig) < 1) return refused(404, "Minimum gig: 1");
      service.gig += Number(gig);
      service.status = "active";
      return done({ new_size: service.gig * GIB, gig_added: Number(gig), new_gig: service.gig, price: 7500, service: view(service) });
    },
    change_link: ({ username }) => {
      const service = services.get(username);
      if (!service) return refused(404, "service not found!");
      service.hash = `${service.hash}x`;
      return done({ new_sub_link: `https://sub.example.test/sub/${service.hash}`, new_hash: service.hash, new_uid: "u", service: view(service) });
    },
    reverse_mode: ({ username, status }) => {
      const service = services.get(username);
      if (!service) return refused(404, "service not found!");
      if (status !== undefined && !["active", "disabled"].includes(status)) return refused(403, "status must be active or disabled");
      service.status = status ?? (service.status === "active" ? "disabled" : "active");
      return done({ new_mode: service.status, service: view(service) });
    },
    delsv: ({ username }) => {
      if (!services.delete(username)) return done(["successfully deleted"]);
      return done(["successfully deleted"], { return_price: 1250, left_time_day: 1, left_data_gig: 0.5 });
    },
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://panel.test");
      const method = url.pathname.split("/").filter(Boolean).at(-1);
      const params = { ...Object.fromEntries(url.searchParams), ...Object.fromEntries(new URLSearchParams(body)) };
      calls.push({ method, verb: req.method, params });
      const failure = failures.get(method);
      if (failure) failures.delete(method);
      if (failure === "drop") return req.socket.destroy();
      const answer = failure ?? METHODS[method]?.(params) ?? refused(404, `method "${method}" not found!`);
      res.writeHead(answer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1/`,
    state,
    services,
    calls,
    add,
    fail: (method, answer) => failures.set(method, answer),
    refused,
    callsTo: (method) => calls.filter((call) => call.method === method),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
