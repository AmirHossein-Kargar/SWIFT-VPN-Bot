/* ============================================================================
   SWIFT Admin — single-page control center
   Talks only to /api/admin/*; every mutation is idempotent via operationId.
   ========================================================================== */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    csrfToken: null,
    actorId: null,
    route: "dashboard",
    caches: {},
  };

  // ── Utilities ──────────────────────────────────────────────────────────────
  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (value) => (value == null || Number.isNaN(Number(value))) ? "—" : Number(value).toLocaleString("en-US");
  const money = (value) => (value == null || Number.isNaN(Number(value))) ? "—" : Number(value).toLocaleString("en-US") + " T";
  const pct = (value) => (value == null || Number.isNaN(Number(value))) ? "—" : (100 * Number(value)).toFixed(1) + "%";
  const dateFmt = (value) => {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const dateShort = (value) => {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  };

  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  function toast(kind, message) {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = message;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 4200);
    setTimeout(() => el.remove(), 4600);
  }

  function newOperationId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ── API client ─────────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const options = { method, headers: {} };
    if (state.csrfToken) options.headers["x-csrf-token"] = state.csrfToken;
    if (body !== undefined) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`/api/admin${path}`, options);
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (response.status === 401) { showLogin(); throw new Error(data?.message || "Session expired — sign in again."); }
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.message || data?.error || `Request failed (${response.status})`);
      error.code = data?.error;
      error.status = response.status;
      throw error;
    }
    return data;
  }
  const GET = (p) => api("GET", p);
  const POST = (p, b) => api("POST", p, b ?? {});
  const PATCH = (p, b) => api("PATCH", p, b ?? {});

  function apiErrorToast(error) {
    toast("error", error.message || "The request failed.");
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function openModal({ title, bodyHtml, confirmText = "Confirm", danger = false, onConfirm }) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    const foot = $("#modal-foot");
    foot.innerHTML = "";
    const cancel = document.createElement("button");
    cancel.className = "btn"; cancel.textContent = "Cancel";
    cancel.onclick = closeModal;
    const ok = document.createElement("button");
    ok.className = `btn ${danger ? "danger" : "primary"}`;
    ok.innerHTML = `${confirmText}`;
    ok.onclick = async () => {
      const values = {};
      $$("#modal-body input, #modal-body textarea, #modal-body select").forEach((input) => {
        values[input.dataset.field] = input.type === "number" ? input.value : input.value;
      });
      ok.disabled = true;
      try { await onConfirm(values); } finally { ok.disabled = false; }
    };
    foot.append(cancel, ok);
    $("#modal-backdrop").classList.add("show");
  }
  function closeModal() { $("#modal-backdrop").classList.remove("show"); }
  $("#modal-backdrop").addEventListener("click", (event) => { if (event.target.id === "modal-backdrop") closeModal(); });

  const fieldHtml = (label, name, { placeholder = "", type = "text", value = "", hint = "" } = {}) => `
    <label class="field">
      <span class="field-label">${esc(label)}</span>
      <input class="input${type === "text" ? "" : ""}" data-field="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" />
      ${hint ? `<span style="color:var(--text-faint);font-size:11.5px;margin-top:4px;display:block">${esc(hint)}</span>` : ""}
    </label>`;

  const reasonField = (hint = "Recorded in the audit log.") => fieldHtml("REASON", "reason", { placeholder: "Why is this action being taken?", hint });

  // ── Drawer ─────────────────────────────────────────────────────────────────
  function openDrawer(title, sub, html) {
    $("#drawer-title").textContent = title;
    $("#drawer-sub").textContent = sub || "";
    $("#drawer-body").innerHTML = html;
    $("#drawer").classList.add("open");
    $("#drawer-backdrop").classList.add("show");
  }
  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawer-backdrop").classList.remove("show");
  }
  $("#drawer-close").onclick = closeDrawer;
  $("#drawer-backdrop").onclick = closeDrawer;

  // ── Status pills ───────────────────────────────────────────────────────────
  const PILL_TONES = {
    pending: "yellow", paid: "blue", fulfilled: "green", failed: "red",
    cancelled: "gray", refunded: "yellow", "recovery-required": "red",
    active: "green", expired: "yellow", revoked: "gray", unknown: "gray",
    expiring: "yellow", healthy: "green", degraded: "yellow", down: "red",
    blocked: "red", unblocked: "green", enabled: "green", disabled: "gray",
  };
  const pill = (label) => {
    const key = String(label || "").toLowerCase();
    const tone = PILL_TONES[key] || "gray";
    return `<span class="pill ${tone}"><span class="dot"></span>${esc(label || "unknown")}</span>`;
  };

  // ── Charts (SVG) ───────────────────────────────────────────────────────────
  function lineChart(series, { height = 220, color = "#3B82F6", fill = true, format = num } = {}) {
    if (!series || !series.length) return `<div class="empty">No data for this period yet.</div>`;
    const width = 720;
    const pad = { top: 14, right: 10, bottom: 24, left: 46 };
    const values = series.map((d) => Number(d.value || 0));
    const max = Math.max(...values, 1);
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const x = (i) => pad.left + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
    const y = (v) => pad.top + innerH - (v / max) * innerH;
    const points = series.map((d, i) => `${x(i).toFixed(1)},${y(Number(d.value || 0)).toFixed(1)}`).join(" ");
    const area = `${pad.left},${pad.top + innerH} ${points} ${pad.left + innerW},${pad.top + innerH}`;
    const ticks = [0, max / 2, max];
    const grid = ticks.map((t) =>
      `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(t)}" y2="${y(t)}" stroke="#20262E" stroke-width="1"/>
       <text x="${pad.left - 7}" y="${y(t) + 3.5}" fill="#5E6B7E" font-size="10" text-anchor="end">${format(t)}</text>`).join("");
    const labels = series
      .filter((_, i) => i % Math.ceil(series.length / 7) === 0 || i === series.length - 1)
      .map((d) => {
        const i = series.indexOf(d);
        return `<text x="${x(i)}" y="${height - 6}" fill="#5E6B7E" font-size="9.5" text-anchor="middle">${esc(String(d.date).slice(5))}</text>`;
      }).join("");
    const dots = series.map((d, i) => `<circle cx="${x(i)}" cy="${y(Number(d.value || 0))}" r="2.4" fill="${color}"><title>${esc(d.date)}: ${format(d.value)}</title></circle>`).join("");
    return `
      <svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        ${grid}
        ${fill ? `<polygon points="${area}" fill="rgba(59,130,246,0.10)"/>` : ""}
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${labels}
      </svg>`;
  }

  function barChart(items, { height = 220, color = "#3B82F6", format = num } = {}) {
    const entries = (items || []).slice(0, 8);
    if (!entries.length) return `<div class="empty">No data yet.</div>`;
    const width = 720;
    const pad = { top: 14, right: 10, bottom: 40, left: 46 };
    const max = Math.max(...entries.map((e) => Number(e.count || 0)), 1);
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const slot = innerW / entries.length;
    const barW = Math.min(46, slot * 0.55);
    const bars = entries.map((entry, i) => {
      const barH = (Number(entry.count || 0) / max) * innerH;
      const bx = pad.left + i * slot + (slot - barW) / 2;
      const by = pad.top + innerH - barH;
      const label = String(entry.name || entry.productId || "?");
      const short = label.length > 14 ? label.slice(0, 13) + "…" : label;
      return `
        <rect x="${bx}" y="${by}" width="${barW}" height="${Math.max(barH, 1)}" rx="4" fill="${color}" opacity="${0.55 + 0.45 * (Number(entry.count || 0) / max)}"><title>${esc(label)}: ${num(entry.count)} (${money(entry.revenue)})</title></rect>
        <text x="${bx + barW / 2}" y="${height - 22}" fill="#98A2B3" font-size="9.5" text-anchor="middle">${esc(short)}</text>
        <text x="${bx + barW / 2}" y="${height - 10}" fill="#5E6B7E" font-size="9" text-anchor="middle">${format(entry.count)}</text>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${bars}</svg>`;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  const NAV = [
    { id: "dashboard", label: "Dashboard", icon: "grid", section: "Overview" },
    { id: "analytics", label: "Analytics", icon: "chart", section: "Overview" },
    { id: "users", label: "Users", icon: "users", section: "Manage" },
    { id: "vpns", label: "VPN Services", icon: "globe", section: "Manage" },
    { id: "payments", label: "Payments", icon: "card", section: "Money" },
    { id: "recovery", label: "Recovery", icon: "life", section: "Money" },
    { id: "products", label: "Products", icon: "box", section: "Money" },
    { id: "broadcast", label: "Broadcast", icon: "megaphone", section: "Engage" },
    { id: "referrals", label: "Referrals", icon: "gift", section: "Engage" },
    { id: "audit", label: "Audit Log", icon: "scroll", section: "System" },
    { id: "admins", label: "Admins", icon: "shield", section: "System" },
    { id: "system", label: "System", icon: "wrench", section: "System" },
  ];

  function renderNav() {
    const sidebar = $("#sidebar");
    let html = `
      <div class="brand">
        <div class="brand-mark">${icon("shield")}</div>
        <div>
          <div class="brand-name">SWIFT Admin</div>
          <div class="brand-sub">Control Center</div>
        </div>
      </div>`;
    let section = "";
    for (const item of NAV) {
      if (item.section !== section) {
        section = item.section;
        html += `<div class="nav-label">${esc(section)}</div>`;
      }
      html += `<div class="nav-item ${state.route === item.id ? "active" : ""}" data-route="${item.id}">${icon(item.icon)}<span>${esc(item.label)}</span><span class="badge" id="badge-${item.id}" style="display:none"></span></div>`;
    }
    html += `
      <div class="sidebar-footer">
        <div style="font-size:11px;color:var(--text-faint);line-height:1.6;padding:0 10px">
          SWIFT-VPN-Bot<br/>Admin Console v1.0
        </div>
      </div>`;
    sidebar.innerHTML = html;
    $("#bottom-nav").innerHTML = ["dashboard", "users", "vpns", "payments", "recovery", "system"]
      .map((id) => {
        const item = NAV.find((n) => n.id === id);
        return `<div class="nav-item ${state.route === id ? "active" : ""}" data-route="${id}">${icon(item.icon)}<span>${esc(item.label.split(" ")[0])}</span></div>`;
      }).join("");
    $$(".nav-item").forEach((el) => {
      el.onclick = () => navigate(el.dataset.route);
    });
  }

  async function setBadge(id, count) {
    const el = $(`#badge-${id}`);
    if (!el) return;
    if (count > 0) { el.textContent = count > 99 ? "99+" : String(count); el.style.display = ""; }
    else el.style.display = "none";
  }

  function navigate(route) {
    location.hash = `#/${route}`;
  }

  async function refreshRecoveryBadge() {
    try {
      const data = await GET("/recovery?pageSize=1");
      await setBadge("recovery", data.data.total);
    } catch { /* badge is best-effort */ }
  }

  // ── Page shell helpers ─────────────────────────────────────────────────────
  function loading() {
    return `<div class="loading-overlay"><div class="spinner"></div><div>Loading…</div></div>`;
  }

  function pagerHtml(page, pages, total, handlerName) {
    if (!pages || pages <= 1) return `<div class="pager"><div class="grow"></div><span>${num(total)} record${total === 1 ? "" : "s"}</span></div>`;
    return `
      <div class="pager">
        <button class="btn sm" data-pager="${handlerName}" data-page="1" ${page <= 1 ? "disabled" : ""}>«</button>
        <button class="btn sm" data-pager="${handlerName}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Prev</button>
        <span class="grow">Page ${page} of ${pages}</span>
        <span>${num(total)} records</span>
        <button class="btn sm" data-pager="${handlerName}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next</button>
        <button class="btn sm" data-pager="${handlerName}" data-page="${pages}" ${page >= pages ? "disabled" : ""}>»</button>
      </div>`;
  }

  function bindPagers() {
    $$("[data-pager]").forEach((button) => {
      button.onclick = () => {
        const handler = PAGER_HANDLERS[button.dataset.pager];
        if (handler) handler(Number(button.dataset.page));
      };
    });
  }
  const PAGER_HANDLERS = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // PAGES
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Dashboard ──────────────────────────────────────────────────────────────
  async function pageDashboard() {
    $("#content").innerHTML = loading();
    let data;
    try { data = (await GET("/dashboard")).data; }
    catch (error) { $("#content").innerHTML = errorBox(error); return; }
    const m = data.metrics;

    $("#content").innerHTML = `
      <div class="grid cols-4" style="margin-bottom:16px">
        ${stat("Total Users", num(m.totalUsers), "users", "", "All registered accounts")}
        ${stat("Active Users", num(m.activeUsers), "users", "green", data.definitions.activeUsers)}
        ${stat("New Users Today", num(m.newUsersToday), "users", "blue", "Registered since midnight UTC")}
        ${stat("Active VPNs", m.activeVpns == null ? num(m.trackedActiveVpns) + "*" : num(m.activeVpns), "globe", "green", m.activeVpns == null ? "*local tracked orders — panel status unavailable" : data.definitions.activeVpns)}
      </div>
      <div class="grid cols-4" style="margin-bottom:16px">
        ${stat("Revenue Today", money(m.revenue.today), "card", "green")}
        ${stat("Revenue This Week", money(m.revenue.week), "card", "green")}
        ${stat("Revenue This Month", money(m.revenue.month), "card", "green")}
        ${stat("Avg Order (month)", money(m.averageOrderValueMonth), "card")}
      </div>
      <div class="grid cols-4" style="margin-bottom:16px">
        ${stat("Orders", num(m.orders.total), "box", "", `Today: ${num(m.orders.today)} · Week: ${num(m.orders.week)}`)}
        ${stat("Pending Orders", num(m.pendingOrders), "clock", "yellow" + "" ? "" : "")}
        ${stat("Failed Payments", num(m.failedPayments), "alert", m.failedPayments ? "red" : "", `Rate: ${pct(m.failedPaymentRate)}`)}
        ${stat("Failed Provisioning", num(m.failedProvisioning), "alert", m.failedProvisioning ? "red" : "")}
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card chart-card">
          <div class="card-head"><h3>Revenue — last 30 days</h3><span class="sub">credited top-ups per day (Toman)</span></div>
          <div class="card-pad" id="chart-revenue">${lineChart(data.charts.revenue, { format: compact })}</div>
        </div>
        <div class="card chart-card">
          <div class="card-head"><h3>Orders — last 30 days</h3><span class="sub">orders created per day</span></div>
          <div class="card-pad">${lineChart(data.charts.orders, { color: "#8B5CF6", fill: false })}</div>
        </div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card chart-card">
          <div class="card-head"><h3>New users</h3><span class="sub">registrations per day</span></div>
          <div class="card-pad">${lineChart(data.charts.newUsers, { color: "#22C55E", fill: false })}</div>
        </div>
        <div class="card chart-card">
          <div class="card-head"><h3>VPN deliveries</h3><span class="sub">completed VPN orders per day</span></div>
          <div class="card-pad">${barChart(data.charts.popularPackages)}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>System health</h3><span class="sub">live dependency checks</span>
          <span class="spacer"></span>
          <button class="btn sm" id="health-refresh">${icon("refresh")} Re-check</button>
        </div>
        <div class="card-pad"><div class="health-grid" id="health-grid">${healthCards(data.__health)}</div></div>
      </div>`;

    $("#health-refresh").onclick = () => renderRoute(true);
    if (!data.__health) loadHealthInto("#health-grid");
  }

  const compact = (v) => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + "M" : v >= 1000 ? (v / 1000).toFixed(v >= 10_000 ? 0 : 1) + "k" : Math.round(v));

  function stat(label, value, ic, tone = "", foot = "") {
    return `<div class="stat ${tone ? `tone-${tone}` : ""}">
      <div class="label">${icon(ic)} ${esc(label)}</div>
      <div class="value">${value}</div>
      ${foot ? `<div class="foot">${esc(foot)}</div>` : ""}
    </div>`;
  }

  function errorBox(error) {
    return `<div class="card card-pad"><div class="danger-box">${icon("alert")} ${esc(error.message || "Could not load this page.")}</div>
      <div style="margin-top:12px"><button class="btn" onclick="window.dispatchEvent(new HashChangeEvent('hashchange'))">Try again</button></div></div>`;
  }

  function healthCards(services) {
    if (!services) return `<div class="empty">${icon("wrench")} Checking services…</div>`;
    return services.map((service) => `
      <div class="health ${service.status === "healthy" ? "" : service.status}">
        <div class="h-head">
          ${icon(service.name === "redis" ? "box" : service.name === "mongodb" ? "box" : service.name === "telegram" ? "send" : service.name === "wizardxray" ? "globe" : service.name === "hooshpay" ? "card" : service.name === "webhook" ? "inbox" : "wrench")}
          <span class="h-name">${esc(service.name)}</span>
          <span class="h-status">${pill(service.status)}</span>
        </div>
        <div class="h-rows">
          <div><span>Latency</span><span>${service.latencyMs != null ? service.latencyMs + " ms" : "—"}</span></div>
          <div><span>Last check</span><span>${dateFmt(service.lastCheckedAt)}</span></div>
          <div><span>Last success</span><span>${dateFmt(service.lastSuccessAt)}</span></div>
          <div><span>Last failure</span><span>${dateFmt(service.lastFailureAt)}</span></div>
          ${service.error ? `<div><span>Issue</span><span style="color:#FCA5A5">${esc(service.error)}</span></div>` : ""}
          ${service.lastErrorMessage && !service.error ? `<div><span>Last error</span><span>${esc(service.lastErrorMessage)}</span></div>` : ""}
        </div>
      </div>`).join("");
  }

  async function loadHealthInto(selector) {
    try {
      const data = (await GET("/system/health")).data;
      const el = $(selector);
      if (el) el.innerHTML = healthCards(data.services);
    } catch { /* dashboard already rendered placeholders */ }
  }

  // ── Users ──────────────────────────────────────────────────────────────────
  const usersQuery = { search: "", activity: "all", paying: "all", blocked: "all", sort: "registered", page: 1 };

  async function pageUsers() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <input id="u-search" class="input search" placeholder="Search Telegram ID, @username or name…" value="${esc(usersQuery.search)}" />
          <select id="u-activity" class="select">
            <option value="all">Activity: all</option>
            <option value="active">Active (30d)</option>
            <option value="inactive">Inactive (30d)</option>
          </select>
          <select id="u-paying" class="select">
            <option value="all">Paying: all</option>
            <option value="yes">Paying</option>
            <option value="no">Non-paying</option>
          </select>
          <select id="u-blocked" class="select">
            <option value="all">Status: all</option>
            <option value="no">Not blocked</option>
            <option value="yes">Blocked</option>
          </select>
          <select id="u-sort" class="select">
            <option value="registered">Sort: registration</option>
            <option value="spending">Sort: spending</option>
            <option value="activity">Sort: activity</option>
          </select>
        </div>
        <div id="users-table">${loading()}</div>
      </div>`;
    $("#u-activity").value = usersQuery.activity;
    $("#u-paying").value = usersQuery.paying;
    $("#u-blocked").value = usersQuery.blocked;
    $("#u-sort").value = usersQuery.sort;
    $("#u-search").oninput = debounce((event) => { usersQuery.search = event.target.value; usersQuery.page = 1; loadUsers(); }, 350);
    ["u-activity", "u-paying", "u-blocked", "u-sort"].forEach((id) => {
      $("#" + id).onchange = (event) => {
        const key = id.slice(2).replace("paying", "paying");
        usersQuery[{ "u-activity": "activity", "u-paying": "paying", "u-blocked": "blocked", "u-sort": "sort" }[id]] = event.target.value;
        usersQuery.page = 1;
        loadUsers();
      };
    });
    await loadUsers();
  }

  async function loadUsers() {
    const target = $("#users-table");
    if (!target) return;
    target.innerHTML = loading();
    const params = new URLSearchParams({ ...usersQuery, pageSize: 15 });
    let data;
    try { data = (await GET(`/users?${params}`)).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">${icon("users")} No users match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "users");
      bindPagers(); return;
    }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>User</th><th>Telegram ID</th><th class="num">Balance</th><th class="num">Total spent</th>
          <th class="num">Orders</th><th class="num">Services</th><th>Registered</th><th>Last activity</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${data.items.map((user) => `
            <tr data-user="${esc(user.telegramId)}">
              <td><strong>${esc(user.name || "—")}</strong>${user.username ? ` <span style="color:var(--text-faint)">@${esc(user.username)}</span>` : ""}</td>
              <td class="mono">${esc(user.telegramId)}</td>
              <td class="num">${money(user.balance)}</td>
              <td class="num">${money(user.totalSpent)}</td>
              <td class="num">${num(user.orderCount)}</td>
              <td class="num">${num(user.serviceCount)}</td>
              <td>${dateShort(user.createdAt)}</td>
              <td>${dateShort(user.lastActivityAt)}</td>
              <td>${pill(user.isBanned ? "blocked" : "active")}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "users")}`;
    PAGER_HANDLERS.users = (page) => { usersQuery.page = page; loadUsers(); };
    bindPagers();
    target.querySelectorAll("tr[data-user]").forEach((row) => {
      row.onclick = () => showUser(row.dataset.user);
    });
  }

  async function showUser(telegramId) {
    openDrawer("Loading user…", telegramId, loading());
    let data;
    try { data = (await GET(`/users/${encodeURIComponent(telegramId)}`)).data; }
    catch (error) { openDrawer("User", telegramId, errorBox(error)); return; }
    const user = data.user;
    const html = `
      <div>
        <div class="kv">
          <dt>Telegram ID</dt><dd class="mono">${esc(user.telegramId)}</dd>
          <dt>Username</dt><dd>${user.username ? "@" + esc(user.username) : "—"}</dd>
          <dt>Name</dt><dd>${esc(user.name || "—")}</dd>
          <dt>Registered</dt><dd>${dateFmt(user.createdAt)}</dd>
          <dt>Last activity</dt><dd>${dateFmt(user.lastActivityAt)}</dd>
          <dt>Balance</dt><dd><strong>${money(user.balance)}</strong></dd>
          <dt>Total spent</dt><dd>${money(data.totalSpent)}</dd>
          <dt>Orders</dt><dd>${num(data.orderCount)}</dd>
          <dt>Active VPNs</dt><dd>${num(data.activeVpns)}${data.untrackedServiceCount ? ` <span class="pill gray">+${data.untrackedServiceCount} untracked</span>` : ""}</dd>
          <dt>Expired VPNs</dt><dd>${num(data.expiredVpns)}</dd>
          <dt>Referrals</dt><dd>${num(data.referral.referralCount)} referred${data.referral.referredByTelegramId ? ` · referred by ${esc(data.referral.referredByTelegramId)}` : ""}${data.referral.trackingAvailable ? "" : " · not yet tracked"}</dd>
          ${user.isBanned ? `<dt>Blocked</dt><dd style="color:#FCA5A5">${dateFmt(data.blockedAt)}${data.blockReason ? ` — ${esc(data.blockReason)}` : ""}</dd>` : ""}
        </div>
      </div>
      <div>
        <div class="section-title">Admin actions</div>
        <div class="drawer-actions" style="margin-top:10px">
          <button class="btn success sm" data-act="add-balance">${icon("plus")} Add balance</button>
          <button class="btn danger sm" data-act="remove-balance">Remove balance</button>
          <button class="btn sm" data-act="refresh-user">${icon("refresh")} Refresh</button>
          ${user.isBanned
            ? `<button class="btn success sm" data-act="unblock">${icon("check")} Unblock</button>`
            : `<button class="btn danger sm" data-act="block">Block user</button>`}
        </div>
        <div class="warn-box" style="margin-top:10px">VPN extend / traffic / revoke actions live in <strong>VPN Services</strong> — open this user's services from there.</div>
      </div>
      <div>
        <div class="section-title">Payment history</div>
        ${data.payments.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>ID</th><th>Provider</th><th class="num">Amount</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>${data.payments.map((payment) => `
            <tr data-payment="${esc(payment.provider)}:${esc(payment.id)}">
              <td class="mono">${esc(String(payment.id).slice(0, 18))}…</td>
              <td>${esc(payment.provider)}</td>
              <td class="num">${money(payment.amount)}</td>
              <td>${pill(payment.status)}</td>
              <td>${dateShort(payment.createdAt)}</td>
            </tr>`).join("")}</tbody></table></div>` : `<div class="empty">No payments recorded.</div>`}
      </div>
      <div>
        <div class="section-title">Service history</div>
        ${data.services.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Service ID</th><th>Created</th><th>Expires</th><th>Status</th></tr></thead>
          <tbody>${data.services.map((service) => `
            <tr data-vpn="${esc(service.username)}">
              <td class="mono">${esc(service.username)}</td>
              <td>${dateShort(service.createdAt)}</td>
              <td>${dateShort(service.expiresAt)}</td>
              <td>${pill(service.revokedAt ? "revoked" : !service.expiresAt ? "unknown" : new Date(service.expiresAt) > new Date() ? "active" : "expired")}</td>
            </tr>`).join("")}</tbody></table></div>` : `<div class="empty">No services recorded.</div>`}
      </div>`;
    openDrawer(user.name || "User", `@${user.username || telegramId} · ${telegramId}`, html);

    $$("#drawer [data-payment]").forEach((row) => { row.onclick = () => showPayment(row.dataset.payment); });
    $$("#drawer [data-vpn]").forEach((row) => { row.onclick = () => showVpn(row.dataset.vpn); });
    $$("#drawer [data-act]").forEach((button) => {
      button.onclick = () => {
        const action = button.dataset.act;
        if (action === "refresh-user") return showUser(telegramId);
        if (action === "add-balance" || action === "remove-balance") return balanceModal(telegramId, action === "add-balance" ? "add" : "remove");
        if (action === "block") return blockModal(telegramId, true);
        if (action === "unblock") return blockModal(telegramId, false);
      };
    });
  }

  function balanceModal(telegramId, direction) {
    openModal({
      title: direction === "add" ? "Add balance" : "Remove balance",
      bodyHtml: `
        ${direction === "remove" ? `<div class="warn-box">The removal is rejected if the wallet holds less than the entered amount.</div>` : ""}
        ${fieldHtml("AMOUNT (TOMAN)", "amount", { type: "number", placeholder: "e.g. 50000" })}
        ${reasonField()}`,
      confirmText: direction === "add" ? "Add balance" : "Remove balance",
      danger: direction === "remove",
      onConfirm: async (values) => {
        try {
          const result = (await POST(`/users/${encodeURIComponent(telegramId)}/balance`, {
            operationId: newOperationId(), amount: values.amount, direction, reason: values.reason,
          })).data;
          toast("success", `Balance updated — new balance ${money(result.balance)}.`);
          closeModal(); showUser(telegramId);
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  function blockModal(telegramId, blocked) {
    openModal({
      title: blocked ? "Block user" : "Unblock user",
      bodyHtml: `
        ${blocked ? `<div class="danger-box">A blocked user can no longer use the bot. This action is audited and reversible.</div>` : `<div class="warn-box">The user will regain access to the bot.</div>`}
        ${reasonField("Shown in the audit log; for unblock it is optional.")}`,
      confirmText: blocked ? "Block user" : "Unblock user",
      danger: blocked,
      onConfirm: async (values) => {
        try {
          await POST(`/users/${encodeURIComponent(telegramId)}/${blocked ? "block" : "unblock"}`, {
            operationId: newOperationId(), reason: values.reason,
          });
          toast("success", blocked ? "User blocked." : "User unblocked.");
          closeModal(); showUser(telegramId); loadUsers();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  // ── VPNs ───────────────────────────────────────────────────────────────────
  const vpnQuery = { search: "", status: "all", sort: "created", page: 1 };

  async function pageVpns() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <input id="v-search" class="input search" placeholder="Search by user, Telegram ID or service/client ID…" value="${esc(vpnQuery.search)}" />
          <select id="v-status" class="select">
            <option value="all">Status: all</option>
            <option value="active">Active</option>
            <option value="expiring">Expiring ≤ 7 days</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
            <option value="unknown">Unknown expiry</option>
          </select>
          <select id="v-sort" class="select">
            <option value="created">Sort: newest</option>
            <option value="expiry">Sort: expiry (soonest)</option>
          </select>
        </div>
        <div id="vpns-table">${loading()}</div>
      </div>`;
    $("#v-status").value = vpnQuery.status;
    $("#v-sort").value = vpnQuery.sort === "expiry" ? "expiry" : "created";
    $("#v-search").oninput = debounce((event) => { vpnQuery.search = event.target.value; vpnQuery.page = 1; loadVpns(); }, 350);
    $("#v-status").onchange = (event) => { vpnQuery.status = event.target.value; vpnQuery.page = 1; loadVpns(); };
    $("#v-sort").onchange = (event) => { vpnQuery.sort = event.target.value; vpnQuery.page = 1; loadVpns(); };
    await loadVpns();
  }

  async function loadVpns() {
    const target = $("#vpns-table");
    if (!target) return;
    target.innerHTML = loading();
    const params = new URLSearchParams({ search: vpnQuery.search, status: vpnQuery.status, sort: vpnQuery.sort, page: vpnQuery.page, pageSize: 15 });
    let data;
    try { data = (await GET(`/vpns?${params}`)).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">${icon("globe")} No VPN services match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "vpns");
      bindPagers(); return;
    }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Service / Client ID</th><th>Owner</th><th>Product</th><th class="num">Traffic</th><th>Created</th><th>Expiry</th><th>Status</th></tr></thead>
        <tbody>
          ${data.items.map((vpn) => `
            <tr data-vpn="${esc(vpn.clientId)}">
              <td class="mono">${esc(vpn.clientId)}</td>
              <td>${esc(vpn.ownerName || vpn.username || "")} <span class="mono" style="color:var(--text-faint)">${esc(vpn.telegramId)}</span></td>
              <td>${esc(vpn.product || "—")}</td>
              <td class="num">${vpn.trafficGb != null ? num(vpn.trafficGb) + " GB" : "—"}</td>
              <td>${dateShort(vpn.createdAt)}</td>
              <td>${dateShort(vpn.expiresAt)}</td>
              <td>${pill(vpn.status)}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "vpns")}`;
    PAGER_HANDLERS.vpns = (page) => { vpnQuery.page = page; loadVpns(); };
    bindPagers();
    target.querySelectorAll("tr[data-vpn]").forEach((row) => { row.onclick = () => showVpn(row.dataset.vpn); });
  }

  async function showVpn(clientId) {
    openDrawer("Loading VPN…", clientId, loading());
    let data;
    try { data = (await GET(`/vpns/${encodeURIComponent(clientId)}`)).data; }
    catch (error) { openDrawer("VPN", clientId, errorBox(error)); return; }

    const actionButton = (action, label, tone, enabled, note) => `
      <button class="btn ${tone} sm" data-vpn-action="${action}" ${enabled ? "" : "disabled"}>${label}</button>${note ? `<div class="foot" style="color:var(--text-faint);font-size:11px;margin-top:4px">${esc(note)}</div>` : ""}`;

    const html = `
      <div>
        <div class="kv">
          <dt>Owner</dt><dd>${esc(data.user.name || "")} <span class="mono" style="color:var(--text-faint)">${esc(data.user.telegramId)}</span></dd>
          <dt>Client ID</dt><dd class="mono">${esc(data.clientId)}</dd>
          <dt>Product</dt><dd>${esc(data.product || "—")}</dd>
          <dt>Created</dt><dd>${dateFmt(data.createdAt)}</dd>
          <dt>Expiry (local)</dt><dd>${dateFmt(data.expiresAt)}</dd>
          <dt>Expiry (panel)</dt><dd>${esc(data.panelExpiry || "—")}</dd>
          <dt>Traffic limit</dt><dd>${data.trafficGb != null ? num(data.trafficGb) + " GB" : "—"}</dd>
          <dt>Traffic used</dt><dd>${esc(data.trafficUsed || "—")}</dd>
          <dt>Traffic left</dt><dd>${data.trafficRemainingGb != null ? num(data.trafficRemainingGb) + " GB" : "—"}</dd>
          <dt>WizardXray</dt><dd>${pill(data.wizardXray.status)} ${data.wizardXray.latencyMs != null ? `<span class="mono" style="color:var(--text-faint)">${data.wizardXray.latencyMs}ms</span>` : ""}${data.wizardXray.error ? `<div style="color:#FCA5A5;font-size:12px">${esc(data.wizardXray.error)}</div>` : ""}</dd>
        </div>
      </div>
      <div>
        <div class="section-title">Actions</div>
        <div class="drawer-actions" style="margin-top:10px">
          ${actionButton("change-link", "🔄 Change link", "", data.availableActions.changeLink)}
          ${actionButton("disable", "⛔ Disable", "danger", data.availableActions.disable)}
          ${actionButton("revoke", "🗑 Revoke permanently", "danger", data.availableActions.revoke)}
          ${actionButton("extend-time", "⏱ Extend time", "", false, data.unavailableActions.extendTime)}
          ${actionButton("increase-traffic", "📦 Increase traffic", "", false, data.unavailableActions.increaseTraffic)}
          ${actionButton("regenerate-config", "🔐 Regenerate config", "", false, data.unavailableActions.regenerateConfig)}
        </div>
        <div class="warn-box" style="margin-top:10px">Disabled actions are not supported by the configured WizardXray API client and are intentionally not faked.</div>
      </div>`;

    openDrawer("VPN Service", clientId, html);
    $$("#drawer [data-vpn-action]").forEach((button) => {
      if (button.disabled) return;
      button.onclick = () => vpnActionModal(data, button.dataset.vpnAction);
    });
  }

  function vpnActionModal(vpn, action) {
    const labels = {
      "change-link": { title: "Change subscription link", text: "WizardXray will issue a new subscription link for this service. The user's old link stops working.", confirm: "Change link", danger: false, reason: false },
      disable: { title: "Disable VPN service", text: "The service will be deactivated on WizardXray. It can be re-enabled later.", confirm: "Disable service", danger: true, reason: true },
      revoke: { title: "Revoke VPN service", text: "The service is permanently deleted from WizardXray and removed from the user's account. This cannot be undone.", confirm: "Revoke permanently", danger: true, reason: true },
    };
    const config = labels[action];
    if (!config) return;
    openModal({
      title: config.title,
      bodyHtml: `
        ${config.danger ? `<div class="danger-box">${esc(config.text)}</div>` : `<div class="warn-box">${esc(config.text)}</div>`}
        ${config.reason ? reasonField() : ""}`,
      confirmText: config.confirm,
      danger: config.danger,
      onConfirm: async (values) => {
        try {
          const result = (await POST(`/vpns/${encodeURIComponent(vpn.clientId)}/actions`, {
            operationId: newOperationId(), action, reason: values.reason,
          })).data;
          toast("success", `Action completed (${action}).`);
          closeModal(); showVpn(vpn.clientId); loadVpns();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  // ── Payments ───────────────────────────────────────────────────────────────
  const payQuery = { status: "all", search: "", page: 1 };

  async function pagePayments() {
    const statuses = ["all", "pending", "paid", "fulfilled", "failed", "cancelled", "refunded", "recovery-required"];
    $("#content").innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <div class="tabs">${statuses.map((status) => `<button class="tab ${payQuery.status === status ? "active" : ""}" data-pay-status="${status}">${status === "all" ? "All" : status.replace("-", " ")}</button>`).join("")}</div>
        </div>
        <div class="filter-bar">
          <input id="p-search" class="input search" placeholder="Search order ID, invoice UID, tracking code, Telegram ID…" value="${esc(payQuery.search)}" />
        </div>
        <div id="pay-table">${loading()}</div>
      </div>`;
    $$("#content [data-pay-status]").forEach((tab) => {
      tab.onclick = () => { payQuery.status = tab.dataset.payStatus; payQuery.page = 1; pagePayments(); };
    });
    $("#p-search").oninput = debounce((event) => { payQuery.search = event.target.value; payQuery.page = 1; loadPayments(); }, 350);
    await loadPayments();
  }

  async function loadPayments() {
    const target = $("#pay-table");
    if (!target) return;
    target.innerHTML = loading();
    const params = new URLSearchParams({ status: payQuery.status, search: payQuery.search, page: payQuery.page, pageSize: 15 });
    let data;
    try { data = (await GET(`/payments?${params}`)).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">${icon("card")} No payments match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "payments");
      bindPagers(); return;
    }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Order / Invoice</th><th>Provider</th><th>User</th><th class="num">Amount</th><th>Product</th><th>Tracking</th><th>Created</th><th>Status</th></tr></thead>
        <tbody>
          ${data.items.map((payment) => `
            <tr data-payment="${esc(payment.key)}">
              <td class="mono">${esc(String(payment.id).slice(0, 22))}</td>
              <td>${esc(payment.providerLabel)}${payment.type === "order" ? ` <span class="pill blue">order</span>` : ""}</td>
              <td class="mono">${esc(payment.userId)}</td>
              <td class="num">${money(payment.amount)}</td>
              <td>${esc(payment.product)}</td>
              <td class="mono">${payment.trackingCode ? esc(String(payment.trackingCode).slice(0, 12)) + "…" : "—"}</td>
              <td>${dateShort(payment.createdAt)}</td>
              <td>${pill(payment.status)}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "payments")}`;
    PAGER_HANDLERS.payments = (page) => { payQuery.page = page; loadPayments(); };
    bindPagers();
    target.querySelectorAll("tr[data-payment]").forEach((row) => { row.onclick = () => showPayment(row.dataset.payment); });
  }

  async function showPayment(key) {
    openDrawer("Loading payment…", key, loading());
    let data;
    try { data = (await GET(`/payments/${encodeURIComponent(key)}`)).data; }
    catch (error) { openDrawer("Payment", key, errorBox(error)); return; }

    const timelineClass = { done: "", success: "success", warning: "warning", pending: "pending" };
    const html = `
      <div>
        <div class="kv">
          <dt>Order / Invoice</dt><dd class="mono">${esc(data.id)}</dd>
          <dt>Provider</dt><dd>${esc(data.providerLabel)}${data.type === "order" ? " (VPN order)" : " (wallet top-up)"}</dd>
          <dt>User</dt><dd class="mono">${esc(data.userId)}</dd>
          <dt>Amount</dt><dd><strong>${money(data.amount)}</strong></dd>
          <dt>Product</dt><dd>${esc(data.product)}</dd>
          <dt>Tracking code</dt><dd class="mono">${esc(data.trackingCode || "—")}</dd>
          <dt>Created</dt><dd>${dateFmt(data.createdAt)}</dd>
          <dt>Paid at</dt><dd>${dateFmt(data.paidAt)}</dd>
          <dt>Fulfilled at</dt><dd>${dateFmt(data.fulfilledAt)}</dd>
          <dt>Status</dt><dd>${pill(data.status)} <span style="color:var(--text-faint);font-size:11.5px">raw: ${esc(data.rawStatus)}</span></dd>
          <dt>Retries</dt><dd>${num(data.retryCount)}${data.lastRetryAt ? ` · last ${dateFmt(data.lastRetryAt)}` : ""}${data.nextRetryAt ? ` · next ${dateFmt(data.nextRetryAt)}` : ""}</dd>
          ${data.lastError ? `<dt>Last error</dt><dd style="color:#FCA5A5">${esc(data.lastError)}</dd>` : ""}
          ${data.purchase ? `<dt>Service</dt><dd class="mono">${esc(data.purchase.serviceUsername || "—")}</dd><dt>Plan</dt><dd>${esc(data.purchase.product || "—")} · ${num(data.purchase.trafficGb)} GB · ${num(data.purchase.durationDays)}d</dd>` : ""}
        </div>
      </div>
      <div>
        <div class="section-title">Timeline</div>
        <ul class="timeline" style="margin-top:10px">
          ${data.timeline.map((event) => `
            <li class="${timelineClass[event.status] || ""}">
              <div class="t-title">${esc(event.name)}</div>
              <div class="t-meta">${dateFmt(event.at)}${event.detail ? ` · ${esc(event.detail)}` : ""}</div>
            </li>`).join("") || `<div class="empty">No events recorded.</div>`}
        </ul>
      </div>
      ${data.webhookEvents.length ? `
      <div>
        <div class="section-title">Webhook events</div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Received</th><th>Event</th><th>Status</th><th class="num">Amount</th></tr></thead>
          <tbody>${data.webhookEvents.map((event) => `
            <tr><td>${dateFmt(event.receivedAt)}</td><td>${esc(event.event || "—")}</td><td>${esc(event.status || "—")}</td><td class="num">${event.amount != null ? money(event.amount) : "—"}</td></tr>`).join("")}
          </tbody></table></div>
      </div>` : ""}
      <div>
        <div class="section-title">Admin actions</div>
        <div class="drawer-actions" style="margin-top:10px">
          ${data.actions.retryVerification ? `<button class="btn sm" data-pay-action="retry">${icon("refresh")} Retry verification</button>` : ""}
          ${data.actions.retryFulfillment ? `<button class="btn success sm" data-pay-action="retry">${icon("refresh")} Retry fulfillment</button>` : ""}
          ${data.actions.manualResolve ? `<button class="btn sm" data-pay-action="resolve">${icon("check")} Manual resolve…</button>` : ""}
          ${data.status === "recovery-required" ? `<button class="btn danger sm" data-pay-action="mark">${icon("alert")} Mark recovery-required</button>` : ""}
          <button class="btn ghost sm" data-pay-action="refresh">${icon("refresh")} Refresh</button>
        </div>
        <div class="warn-box" style="margin-top:10px">All retries go through the idempotent fulfillment paths — a paid order can never be credited or provisioned twice.</div>
      </div>`;
    openDrawer("Payment", `${data.providerLabel} · ${money(data.amount)}`, html);

    $$("#drawer [data-pay-action]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.payAction;
        if (action === "refresh") return showPayment(key);
        if (action === "retry") return paymentRetryModal(key);
        if (action === "mark") return paymentMarkModal(key);
        if (action === "resolve") return paymentResolveModal(key);
      };
    });
  }

  function paymentRetryModal(key) {
    openModal({
      title: "Retry payment processing",
      bodyHtml: `<div class="warn-box">The retry re-runs the existing idempotent verification/fulfillment path. Duplicate webhooks and double-clicks are safe by design.</div>`,
      confirmText: "Retry now",
      onConfirm: async () => {
        try {
          const result = (await POST(`/payments/${encodeURIComponent(key)}/retry`, { operationId: newOperationId() })).data;
          toast("success", `Retry result: ${result.status || "ok"}.`);
          closeModal(); showPayment(key); loadPayments();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  function paymentMarkModal(key) {
    openModal({
      title: "Mark recovery-required",
      bodyHtml: reasonField("Explain why this payment needs manual recovery."),
      confirmText: "Mark recovery-required",
      danger: true,
      onConfirm: async (values) => {
        try {
          await POST(`/payments/${encodeURIComponent(key)}/recovery-required`, { operationId: newOperationId(), reason: values.reason });
          toast("success", "Payment flagged for recovery.");
          closeModal(); showPayment(key); loadPayments(); refreshRecoveryBadge();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  function paymentResolveModal(key) {
    openModal({
      title: "Manual resolve",
      bodyHtml: `
        <div class="warn-box">Record how this payment was settled out-of-band (e.g. refunded manually, provisioned manually, or false alarm). This does <strong>not</strong> move money or create VPNs — use the dedicated actions for that.</div>
        ${fieldHtml("RESOLUTION NOTE", "reason", { placeholder: "e.g. refunded via bank on 2026-10-03, txn #123" })}`,
      confirmText: "Resolve",
      onConfirm: async (values) => {
        try {
          await POST(`/payments/${encodeURIComponent(key)}/resolve`, { operationId: newOperationId(), reason: values.reason });
          toast("success", "Recovery resolved and recorded in the audit log.");
          closeModal(); showPayment(key); loadPayments(); refreshRecoveryBadge();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  // ── Recovery ───────────────────────────────────────────────────────────────
  async function pageRecovery() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Recovery queue</h3><span class="sub">paid-but-unfulfilled · failed provisioning · webhook failures · manual review</span>
          <span class="spacer"></span>
          <button class="btn primary sm" id="retry-safe">${icon("refresh")} Retry all safe</button>
        </div>
        <div id="recovery-body">${loading()}</div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>How recovery stays safe</h3></div>
        <div class="card-pad" style="color:var(--text-dim);font-size:13px;line-height:1.7">
          Every retry uses the same atomic two-phase MongoDB writes as the payment pipeline: a paid invoice is credited exactly once,
          a provisioned VPN order is committed exactly once, and <strong>ambiguous WizardXray create requests are never replayed</strong> —
          they stay in manual review so a second service cannot be created for one payment.
        </div>
      </div>`;
    $("#retry-safe").onclick = retryAllSafe;
    await loadRecovery();
  }

  async function loadRecovery() {
    const target = $("#recovery-body");
    if (!target) return;
    let data;
    try { data = (await GET("/recovery?pageSize=25")).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">${icon("check")} Nothing needs recovery. All payments and orders are settled.</div>`;
      return;
    }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Item</th><th>Provider</th><th>Issue</th><th>User</th><th class="num">Amount</th><th class="num">Retries</th><th>Last error</th><th>Next retry</th><th></th></tr></thead>
        <tbody>
          ${data.items.map((item) => `
            <tr>
              <td class="mono" style="cursor:pointer" data-payment="${esc(item.key)}">${esc(String(item.key).slice(0, 24))}</td>
              <td>${esc(item.provider)}</td>
              <td><span class="pill ${item.retrySafe ? "yellow" : "red"}">${esc(item.kind)}</span></td>
              <td class="mono">${esc(item.userId)}</td>
              <td class="num">${money(item.amount)}</td>
              <td class="num">${num(item.retryCount)}</td>
              <td style="color:#FCA5A5">${esc(item.lastError || "—")}</td>
              <td>${dateFmt(item.nextRetryAt)}</td>
              <td>${item.retrySafe ? `<button class="btn sm" data-retry-key="${esc(item.key)}">${icon("refresh")} Retry</button>` : `<button class="btn ghost sm" data-resolve-key="${esc(item.key)}">Resolve…</button>`}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "recovery")}`;
    PAGER_HANDLERS.recovery = () => loadRecovery();
    bindPagers();
    target.querySelectorAll("[data-payment]").forEach((el) => { el.onclick = () => showPayment(el.dataset.payment); });
    target.querySelectorAll("[data-retry-key]").forEach((button) => {
      button.onclick = async () => {
        const key = button.dataset.retryKey;
        try {
          const result = (await POST("/recovery/retry-safe", { operationId: newOperationId(), keys: [key] })).data;
          toast(result.succeeded ? "success" : "error", result.succeeded ? "Retry completed." : `Retry failed: ${result.failed?.[0]?.code || "unknown"}`);
          loadRecovery();
        } catch (error) { toast("error", error.message); }
      };
    });
    target.querySelectorAll("[data-resolve-key]").forEach((button) => {
      button.onclick = () => paymentResolveModal(button.dataset.resolveKey);
    });
  }

  async function retryAllSafe() {
    openModal({
      title: "Retry all safe items",
      bodyHtml: `<div class="warn-box">This retries up to 25 safe recovery items (paid-not-credited fulfillments and pending commits). Ambiguous provisioning stays untouched.</div>`,
      confirmText: "Run safe retries",
      onConfirm: async () => {
        try {
          const result = (await POST("/recovery/retry-safe", { operationId: newOperationId() })).data;
          toast(result.succeeded === result.attempted ? "success" : "info", `Retried ${result.attempted}: ${result.succeeded} succeeded, ${result.failed.length} failed.`);
          closeModal(); loadRecovery(); refreshRecoveryBadge();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  // ── Products ───────────────────────────────────────────────────────────────
  async function pageProducts() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>Product catalog</h3><span class="sub">shared by the Telegram shop and this panel</span>
          <span class="spacer"></span>
          <button class="btn primary sm" id="product-new">${icon("plus")} New product</button>
        </div>
        <div id="products-body">${loading()}</div>
      </div>`;
    $("#product-new").onclick = () => productModal(null);
    await loadProducts();
  }

  async function loadProducts() {
    const target = $("#products-body");
    if (!target) return;
    let products;
    try { products = (await GET("/products")).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!products.length) { target.innerHTML = `<div class="empty">${icon("box")} No products yet. The default plans are seeded automatically on the next bot start.</div>`; return; }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Order</th><th>Name</th><th class="num">Duration</th><th class="num">Traffic</th><th class="num">Price</th><th class="num">Cost</th><th class="num">Profit</th><th>Enabled</th><th></th></tr></thead>
        <tbody>
          ${products.map((product, index) => `
            <tr data-product="${esc(product.id)}">
              <td style="color:var(--text-faint)">${index + 1}</td>
              <td><strong>${esc(product.name)}</strong><div class="mono" style="color:var(--text-faint);font-size:11px">${esc(product.id)}</div></td>
              <td class="num">${num(product.durationDays)} d</td>
              <td class="num">${num(product.trafficGb)} GB</td>
              <td class="num">${money(product.priceToman)}</td>
              <td class="num">${money(product.costToman)}</td>
              <td class="num" style="color:${product.profitToman >= 0 ? "var(--green)" : "var(--red)"}">${money(product.profitToman)}</td>
              <td><label class="switch"><input type="checkbox" data-toggle="${esc(product.id)}" ${product.enabled ? "checked" : ""}/><span class="track"></span></label></td>
              <td>
                <button class="btn ghost sm" data-move="up" data-id="${esc(product.id)}" ${index === 0 ? "disabled" : ""}>↑</button>
                <button class="btn ghost sm" data-move="down" data-id="${esc(product.id)}" ${index === products.length - 1 ? "disabled" : ""}>↓</button>
                <button class="btn sm" data-edit="${esc(product.id)}">Edit</button>
                <button class="btn ghost sm" data-duplicate="${esc(product.id)}">Duplicate</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table></div>`;
    target.querySelectorAll("[data-edit]").forEach((button) => {
      button.onclick = () => productModal(products.find((p) => p.id === button.dataset.edit));
    });
    target.querySelectorAll("[data-duplicate]").forEach((button) => {
      button.onclick = async () => {
        try {
          await POST(`/products/${encodeURIComponent(button.dataset.duplicate)}/duplicate`, { operationId: newOperationId() });
          toast("success", "Product duplicated (created disabled).");
          loadProducts();
        } catch (error) { toast("error", error.message); }
      };
    });
    target.querySelectorAll("[data-toggle]").forEach((input) => {
      input.onchange = async () => {
        try {
          await PATCH(`/products/${encodeURIComponent(input.dataset.toggle)}`, { operationId: newOperationId(), enabled: input.checked });
          toast("success", input.checked ? "Product enabled — live in the Telegram shop." : "Product disabled.");
          loadProducts();
        } catch (error) { toast("error", error.message); input.checked = !input.checked; }
      };
    });
    target.querySelectorAll("[data-move]").forEach((button) => {
      button.onclick = async () => {
        const ids = products.map((p) => p.id);
        const index = ids.indexOf(button.dataset.id);
        const target2 = button.dataset.move === "up" ? index - 1 : index + 1;
        if (target2 < 0 || target2 >= ids.length) return;
        [ids[index], ids[target2]] = [ids[target2], ids[index]];
        try {
          await POST("/products/reorder", { operationId: newOperationId(), productIds: ids });
          loadProducts();
        } catch (error) { toast("error", error.message); }
      };
    });
  }

  function productModal(product) {
    const isNew = !product;
    openModal({
      title: isNew ? "New product" : `Edit — ${product.name}`,
      bodyHtml: `
        ${fieldHtml("NAME", "name", { value: product?.name || "", placeholder: "🔹 50 GB · 60 days" })}
        <div class="field-row">
          ${fieldHtml("DURATION (DAYS)", "durationDays", { type: "number", value: product?.durationDays ?? 30 })}
          ${fieldHtml("TRAFFIC (GB)", "trafficGb", { type: "number", value: product?.trafficGb ?? 50 })}
        </div>
        <div class="field-row">
          ${fieldHtml("PRICE (TOMAN)", "priceToman", { type: "number", value: product?.priceToman ?? "" })}
          ${fieldHtml("COST (TOMAN)", "costToman", { type: "number", value: product?.costToman ?? 0 })}
        </div>
        <div class="field-row">
          ${fieldHtml("DISPLAY ORDER", "displayOrder", { type: "number", value: product?.displayOrder ?? 0 })}
          <label class="field">
            <span class="field-label">ENABLED</span>
            <label class="switch" style="margin-top:6px"><input type="checkbox" data-field="enabled" ${product?.enabled !== false ? "checked" : ""}/><span class="track"></span></label>
          </label>
        </div>
        ${isNew ? `<div class="warn-box">Catalog entries power the product mix &amp; profit analytics. The Telegram shop still sells the built-in plan list — driving it from this catalog is a planned follow-up (see README §12.5).</div>` : ""}`,
      confirmText: isNew ? "Create product" : "Save changes",
      onConfirm: async (values) => {
        const body = {
          operationId: newOperationId(),
          name: values.name,
          durationDays: values.durationDays,
          trafficGb: values.trafficGb,
          priceToman: values.priceToman,
          costToman: values.costToman,
          displayOrder: values.displayOrder || 0,
          enabled: $("#modal-body [data-field='enabled']").checked,
        };
        try {
          if (isNew) await POST("/products", body);
          else await PATCH(`/products/${encodeURIComponent(product.id)}`, body);
          toast("success", isNew ? "Product created." : "Product updated.");
          closeModal(); loadProducts();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────
  let broadcastTimer = null;

  async function pageBroadcast() {
    $("#content").innerHTML = `
      <div class="broadcast-layout">
        <div class="card">
          <div class="card-head"><h3>Compose broadcast</h3><span class="sub">sent by the bot as direct messages</span></div>
          <div class="card-pad" style="display:flex;flex-direction:column;gap:13px">
            <label class="field">
              <span class="field-label">MESSAGE</span>
              <textarea id="b-message" class="input" rows="7" maxlength="4096" placeholder="Write the announcement your users will receive…"></textarea>
            </label>
            <label class="field">
              <span class="field-label">AUDIENCE</span>
              <select id="b-audience" class="select">
                <option value="all">All users</option>
                <option value="active">Active users (seen in last 30 days)</option>
                <option value="expired">Users with no active VPN</option>
                <option value="paying">Paying users</option>
                <option value="custom">Custom selection…</option>
              </select>
            </label>
            <div id="b-custom-wrap" style="display:none">
              <label class="field">
                <span class="field-label">TELEGRAM IDS (COMMA/NEWLINE SEPARATED)</span>
                <textarea id="b-custom" class="input mono" rows="3" placeholder="111111111, 222222222"></textarea>
              </label>
            </div>
            <div class="field-row">
              <label class="field">
                <span class="field-label">BUTTON TEXT (OPTIONAL)</span>
                <input id="b-btn-text" class="input" placeholder="e.g. Buy now" maxlength="64" />
              </label>
              <label class="field">
                <span class="field-label">BUTTON t.me LINK (OPTIONAL)</span>
                <input id="b-btn-url" class="input mono" placeholder="https://t.me/…" />
              </label>
            </div>
            <div style="display:flex;gap:10px;align-items:center">
              <button class="btn primary" id="b-send">${icon("send")} Send broadcast</button>
              <span style="color:var(--text-faint);font-size:12px" id="b-count"></span>
            </div>
            <div class="warn-box">Delivery is rate-limited (~25 messages/second batched) and can be cancelled while running. Blocked users are marked automatically.</div>
          </div>
        </div>
        <div>
          <div class="tg-preview">
            <div class="tg-bar">
              <div class="tg-avatar">S</div>
              <div><div class="tg-name">SWIFT VPN Bot</div><div class="tg-sub">bot · online</div></div>
            </div>
            <div class="tg-msg" id="b-preview-msg">Your message preview appears here…</div>
            <div class="tg-time" id="b-preview-time"></div>
            <div class="tg-buttons" id="b-preview-buttons" style="display:none"><div class="tg-btn-sim" id="b-preview-btn"></div></div>
          </div>
          <div id="b-progress" style="display:none;margin-top:14px" class="card card-pad">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:8px">
              <span id="b-progress-label">Sending…</span><span id="b-progress-nums"></span>
            </div>
            <div class="progressbar"><div id="b-progress-bar" style="width:0%"></div></div>
            <button class="btn danger sm" id="b-cancel" style="margin-top:12px">Cancel broadcast</button>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>Recent broadcasts</h3></div>
        <div id="b-history">${loading()}</div>
      </div>`;

    const messageInput = $("#b-message");
    messageInput.oninput = () => updatePreview();
    $("#b-btn-text").oninput = () => updatePreview();
    $("#b-btn-url").oninput = () => updatePreview();
    $("#b-audience").onchange = (event) => {
      $("#b-custom-wrap").style.display = event.target.value === "custom" ? "" : "none";
    };
    $("#b-send").onclick = sendBroadcast;
    await loadBroadcastHistory();
    updatePreview();
  }

  function updatePreview() {
    const text = $("#b-message")?.value || "";
    const btnText = $("#b-btn-text")?.value || "";
    const btnUrl = $("#b-btn-url")?.value || "";
    $("#b-preview-msg").textContent = text || "Your message preview appears here…";
    $("#b-preview-time").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const buttonsWrap = $("#b-preview-buttons");
    if (btnText) {
      buttonsWrap.style.display = "";
      $("#b-preview-btn").textContent = btnText;
    } else buttonsWrap.style.display = "none";
    const counter = $("#b-count");
    if (counter) counter.textContent = `${text.length}/4096 characters · ${text.split(/\n/).length} lines`;
  }

  async function sendBroadcast() {
    const message = $("#b-message").value.trim();
    const audience = $("#b-audience").value;
    const btnText = $("#b-btn-text").value.trim();
    const btnUrl = $("#b-btn-url").value.trim();
    const customTelegramIds = audience === "custom"
      ? $("#b-custom").value.split(/[\n,]+/).map((id) => id.trim()).filter(Boolean)
      : undefined;
    if (!message) return toast("error", "Write a message first.");

    try {
      const preview = (await POST("/broadcast/preview", { message, buttons: btnText ? [{ text: btnText, url: btnUrl }] : [] })).data;
      if (preview.validationErrors?.length) return toast("error", preview.validationErrors[0]);
    } catch (error) { return toast("error", error.message); }

    openModal({
      title: "Confirm broadcast",
      bodyHtml: `
        <div class="warn-box">The bot will deliver this message to the selected audience. Delivery is rate-limited and can be cancelled.</div>
        <div class="kv">
          <dt>Audience</dt><dd>${esc(audience)}</dd>
          <dt>Characters</dt><dd>${num(message.length)}</dd>
          <dt>Button</dt><dd>${btnText ? `${esc(btnText)} → ${esc(btnUrl)}` : "none"}</dd>
        </div>
        ${reasonField("Recorded with the broadcast in the audit log.")}`,
      confirmText: "Send broadcast",
      onConfirm: async (values) => {
        try {
          const result = (await POST("/broadcast", {
            operationId: newOperationId(),
            message: message + (values.reason ? "" : ""),
            audience,
            customTelegramIds,
            buttons: btnText ? [{ text: btnText, url: btnUrl }] : [],
          })).data;
          closeModal();
          toast("success", `Broadcast started for ${num(result.broadcast?.total ?? 0)} recipients.`);
          trackBroadcast(result.broadcast?.operationId);
          loadBroadcastHistory();
        } catch (error) { toast("error", error.message); }
      },
    });
  }

  function trackBroadcast(operationId) {
    if (!operationId) return;
    $("#b-progress").style.display = "";
    clearInterval(broadcastTimer);
    broadcastTimer = setInterval(async () => {
      try {
        const status = (await GET(`/broadcast/status/${encodeURIComponent(operationId)}`)).data;
        const percent = status.total ? Math.round((status.processed / status.total) * 100) : 0;
        $("#b-progress-bar").style.width = percent + "%";
        $("#b-progress-label").textContent = status.status === "cancel_requested" ? "Cancelling…" : `Sending… (${status.status})`;
        $("#b-progress-nums").textContent = `${num(status.processed)}/${num(status.total)} · ✅ ${num(status.succeeded)} · ❌ ${num(status.failed)}`;
        if (["completed", "cancelled", "failed"].includes(status.status)) {
          clearInterval(broadcastTimer);
          $("#b-progress-label").textContent = `Finished — ${status.status}`;
          loadBroadcastHistory();
          refreshRecoveryBadge();
        }
      } catch { clearInterval(broadcastTimer); }
    }, 1500);
    $("#b-cancel").onclick = async () => {
      try {
        await POST(`/broadcast/cancel/${encodeURIComponent(operationId)}`, {});
        toast("info", "Cancellation requested — sending stops after the current batch.");
      } catch (error) { toast("error", error.message); }
    };
  }

  async function loadBroadcastHistory() {
    const target = $("#b-history");
    if (!target) return;
    let data;
    try { data = (await GET("/broadcasts?pageSize=8")).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!data.items.length) { target.innerHTML = `<div class="empty">${icon("megaphone")} No broadcasts sent yet.</div>`; return; }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Created</th><th>Audience</th><th>Status</th><th class="num">Sent</th><th class="num">Failed</th><th class="num">Total</th><th></th></tr></thead>
        <tbody>${data.items.map((item) => `
          <tr>
            <td>${dateFmt(item.createdAt)}</td>
            <td>${esc(item.audience)}</td>
            <td>${pill(item.status === "completed" ? "fulfilled" : item.status === "failed" ? "failed" : item.status === "cancelled" ? "cancelled" : "pending")}</td>
            <td class="num">${num(item.succeeded)}</td>
            <td class="num">${num(item.failed)}</td>
            <td class="num">${num(item.total)}</td>
            <td>${["queued", "running", "cancel_requested"].includes(item.status) ? `<button class="btn ghost sm" data-track="${esc(item.operationId)}">Watch</button>` : ""}</td>
          </tr>`).join("")}
        </tbody></table></div>`;
    target.querySelectorAll("[data-track]").forEach((button) => {
      button.onclick = () => trackBroadcast(button.dataset.track);
    });
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  let analyticsGranularity = "monthly";

  async function pageAnalytics() {
    $("#content").innerHTML = `
      <div class="filter-bar" style="border-radius:var(--radius-lg) var(--radius-lg) 0 0;background:var(--bg-elev);border:1px solid var(--border);border-bottom:none">
        <div class="tabs">
          ${["daily", "weekly", "monthly"].map((granularity) => `<button class="tab ${analyticsGranularity === granularity ? "active" : ""}" data-gran="${granularity}">${granularity}</button>`).join("")}
        </div>
      </div>
      <div id="analytics-body" style="background:var(--bg-elev);border:1px solid var(--border);border-top:none;border-radius:0 0 var(--radius-lg) var(--radius-lg)">${loading()}</div>`;
    $$("#content [data-gran]").forEach((tab) => {
      tab.onclick = () => { analyticsGranularity = tab.dataset.gran; pageAnalytics(); };
    });
    let data;
    try { data = (await GET(`/analytics?granularity=${analyticsGranularity}`)).data; }
    catch (error) { $("#analytics-body").innerHTML = errorBox(error); return; }
    const m = data.metrics;
    $("#analytics-body").innerHTML = `
      <div style="padding:16px 16px 0">
        <div class="grid cols-4">
          ${stat("Revenue (month)", money(m.revenue.month), "card", "green")}
          ${stat("Orders (completed)", num(m.orders.completed), "box")}
          ${stat("Conversion rate", pct(m.conversionRate), "users", "blue", data.definitions.conversionRate)}
          ${stat("Avg top-up (month)", money(m.averageTopUpValueMonth), "card")}
        </div>
        <div class="grid cols-4" style="margin-top:14px">
          ${stat("Users total", num(m.users.total), "users")}
          ${stat("Active users (30d)", num(m.users.active), "users", "green")}
          ${stat("Paying users", num(m.users.paying), "users", "blue")}
          ${stat("Active VPNs (tracked)", num(m.vpns.activeTracked), "globe")}
        </div>
        <div class="grid cols-4" style="margin-top:14px;margin-bottom:14px">
          ${stat("Failed payment rate", pct(m.failedPaymentRate), "alert", m.failedPaymentRate > 0.1 ? "red" : "", data.definitions.failedPaymentRate)}
          ${stat("Failed provisioning rate", pct(m.failedProvisioningRate), "alert", m.failedProvisioningRate > 0.05 ? "red" : "", data.definitions.failedProvisioningRate)}
          ${stat("Expired VPNs (tracked)", num(m.vpns.expiredTracked), "clock", "yellow")}
          ${stat("Revenue today", money(m.revenue.today), "card", "green")}
        </div>
        <div class="card chart-card">
          <div class="card-head"><h3>Revenue trend (${data.granularity})</h3>
            <span class="sub">HooshPay + TRX + bank · ${Object.entries(m.revenue.byProviderMonth).map(([provider, amount]) => `${provider}: ${money(amount)}`).join(" · ")}</span>
          </div>
          <div class="card-pad">${lineChart(data.series.map((row) => ({ date: row.date, value: row.revenue })), { format: compact })}</div>
        </div>
        <div class="grid cols-2" style="margin-top:14px">
          <div class="card chart-card">
            <div class="card-head"><h3>Popular products</h3><span class="sub">all-time completed orders</span></div>
            <div class="card-pad">${barChart(data.popularProducts)}</div>
          </div>
          <div class="card">
            <div class="card-head"><h3>Top spenders</h3></div>
            <div class="table-wrap"><table class="data">
              <thead><tr><th>User</th><th class="num">Orders</th><th class="num">Total spent</th></tr></thead>
              <tbody>${data.topSpenders.map((spender) => `
                <tr data-user="${esc(spender.telegramId)}"><td class="mono">${esc(spender.telegramId)}</td><td class="num">${num(spender.orderCount)}</td><td class="num">${money(spender.totalSpent)}</td></tr>`).join("")}
              </tbody></table></div>
          </div>
        </div>
        <div class="card" style="margin:14px 0 16px">
          <div class="card-head"><h3>Product margins</h3><span class="sub">${esc(data.definitions.estimatedProfit)}</span></div>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Product</th><th class="num">Orders</th><th class="num">Revenue</th><th class="num">Est. cost</th><th class="num">Est. profit</th></tr></thead>
            <tbody>${data.popularProducts.map((product) => `
              <tr><td>${esc(product.name || product.productId)}</td><td class="num">${num(product.count)}</td><td class="num">${money(product.revenue)}</td>
              <td class="num">${product.estimatedCost == null ? "—" : money(product.estimatedCost)}</td>
              <td class="num" style="color:${product.estimatedProfit == null ? "" : product.estimatedProfit >= 0 ? "var(--green)" : "var(--red)"}">${product.estimatedProfit == null ? "—" : money(product.estimatedProfit)}</td></tr>`).join("")}
            </tbody></table></div>
        </div>
      </div>`;
    $("#analytics-body").querySelectorAll("[data-user]").forEach((row) => {
      row.onclick = () => showUser(row.dataset.user);
    });
  }

  // ── Referrals ──────────────────────────────────────────────────────────────
  async function pageReferrals() {
    $("#content").innerHTML = `<div class="card"><div class="card-head"><h3>Referrals</h3></div><div id="ref-body" class="card-pad">${loading()}</div></div>`;
    let data;
    try { data = (await GET("/referrals")).data; }
    catch (error) { $("#ref-body").innerHTML = errorBox(error); return; }
    if (!data.trackingAvailable) {
      $("#ref-body").innerHTML = `<div class="empty">${icon("gift")} No referral records yet.<div style="margin-top:8px;font-size:12px">Referral codes are issued as users start using the updated bot; historical accounts show up as soon as they interact.</div></div>`;
      return;
    }
    $("#ref-body").innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>User</th><th>Referral code</th><th>Referred by</th><th>Registered</th></tr></thead>
        <tbody>${data.items.map((item) => `
          <tr><td class="mono" style="cursor:pointer" data-user="${esc(item.telegramId)}">${esc(item.telegramId)}</td>
          <td class="mono">${esc(item.referralCode || "—")}</td>
          <td class="mono">${esc(item.referredByTelegramId || "—")}</td>
          <td>${dateFmt(item.createdAt)}</td></tr>`).join("")}
        </tbody></table></div>
      ${pagerHtml(data.page, Math.ceil(data.total / data.pageSize), data.total, "ref")}`;
    PAGER_HANDLERS.ref = () => pageReferrals();
    bindPagers();
    $("#ref-body").querySelectorAll("[data-user]").forEach((row) => { row.onclick = () => showUser(row.dataset.user); });
  }

  // ── Audit ──────────────────────────────────────────────────────────────────
  const auditQuery = { action: "", actor: "", page: 1 };

  async function pageAudit() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <input id="a-action" class="input" placeholder="Filter action e.g. USER_BLOCKED" value="${esc(auditQuery.action)}" />
          <input id="a-actor" class="input mono" placeholder="Actor Telegram ID" value="${esc(auditQuery.actor)}" />
        </div>
        <div id="audit-body">${loading()}</div>
      </div>`;
    $("#a-action").oninput = debounce((event) => { auditQuery.action = event.target.value.trim().toUpperCase(); auditQuery.page = 1; loadAudit(); }, 350);
    $("#a-actor").oninput = debounce((event) => { auditQuery.actor = event.target.value.trim(); auditQuery.page = 1; loadAudit(); }, 350);
    await loadAudit();
  }

  async function loadAudit() {
    const target = $("#audit-body");
    if (!target) return;
    const params = new URLSearchParams({ page: auditQuery.page, pageSize: 20 });
    if (auditQuery.action) params.set("action", auditQuery.action);
    if (auditQuery.actor) params.set("actor", auditQuery.actor);
    let data;
    try { data = (await GET(`/audit?${params}`)).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    if (!data.items.length) { target.innerHTML = `<div class="empty">${icon("scroll")} No audit records match.</div>`; return; }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Status</th><th>IP</th><th>Metadata</th></tr></thead>
        <tbody>${data.items.map((item) => `
          <tr>
            <td>${dateFmt(item.createdAt)}</td>
            <td class="mono">${esc(item.actorTelegramId)}</td>
            <td><strong>${esc(item.action)}</strong></td>
            <td class="mono">${esc([item.targetType, item.targetId].filter(Boolean).join(":") || "—")}</td>
            <td>${pill(item.status === "succeeded" ? "fulfilled" : item.status === "failed" ? "failed" : "pending")}</td>
            <td class="mono">${esc(item.ipAddress || "—")}</td>
            <td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis" title="${esc(JSON.stringify(item.metadata || {}))}">${esc(JSON.stringify(item.metadata || {}).slice(0, 60))}</td>
          </tr>`).join("")}
        </tbody></table></div>
      ${pagerHtml(data.page, Math.ceil(data.total / data.pageSize), data.total, "audit")}`;
    PAGER_HANDLERS.audit = (page) => { auditQuery.page = page; loadAudit(); };
    bindPagers();
  }

  // ── System ─────────────────────────────────────────────────────────────────
  // ── Admins (multi-admin management) ────────────────────────────────────────
  async function pageAdmins() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="card-head"><h3>Admin access</h3><span class="sub">owner-managed allowlist — environment + database</span>
          <span class="spacer"></span>
          <button class="btn primary sm" id="adm-add" style="display:none">${icon("plus")} Add admin</button>
          <button class="btn sm" id="adm-refresh">${icon("refresh")} Refresh</button>
        </div>
        <div id="admins-body">${loading()}</div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>How access works</h3></div>
        <div class="card-pad" style="color:var(--text-dim);font-size:13px;line-height:1.75">
          • Owners come from the <span class="mono">ADMINS</span> environment variable and always keep full access — they cannot be removed here.<br/>
          • Admins added here are stored in the database, enforced server-side for the Telegram panel and this web console, and every change is audited.<br/>
          • Only the owner can add or remove admins; extra admins cannot elevate themselves or edit other admins.<br/>
          • Database admins are cached briefly, so a removal takes effect within a short TTL.
        </div>
      </div>`;
    $("#adm-refresh").onclick = () => loadAdmins();
    $("#adm-add").onclick = openAddAdminModal;
    await loadAdmins();
  }

  async function loadAdmins() {
    const target = $("#admins-body");
    if (!target) return;
    let data;
    try { data = (await GET("/admins")).data; }
    catch (error) { target.innerHTML = errorBox(error); return; }
    const isOwner = data.some((a) => String(a.telegramId) === String(state.actorId) && a.role === "owner");
    const addButton = $("#adm-add");
    if (addButton) addButton.style.display = isOwner ? "" : "none";
    if (!data.length) { target.innerHTML = `<div class="empty">${icon("shield")} No admins are configured.</div>`; return; }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Telegram ID</th><th>Name</th><th>Role</th><th>Source</th><th>Added</th><th></th></tr></thead>
        <tbody>${data.map((admin) => {
          const removable = isOwner && admin.source === "database" && admin.role !== "owner";
          return `
          <tr>
            <td class="mono">${esc(admin.telegramId)}${String(admin.telegramId) === String(state.actorId) ? ' <span class="pill blue"><span class="dot"></span>you</span>' : ""}</td>
            <td>${esc(admin.displayName || "—")}</td>
            <td>${pill(admin.role === "owner" ? "owner" : "admin")}</td>
            <td>${esc(admin.source === "environment" ? "env (ADMINS)" : "database")}</td>
            <td>${admin.addedAt ? dateFmt(admin.addedAt) : "—"}</td>
            <td>${removable ? `<button class="btn sm danger" data-remove-admin="${esc(admin.telegramId)}">Remove</button>` : ""}</td>
          </tr>`;
        }).join("")}
        </tbody></table></div>`;
    $$("[data-remove-admin]").forEach((button) => {
      button.onclick = () => confirmRemoveAdmin(button.dataset.removeAdmin);
    });
  }

  function openAddAdminModal() {
    openModal({
      title: "Add admin",
      bodyHtml: `
        ${fieldHtml("TELEGRAM ID", "telegramId", { placeholder: "e.g. 123456789", hint: "Numeric Telegram user ID of the new admin." })}
        ${fieldHtml("DISPLAY NAME (OPTIONAL)", "displayName", { placeholder: "Label shown in the admins list" })}`,
      confirmText: "Add admin",
      onConfirm: async (values) => {
        if (!/^\d{5,20}$/.test(values.telegramId.trim())) { toast("error", "Enter a numeric Telegram ID."); return; }
        try {
          const result = (await POST("/admins", {
            operationId: newOperationId(),
            telegramId: values.telegramId.trim(),
            displayName: values.displayName.trim() || null,
          })).data;
          toast("success", result?.alreadyPresent ? "This admin already has access." : "Admin added.");
          closeModal();
          loadAdmins();
        } catch (error) { apiErrorToast(error); }
      },
    });
  }

  function confirmRemoveAdmin(telegramId) {
    openModal({
      title: "Remove admin",
      bodyHtml: `<p style="margin:0;color:var(--text-dim);font-size:13.5px;line-height:1.7">Remove admin access for <span class="mono">${esc(telegramId)}</span>? Their sessions stay valid until expiry, but they immediately lose panel access on the next request.</p>`,
      confirmText: "Remove",
      danger: true,
      onConfirm: async () => {
        try {
          await api("DELETE", `/admins/${encodeURIComponent(telegramId)}`, { operationId: newOperationId() });
          toast("success", "Admin removed.");
          closeModal();
          loadAdmins();
        } catch (error) { apiErrorToast(error); }
      },
    });
  }

  async function pageSystem() {
    $("#content").innerHTML = `
      <div class="card">
        <div class="card-head"><h3>System health</h3><span class="sub">dependencies, webhook and background jobs</span>
          <span class="spacer"></span>
          <button class="btn sm" id="sys-refresh">${icon("refresh")} Re-check now</button>
        </div>
        <div class="card-pad"><div class="health-grid" id="sys-health">${loading()}</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>Operational notes</h3></div>
        <div class="card-pad" style="color:var(--text-dim);font-size:13px;line-height:1.75">
          • Health checks probe the real dependencies (Mongo ping, Redis ping, WizardXray status, HooshPay client, Telegram getMe).<br/>
          • Webhook and background-job health are process-local signals from this single Railway replica.<br/>
          • The bot must run with exactly one replica — Telegram polling and the cron locks assume a single instance.<br/>
          • Errors shown here are intentionally safe: no URLs, credentials or tokens are ever exposed.
        </div>
      </div>`;
    $("#sys-refresh").onclick = async () => {
      $("#sys-health").innerHTML = loading();
      try {
        const data = (await GET("/system/health?fresh=1")).data;
        $("#sys-health").innerHTML = healthCards(data.services);
      } catch (error) { $("#sys-health").innerHTML = errorBox(error); }
    };
    try {
      const data = (await GET("/system/health")).data;
      $("#sys-health").innerHTML = healthCards(data.services);
    } catch (error) { $("#sys-health").innerHTML = errorBox(error); }
  }

  // ── Routing ────────────────────────────────────────────────────────────────
  const PAGES = {
    dashboard: { title: "Dashboard", render: pageDashboard },
    analytics: { title: "Analytics", render: pageAnalytics },
    users: { title: "Users", render: pageUsers },
    vpns: { title: "VPN Services", render: pageVpns },
    payments: { title: "Payments", render: pagePayments },
    recovery: { title: "Payment Recovery", render: pageRecovery },
    products: { title: "Products", render: pageProducts },
    broadcast: { title: "Broadcast — ارسال پیام همگانی", render: pageBroadcast },
    referrals: { title: "Referrals", render: pageReferrals },
    audit: { title: "Audit Log", render: pageAudit },
    admins: { title: "Admins", render: pageAdmins },
    system: { title: "System", render: pageSystem },
  };

  async function renderRoute(refresh = false) {
    const route = (location.hash.replace(/^#\//, "") || "dashboard").split("?")[0];
    state.route = PAGES[route] ? route : "dashboard";
    const page = PAGES[state.route];
    $("#page-title").textContent = page.title;
    renderNav();
    clearInterval(broadcastTimer);
    await page.render(refresh);
    refreshRecoveryBadge().catch(() => {});
  }

  window.addEventListener("hashchange", () => renderRoute());

  // ── Auth flow ──────────────────────────────────────────────────────────────
  function showLogin() {
    state.csrfToken = null;
    state.actorId = null;
    $("#app").classList.remove("ready");
    $("#login").classList.add("show");
  }

  function showApp() {
    $("#login").classList.remove("show");
    $("#app").classList.add("ready");
    $("#admin-id").textContent = state.actorId;
    renderRoute();
  }

  $("#login-request").onclick = async () => {
    const telegramId = $("#login-tid").value.trim();
    if (!/^\d{5,20}$/.test(telegramId)) return toast("error", "Enter a numeric Telegram ID.");
    const button = $("#login-request");
    button.disabled = true;
    try {
      const result = await POST("/auth/request-code", { telegramId });
      $("#login-verify").disabled = false;
      $("#login-code").focus();
      toast("success", result.delivered
        ? "Sign-in code sent — check the bot's direct message."
        : "Code created, but the bot could not DM it right now. Make sure the bot can message you and try again.");
    } catch (error) {
      toast("error", error.message);
    } finally { button.disabled = false; }
  };

  $("#login-verify").onclick = async () => {
    const code = $("#login-code").value.trim();
    if (!code) return toast("error", "Paste the sign-in code from the bot.");
    const button = $("#login-verify");
    button.disabled = true;
    try {
      const result = await POST("/auth/verify", { code });
      state.csrfToken = result.csrfToken;
      state.actorId = result.actorTelegramId;
      toast("success", "Signed in.");
      showApp();
    } catch (error) {
      toast("error", error.message);
    } finally { button.disabled = false; }
  };

  $("#login-code").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#login-verify").click(); });
  $("#login-tid").addEventListener("keydown", (event) => { if (event.key === "Enter") $("#login-request").click(); });

  $("#btn-logout").onclick = async () => {
    try { await POST("/auth/logout", {}); } catch { /* clearing local state regardless */ }
    showLogin();
  };

  $("#btn-refresh").onclick = () => renderRoute(true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeModal(); closeDrawer(); }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function boot() {
    try {
      const session = await GET("/auth/session");
      if (session.authenticated) {
        state.csrfToken = session.csrfToken;
        state.actorId = session.actorTelegramId;
        showApp();
        return;
      }
    } catch { /* fall through to login */ }
    showLogin();
  })();
})();
