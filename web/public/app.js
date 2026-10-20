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
    renderSeq: 0,
    rendering: false,
    quiet: false,
    lastLoadedAt: null,
    lastLoadFailed: false,
  };

  // ── Utilities ──────────────────────────────────────────────────────────────
  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const I18N = window.SwiftI18n;
  const FMT = window.SwiftFormat;
  const lang = () => I18N.lang();
  const t = (key, vars) => I18N.t(key, vars);
  const num = (value) => FMT.number(value, lang());
  const money = (value) => FMT.money(value, lang());
  const pct = (value) => FMT.percent(value, lang());
  const compact = (value) => FMT.compact(value, lang());
  const dateFmt = (value) => FMT.dateTime(value, lang());
  const dateShort = (value) => FMT.date(value, lang());
  const dayLabel = (value) => FMT.dayLabel(value, lang());
  I18N.init();

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
    const renderSeq = state.renderSeq;
    const response = await fetch(`/api/admin${path}`, options);
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    const authCall = path.startsWith("/auth/");
    // A read issued for an older page render must not overwrite newer content.
    if (method === "GET" && !authCall && renderSeq !== state.renderSeq) return new Promise(() => {});
    if (response.status === 401 && !authCall) { showLogin(); throw Object.assign(new Error(data?.message || "Session expired — sign in again."), { status: 401 }); }
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
  let modalOpener = null;
  function openModal({ title, bodyHtml, confirmText = "Confirm", danger = false, onConfirm }) {
    modalOpener = document.activeElement;
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    const foot = $("#modal-foot");
    foot.innerHTML = "";
    const cancel = document.createElement("button");
    cancel.className = "btn"; cancel.type = "button"; cancel.textContent = "Cancel";
    cancel.onclick = closeModal;
    const ok = document.createElement("button");
    ok.className = `btn ${danger ? "danger" : "primary"}`; ok.type = "button";
    ok.innerHTML = `${confirmText}`;
    ok.onclick = async () => {
      const values = {};
      $$("#modal-body input, #modal-body textarea, #modal-body select").forEach((input) => {
        values[input.dataset.field] = input.type === "checkbox" ? input.checked : input.value;
      });
      ok.disabled = true;
      try { await onConfirm(values); } finally { ok.disabled = false; }
    };
    foot.append(cancel, ok);
    $("#modal-backdrop").classList.add("show");
    document.body.classList.add("modal-open");
    const first = $("#modal-body input, #modal-body textarea, #modal-body select") || ok;
    window.setTimeout(() => first.focus(), 0);
  }
  function closeModal() {
    if (!$("#modal-backdrop").classList.contains("show")) return;
    $("#modal-backdrop").classList.remove("show");
    document.body.classList.remove("modal-open");
    if (modalOpener && typeof modalOpener.focus === "function") modalOpener.focus();
    modalOpener = null;
  }
  $("#modal-backdrop").addEventListener("click", (event) => { if (event.target.id === "modal-backdrop") closeModal(); });

  const fieldHtml = (label, name, { placeholder = "", type = "text", value = "", hint = "" } = {}) => `
    <label class="field">
      <span class="field-label">${esc(label)}</span>
      <input class="input" data-field="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" />
      ${hint ? `<span style="color:var(--text-faint);font-size:11.5px;margin-top:4px;display:block">${esc(hint)}</span>` : ""}
    </label>`;

  const reasonField = (hint = "Recorded in the audit log.") => fieldHtml("REASON", "reason", { placeholder: "Why is this action being taken?", hint });

  // ── Drawer ─────────────────────────────────────────────────────────────────
  let drawerOpener = null;
  function openDrawer(title, sub, html) {
    if (!$("#drawer").classList.contains("open")) drawerOpener = document.activeElement;
    $("#drawer-title").textContent = title;
    $("#drawer-sub").textContent = sub || "";
    $("#drawer-body").innerHTML = html;
    $("#drawer").classList.add("open");
    $("#drawer").removeAttribute("inert");
    $("#drawer-backdrop").classList.add("show");
    document.body.classList.add("modal-open");
    window.setTimeout(() => $("#drawer-close").focus(), 0);
  }
  function closeDrawer() {
    if (!$("#drawer").classList.contains("open")) return;
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("inert", "");
    $("#drawer-backdrop").classList.remove("show");
    document.body.classList.remove("modal-open");
    if (drawerOpener && typeof drawerOpener.focus === "function") drawerOpener.focus();
    drawerOpener = null;
  }
  $("#drawer-close").onclick = closeDrawer;
  $("#drawer-backdrop").onclick = closeDrawer;

  // ── Status pills ───────────────────────────────────────────────────────────
  const PILL_TONES = {
    pending: "yellow", paid: "blue", fulfilled: "green", failed: "red",
    cancelled: "gray", refunded: "yellow", "recovery-required": "red", interrupted: "yellow",
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
  // Dependency-free renderer: colours come from CSS tokens (grid/labels), so
  // both themes work; labels use the active language's digits and Jalali dates;
  // the time axis always runs left-to-right (svg { direction: ltr }). The
  // viewBox width follows the viewport so text stays readable on phones.
  const chartWidth = () => (window.innerWidth < 560 ? 340 : window.innerWidth < 900 ? 560 : 720);

  function niceMax(value) {
    if (value <= 0) return 1;
    const pow = 10 ** Math.floor(Math.log10(value));
    const unit = [1, 2, 2.5, 5, 10].find((step) => step * pow >= value) * pow;
    return unit;
  }

  function multiLineChart(rows, defs, { height = 220, format = num } = {}) {
    if (!rows || !rows.length) return `<div class="empty">${esc(t("No data for this period yet."))}</div>`;
    const width = chartWidth();
    const pad = { top: 14, right: 12, bottom: 26, left: width < 400 ? 40 : 54 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = niceMax(Math.max(...defs.flatMap((d) => rows.map((r) => Number(r[d.key] || 0))), 0));
    const x = (i) => pad.left + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
    const y = (v) => pad.top + innerH - (v / max) * innerH;
    const grid = [0, max / 2, max].map((tick) =>
      `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"/>
       <text class="axis-label" x="${pad.left - 6}" y="${y(tick) + 3.5}" text-anchor="end">${esc(format(tick))}</text>`).join("");
    const step = Math.max(1, Math.ceil(rows.length / (width < 400 ? 4 : 7)));
    const labels = rows.map((row, i) => (i % step === 0 || i === rows.length - 1)
      ? `<text class="axis-label" x="${x(i)}" y="${height - 7}" text-anchor="middle">${esc(row.label || "")}</text>` : "").join("");
    const lines = defs.map((d, index) => {
      const points = rows.map((r, i) => `${x(i).toFixed(1)},${y(Number(r[d.key] || 0)).toFixed(1)}`).join(" ");
      const area = index === 0 ? `<polygon points="${pad.left},${pad.top + innerH} ${points} ${pad.left + innerW},${pad.top + innerH}" fill="${d.color}" opacity="0.10"/>` : "";
      return `${area}<polyline points="${points}" fill="none" stroke="${d.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
        + rows.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(Number(r[d.key] || 0)).toFixed(1)}" r="2.3" fill="${d.color}"/>`).join("");
    }).join("");
    const summary = defs.map((d) => `${d.name}: ${format(rows.reduce((sum, r) => sum + Number(r[d.key] || 0), 0))}`).join("; ");
    return `<svg class="chart" role="img" aria-label="${esc(summary)}" viewBox="0 0 ${width} ${height}" data-w="${width}" data-padl="${pad.left}" data-inner="${innerW}">${grid}${lines}${labels}</svg>`;
  }

  /** Touch- and mouse-friendly tooltip: pointer position -> nearest data point. */
  function attachChartTips(selector, rows, defs, fmt) {
    const box = $(selector);
    const svg = box && box.querySelector("svg.chart");
    if (!svg || !rows.length) return;
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    tip.setAttribute("role", "status");
    box.appendChild(tip);
    const show = (event) => {
      const rect = svg.getBoundingClientRect();
      const viewWidth = Number(svg.dataset.w);
      const padLeft = Number(svg.dataset.padl);
      const inner = Number(svg.dataset.inner);
      const px = ((event.clientX - rect.left) / rect.width) * viewWidth;
      const index = Math.min(rows.length - 1, Math.max(0, Math.round(((px - padLeft) / inner) * (rows.length - 1))));
      const row = rows[index];
      tip.textContent = `${row.label} — ${defs.map((d) => `${d.name}: ${fmt(row[d.key])}`).join(" · ")}`;
      tip.hidden = false;
      const boxRect = box.getBoundingClientRect();
      const left = Math.min(Math.max(8, event.clientX - boxRect.left - 20), Math.max(8, boxRect.width - tip.offsetWidth - 8));
      tip.style.left = `${left}px`;
      tip.style.top = "4px";
    };
    svg.addEventListener("pointerdown", show);
    svg.addEventListener("pointermove", show);
    svg.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") tip.hidden = true; });
    // Touch: the tooltip stays after the finger lifts and closes on the next tap elsewhere.
    document.addEventListener("pointerdown", (event) => { if (!svg.contains(event.target)) tip.hidden = true; });
  }

  function lineChart(series, { height = 220, color = "#3B82F6", format = num } = {}) {
    if (!series || !series.length) return `<div class="empty">${esc(t("No data for this period yet."))}</div>`;
    const rows = series.map((d) => ({ label: dayLabel(d.date), value: Number(d.value || 0) }));
    return multiLineChart(rows, [{ key: "value", name: "", color }], { height, format });
  }

  function barChart(items, { height = 220, color = "#3B82F6", format = num } = {}) {
    const entries = (items || []).slice(0, 8);
    if (!entries.length) return `<div class="empty">${esc(t("No data yet."))}</div>`;
    const width = chartWidth();
    const pad = { top: 14, right: 10, bottom: 40, left: 10 };
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
      const short = label.length > 12 ? label.slice(0, 11) + "…" : label;
      return `
        <rect x="${bx}" y="${by}" width="${barW}" height="${Math.max(barH, 1)}" rx="4" fill="${color}" opacity="${0.55 + 0.45 * (Number(entry.count || 0) / max)}"><title>${esc(label)}: ${esc(num(entry.count))} (${esc(money(entry.revenue))})</title></rect>
        <text class="axis-label-dim" x="${bx + barW / 2}" y="${height - 22}" text-anchor="middle">${esc(short)}</text>
        <text class="axis-label" x="${bx + barW / 2}" y="${height - 10}" text-anchor="middle">${esc(format(entry.count))}</text>`;
    }).join("");
    return `<svg class="chart" role="img" aria-label="${esc(entries.map((e) => `${e.name || e.productId}: ${num(e.count)}`).join("; "))}" viewBox="0 0 ${width} ${height}">${bars}</svg>`;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  const NAV = [
    { id: "dashboard", label: "Dashboard", icon: "grid", section: "Overview" },
    { id: "analytics", label: "Analytics", icon: "chart", section: "Overview" },
    { id: "users", label: "Users", icon: "users", section: "Manage" },
    { id: "vpns", label: "VPN Services", icon: "globe", section: "Manage" },
    { id: "payments", label: "Payments", icon: "card", section: "Money" },
    { id: "recovery", label: "Recovery", icon: "life", section: "Money" },
    { id: "custody", label: "Custody & Crypto", icon: "shield", section: "Money" },
    { id: "products", label: "Products", icon: "box", section: "Money" },
    { id: "broadcast", label: "Broadcast", icon: "megaphone", section: "Engage" },
    { id: "referrals", label: "Referrals", icon: "gift", section: "Engage" },
    { id: "audit", label: "Audit Log", icon: "scroll", section: "System" },
    { id: "admins", label: "Admins", icon: "shield", section: "System" },
    { id: "system", label: "System", icon: "wrench", section: "System" },
    { id: "mock", label: "Mock Tests", icon: "check", section: "System" },
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
      html += `<a class="nav-item" href="#/${item.id}" data-route="${item.id}" ${state.route === item.id ? 'aria-current="page"' : ""}>${icon(item.icon)}<span>${esc(item.label)}</span><span class="badge" id="badge-${item.id}" style="display:none"></span></a>`;
    }
    html += `
      <div class="sidebar-footer">
        <div style="font-size:11px;color:var(--text-faint);line-height:1.6;padding:0 10px">
          SWIFT-VPN-Bot<br/>Admin Console v1.0
        </div>
      </div>`;
    sidebar.innerHTML = html;
    sidebar.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.route === state.route));
    $("#bottom-nav").innerHTML = ["dashboard", "users", "vpns", "payments", "recovery", "system"]
      .map((id) => {
        const item = NAV.find((n) => n.id === id);
        return `<a class="nav-item ${state.route === id ? "active" : ""}" href="#/${id}" data-route="${id}" ${state.route === id ? 'aria-current="page"' : ""}>${icon(item.icon)}<span>${esc(item.label.split(" ")[0])}</span></a>`;
      }).join("");
    $$(".nav-item").forEach((el) => {
      el.addEventListener("click", () => closeNav());
    });
    syncNavInert();
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
    const first = lang() === "fa" ? "»" : "«";
    const last = lang() === "fa" ? "«" : "»";
    const count = t(total === 1 ? "{n} record" : "{n} records", { n: num(total) });
    if (!pages || pages <= 1) return `<div class="pager"><div class="grow"></div><span>${esc(count)}</span></div>`;
    return `
      <nav class="pager" aria-label="Pagination">
        <button class="btn sm" type="button" data-pager="${handlerName}" data-page="1" aria-label="First page" ${page <= 1 ? "disabled" : ""}>${first}</button>
        <button class="btn sm" type="button" data-pager="${handlerName}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Prev</button>
        <span class="grow">${esc(t("Page {page} of {pages}", { page: num(page), pages: num(pages) }))}</span>
        <span>${esc(count)}</span>
        <button class="btn sm" type="button" data-pager="${handlerName}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next</button>
        <button class="btn sm" type="button" data-pager="${handlerName}" data-page="${pages}" aria-label="Last page" ${page >= pages ? "disabled" : ""}>${last}</button>
      </nav>`;
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
    if (!state.quiet) $("#content").innerHTML = loading();
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


  function stat(label, value, ic, tone = "", foot = "") {
    return `<div class="stat ${tone ? `tone-${tone}` : ""}">
      <div class="label">${icon(ic)} ${esc(label)}</div>
      <div class="value">${value}</div>
      ${foot ? `<div class="foot">${esc(foot)}</div>` : ""}
    </div>`;
  }

  function errorBox(error) {
    return `<div class="card card-pad"><div class="danger-box">${icon("alert")} ${esc(error.message || "Could not load this page.")}</div>
      <div style="margin-top:12px"><button class="btn" type="button" data-retry>Try again</button></div></div>`;
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
          ${service.error ? `<div><span>Issue</span><span style="color:var(--on-red)">${esc(service.error)}</span></div>` : ""}
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
          <dt>Test service</dt><dd>${data.testService?.inFlight ? "In progress" : data.testService?.eligible ? "Eligible" : "Already received"}</dd>
          <dt>Referrals</dt><dd>${num(data.referral.referralCount)} referred${data.referral.referredByTelegramId ? ` · referred by ${esc(data.referral.referredByTelegramId)}` : ""}${data.referral.trackingAvailable ? "" : " · not yet tracked"}</dd>
          ${user.isBanned ? `<dt>Blocked</dt><dd style="color:var(--on-red)">${dateFmt(data.blockedAt)}${data.blockReason ? ` — ${esc(data.blockReason)}` : ""}</dd>` : ""}
        </div>
      </div>
      <div>
        <div class="section-title">Admin actions</div>
        <div class="drawer-actions" style="margin-top:10px">
          <button class="btn success sm" data-act="add-balance">${icon("plus")} Add balance</button>
          <button class="btn danger sm" data-act="remove-balance">Remove balance</button>
          <button class="btn sm" data-act="refresh-user">${icon("refresh")} Refresh</button>
          ${data.testService && !data.testService.eligible && !data.testService.inFlight
            ? `<button class="btn sm" data-act="restore-test">${icon("refresh")} Restore test service</button>` : ""}
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
        if (action === "restore-test") return testEligibilityModal(telegramId);
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

  function testEligibilityModal(telegramId) {
    openModal({
      title: "Restore test service",
      bodyHtml: `<div class="warn-box">This only lets the user request one more test service. No service is created.</div>
        <div class="kv"><dt>Telegram ID</dt><dd class="mono">${esc(telegramId)}</dd></div>
        ${reasonField()}`,
      confirmText: "Restore test service",
      onConfirm: async (values) => {
        try {
          await POST(`/users/${encodeURIComponent(telegramId)}/test-eligibility`, { operationId: newOperationId(), reason: values.reason });
          toast("success", t("Test service eligibility restored."));
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
          <dt>WizardXray</dt><dd>${pill(data.wizardXray.status)} ${data.wizardXray.latencyMs != null ? `<span class="mono" style="color:var(--text-faint)">${data.wizardXray.latencyMs}ms</span>` : ""}${data.wizardXray.error ? `<div style="color:var(--on-red);font-size:12px">${esc(data.wizardXray.error)}</div>` : ""}</dd>
        </div>
      </div>
      <div>
        <div class="section-title">Actions</div>
        <div class="drawer-actions" style="margin-top:10px">
          ${actionButton("change-link", "🔄 Change link", "", data.availableActions.changeLink)}
          ${actionButton("disable", "⛔ Disable", "danger", data.availableActions.disable)}
          ${actionButton("revoke", "🗑 Revoke permanently", "danger", data.availableActions.revoke)}
          ${actionButton("extend-time", "⏱ Extend time", "", data.availableActions.extendTime)}
          ${actionButton("increase-traffic", "📦 Increase traffic", "", data.availableActions.increaseTraffic)}
          ${actionButton("regenerate-config", "🔐 Regenerate config", "", false, data.unavailableActions.regenerateConfig)}
        </div>
        <div class="warn-box" style="margin-top:10px">Regenerate config is not offered by the WizardXray API v1 and is intentionally not faked; use “Change link” for a new subscription link.</div>
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
      "extend-time": { title: "Extend service time", text: "Adds days to the service on WizardXray (upg_time). The change is verified against the panel before it is reported as done.", confirm: "Extend time", danger: false, reason: true, field: ["days", "DAYS TO ADD", "e.g. 30"] },
      "increase-traffic": { title: "Increase service traffic", text: "Adds traffic on WizardXray (upg_size, minimum 0.5 GB). The change is verified against the panel before it is reported as done.", confirm: "Add traffic", danger: false, reason: true, field: ["gig", "GB TO ADD", "e.g. 10"] },
      revoke: { title: "Revoke VPN service", text: "The service is permanently deleted from WizardXray and removed from the user's account. This cannot be undone.", confirm: "Revoke permanently", danger: true, reason: true },
    };
    const config = labels[action];
    if (!config) return;
    openModal({
      title: config.title,
      bodyHtml: `
        ${config.danger ? `<div class="danger-box">${esc(config.text)}</div>` : `<div class="warn-box">${esc(config.text)}</div>`}
        ${config.field ? fieldHtml(config.field[1], config.field[0], { type: "number", placeholder: config.field[2] }) : ""}
        ${config.reason ? reasonField() : ""}`,
      confirmText: config.confirm,
      danger: config.danger,
      onConfirm: async (values) => {
        try {
          const result = (await POST(`/vpns/${encodeURIComponent(vpn.clientId)}/actions`, {
            operationId: newOperationId(), action, reason: values.reason, days: values.days, gig: values.gig,
          })).data;
          toast(result.localSynced === false ? "info" : "success", `Action completed (${action}).${result.localSynced === false ? " Local copy not updated — panel values are authoritative." : ""}`);
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
          ${data.lastError ? `<dt>Last error</dt><dd style="color:var(--on-red)">${esc(data.lastError)}</dd>` : ""}
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
              <td style="color:var(--on-red)">${esc(item.lastError || "—")}</td>
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
        if (["completed", "cancelled", "failed", "interrupted"].includes(status.status)) {
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
            <td>${pill(item.status === "completed" ? "fulfilled" : item.status === "failed" ? "failed" : item.status === "cancelled" ? "cancelled" : item.status === "interrupted" ? "interrupted" : "pending")}</td>
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
  // Server-side report (/analytics/report): every figure carries a definition,
  // a comparison with the preceding equivalent period and an explicit
  // "not available" instead of a silent zero. Top-ups (cash into wallets) and
  // sales (services bought) are shown separately and never added together.
  const analyticsState = { range: "30d", from: "", to: "" };
  const RANGE_TABS = [
    ["today", "Today"], ["7d", "Last 7 days"], ["30d", "Last 30 days"],
    ["thisMonth", "This month"], ["prevMonth", "Previous month"], ["custom", "Custom range"],
  ];
  const KPI_LABELS = {
    users_total: "Total users", users_new: "New users in period", users_active: "Active users",
    services_active: "Active services", services_activated: "New activations", services_expiring_7d: "Expiring in 7 days",
    payment_attempts: "Payment attempts", payments_successful: "Successful payments", payment_success_rate: "Success rate",
    payments_failed: "Failed payments", payments_cancelled: "Cancelled payments", payments_review: "Partial / manual review",
    buyers_unique: "Unique buyers", buyer_retention: "Buyer retention",
    topups_gross: "Gross top-ups", topups_count: "Top-up count", topups_average: "Average top-up",
    refunds_reversals: "Refunds & reversals", refunds_reversals_count: "Refund & reversal count", topups_net: "Net top-ups",
    wallet_balance_total: "Wallet balances (now)",
    sales_gross: "Gross sales", sales_refunded: "Refunded purchases", sales_net: "Net sales", sales_average_order: "Average order value",
  };
  const KPI_GROUPS = [
    { group: "operational", title: "Operational", sub: "People, services and payment attempts." },
    { group: "financial", title: "Financial — wallet top-ups", sub: "Money received into wallets. A top-up is not revenue." },
    { group: "sales", title: "Sales — services bought", sub: "Services customers bought from their wallets. Not cash collected." },
  ];

  function kpiValueHtml(item) {
    if (item.value === null || item.value === undefined) return `<div class="kpi-value na">${esc(t("Not available"))}</div>`;
    const text = item.unit === "toman" ? money(item.value) : item.unit === "ratio" ? pct(item.value) : num(item.value);
    return `<div class="kpi-value">${esc(text)}</div>`;
  }

  function deltaHtml(change) {
    if (!change) return "";
    if (change.state === "up" || change.state === "down") {
      const arrow = change.state === "up" ? "▲" : "▼";
      return `<span class="delta ${change.state}">${arrow} ${esc(pct(Math.abs(change.pct)))}</span>`;
    }
    if (change.state === "flat") return `<span class="delta flat">${esc(t("No change"))}</span>`;
    if (change.state === "no_baseline") return `<span class="delta no_baseline">${esc(t("No baseline"))}</span>`;
    return "";
  }

  function kpiCard(item, definitions) {
    const label = KPI_LABELS[item.id] || item.id;
    const previous = item.previous === undefined || item.previous === null ? "" : (item.unit === "toman" ? money(item.previous) : item.unit === "ratio" ? pct(item.previous) : num(item.previous));
    return `<div class="kpi" data-kpi="${esc(item.id)}">
      <div class="kpi-label"><span>${esc(t(label))}</span>
        <button type="button" class="def-btn" data-def="${esc(item.id)}" aria-label="${esc(t("Definition"))}: ${esc(t(label))}" title="${esc(definitions[item.id] || "")}">i</button></div>
      ${kpiValueHtml(item)}
      <div class="kpi-sub">${deltaHtml(item.change)}${previous ? `<span>${esc(t("vs previous"))}: <span class="num">${esc(previous)}</span></span>` : ""}</div>
    </div>`;
  }

  function distributionRows(rows, { labelOf, amountOf, countOf }) {
    const max = Math.max(...rows.map(amountOf), 1);
    return rows.map((row) => `<div class="dist-row">
        <span>${esc(labelOf(row))}</span>
        <span class="bar" aria-hidden="true"><span style="width:${Math.max(2, Math.round((amountOf(row) / max) * 100))}%"></span></span>
        <span class="amount num">${esc(money(amountOf(row)))} · ${esc(num(countOf(row)))}</span>
      </div>`).join("");
  }

  async function pageAnalytics() {
    const fa = lang() === "fa";
    $("#content").innerHTML = `
      <div class="range-bar">
        <div class="tabs" role="tablist" aria-label="${esc(t("Compared with the preceding equivalent period"))}">
          ${RANGE_TABS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${analyticsState.range === id}" class="tab ${analyticsState.range === id ? "active" : ""}" data-range="${id}">${esc(t(label))}</button>`).join("")}
        </div>
        <button type="button" class="btn sm" id="an-export">${icon("download")} ${esc(t("Export CSV"))}</button>
      </div>
      ${analyticsState.range === "custom" ? `<div class="range-bar"><div class="custom">
        <label class="field"><span class="sr-only">${esc(t("Start date"))}</span><input id="an-from" class="input" type="date" value="${esc(analyticsState.from)}" aria-label="${esc(t("Start date"))}" /></label>
        <label class="field"><span class="sr-only">${esc(t("End date"))}</span><input id="an-to" class="input" type="date" value="${esc(analyticsState.to)}" aria-label="${esc(t("End date"))}" /></label>
        <button type="button" class="btn primary sm" id="an-apply">${esc(t("Apply"))}</button></div></div>` : ""}
      <div id="analytics-body" aria-live="polite">${loading()}</div>`;

    $$("#content [data-range]").forEach((tab) => {
      tab.onclick = () => { analyticsState.range = tab.dataset.range; pageAnalytics(); };
    });
    const queryString = (extra = {}) => {
      const params = new URLSearchParams({ range: analyticsState.range, calendar: fa ? "jalali" : "gregorian", ...extra });
      if (analyticsState.range === "custom") { params.set("from", analyticsState.from); params.set("to", analyticsState.to); }
      return params.toString();
    };
    if ($("#an-apply")) $("#an-apply").onclick = () => {
      analyticsState.from = $("#an-from").value; analyticsState.to = $("#an-to").value;
      if (!analyticsState.from || !analyticsState.to) return toast("error", t("Start date") + " / " + t("End date"));
      pageAnalytics();
    };
    $("#an-export").onclick = () => {
      if (analyticsState.range === "custom" && (!analyticsState.from || !analyticsState.to)) return toast("error", t("Start date") + " / " + t("End date"));
      window.location.assign(`/api/admin/analytics/export.csv?${queryString()}`);
      toast("success", t("Export started."));
    };
    if (analyticsState.range === "custom" && (!analyticsState.from || !analyticsState.to)) {
      $("#analytics-body").innerHTML = `<div class="empty">${icon("chart")} ${esc(t("Start date"))} / ${esc(t("End date"))}</div>`;
      return;
    }

    let report;
    try { report = (await GET(`/analytics/report?${queryString()}`)).data; }
    catch (error) { $("#analytics-body").innerHTML = errorBox(error); return; }

    const byId = Object.fromEntries(report.kpis.map((item) => [item.id, item]));
    const rangeText = `${dateShort(report.range.from)} → ${dateShort(new Date(new Date(report.range.to).getTime() - 1))}`;
    const cacheText = report.cache.cached ? `${t("Showing cached results")} (${num(report.cache.ageSeconds)} ${t("seconds ago")})` : t("Live");
    const series = report.series;
    const chartRows = series.map((row) => ({ label: dayLabel(row.start), topups: row.topups, sales: row.sales, newUsers: row.newUsers, orders: row.orders }));
    const providerNames = { hooshpay: "HooshPay", nowpayments: "NOWPayments", trx: "TRX", bank: "Bank card" };
    const outcomeKeys = ["successful", "settling", "pending", "failed", "cancelled", "expired", "partial", "refunded", "review", "other"];

    $("#analytics-body").innerHTML = `
      <p class="fresh-note">${esc(rangeText)} · ${esc(t("Timezone: Asia/Tehran"))} · ${esc(t("Amounts are in Toman"))} · ${esc(cacheText)} ·
        <a href="#" id="an-nocache">${esc(t("Re-run without cache"))}</a></p>
      ${KPI_GROUPS.map((g) => `<section class="kpi-group" aria-labelledby="kg-${g.group}">
        <h2 id="kg-${g.group}">${esc(t(g.title))}</h2><p>${esc(t(g.sub))}</p>
        <div class="kpi-grid">${report.kpis.filter((item) => item.group === g.group).map((item) => kpiCard(item, report.definitions)).join("")}</div>
      </section>`).join("")}
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card chart-card">
          <div class="card-head"><h3>${esc(t("Top-ups vs sales"))}</h3><span class="sub">${esc(t("Amounts are in Toman"))}</span></div>
          <div class="legend"><span><i style="background:var(--blue)"></i>${esc(t("Top-ups"))}</span><span><i style="background:var(--green)"></i>${esc(t("Sales"))}</span></div>
          <div class="card-pad chart-box" id="chart-money">${multiLineChart(chartRows, [
            { key: "topups", name: t("Top-ups"), color: "#3B82F6" },
            { key: "sales", name: t("Sales"), color: "#22C55E" },
          ], { format: compact, tipFormat: money })}</div>
        </div>
        <div class="card chart-card">
          <div class="card-head"><h3>${esc(t("New users per day"))}</h3></div>
          <div class="card-pad chart-box" id="chart-users">${multiLineChart(chartRows, [{ key: "newUsers", name: t("New users in period"), color: "#8B5CF6" }], { format: num, tipFormat: num })}</div>
        </div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card"><div class="card-head"><h3>${esc(t("Top-ups by provider"))}</h3></div><div class="card-pad">
          ${report.distributions.providers.some((p) => p.count) ? distributionRows(report.distributions.providers.filter((p) => p.count), { labelOf: (p) => providerNames[p.provider] || p.provider, amountOf: (p) => p.amount, countOf: (p) => p.count }) : `<div class="empty">${esc(t("No data for this range."))}</div>`}
        </div></div>
        <div class="card"><div class="card-head"><h3>${esc(t("Top-ups by cryptocurrency / network"))}</h3></div><div class="card-pad">
          ${report.distributions.crypto.length ? distributionRows(report.distributions.crypto, { labelOf: (c) => `${c.ticker || "?"}${c.network && c.network !== c.ticker ? " · " + c.network : ""}`, amountOf: (c) => c.amount, countOf: (c) => c.count }) : `<div class="empty">${esc(t("No data for this range."))}</div>`}
        </div></div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card"><div class="card-head"><h3>${esc(t("Plan popularity"))}</h3></div><div class="card-pad">
          ${report.distributions.plans.length ? distributionRows(report.distributions.plans, { labelOf: (p) => p.name, amountOf: (p) => p.amount, countOf: (p) => p.count }) : `<div class="empty">${esc(t("No data for this range."))}</div>`}
        </div></div>
        <div class="card"><div class="card-head"><h3>${esc(t("Payment outcomes"))}</h3><span class="sub">${esc(t("Definition"))}: ${esc(report.definitions.payment_success_rate)}</span></div>
          <div class="table-wrap"><table class="data"><thead><tr><th>${esc(t("Provider"))}</th>${outcomeKeys.map((k) => `<th class="num">${esc(t(k))}</th>`).join("")}</tr></thead><tbody>
            ${Object.entries(report.attempts.current.byProvider).map(([provider, outcomes]) => `<tr><td>${esc(providerNames[provider] || provider)}</td>${outcomeKeys.map((k) => `<td class="num">${esc(num(outcomes[k] || 0))}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${outcomeKeys.length + 1}">${esc(t("No data for this range."))}</td></tr>`}
          </tbody></table></div></div>
      </div>
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="section-title">${esc(t("Data not available"))}</div>
        <ul class="unavailable-list">${report.unavailable.map((u) => `<li>${esc(u.reason)}</li>`).join("")}</ul>
      </div>
      <details class="card card-pad" style="margin-bottom:16px">
        <summary>${esc(t("Metric definitions"))}</summary>
        <dl class="kv" style="margin-top:12px">${report.kpis.map((item) => `<dt>${esc(t(KPI_LABELS[item.id] || item.id))}</dt><dd>${esc(report.definitions[item.id] || "")}</dd>`).join("")}</dl>
      </details>`;

    $("#an-nocache").onclick = async (event) => {
      event.preventDefault();
      try { await GET(`/analytics/report?${queryString({ refresh: "1" })}`); pageAnalytics(); } catch (error) { apiErrorToast(error); }
    };
    $$("#analytics-body [data-def]").forEach((button) => {
      button.onclick = () => toast("info", `${t(KPI_LABELS[button.dataset.def] || button.dataset.def)}: ${report.definitions[button.dataset.def] || ""}`);
    });
    attachChartTips("#chart-money", chartRows, [{ key: "topups", name: t("Top-ups") }, { key: "sales", name: t("Sales") }], money);
    attachChartTips("#chart-users", chartRows, [{ key: "newUsers", name: t("New users in period") }], num);
    void byId;
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

  // ── Custody & NOWPayments ──────────────────────────────────────────────────
  const custodyState = {
    tab: "overview",
    assets: { search: "", network: "all", filter: "all", page: 1 },
    conversions: { status: "all", search: "", page: 1 },
    payouts: { status: "all", currency: "", search: "", page: 1 },
    transactions: { status: "all", currency: "", search: "", page: 1 },
    overviewData: null,
  };

  async function pageCustody() {
    const tabs = [
      { id: "overview", label: "A. Overview" },
      { id: "assets", label: "B. Asset Balances & Catalog" },
      { id: "conversions", label: "C. Conversions" },
      { id: "payouts", label: "D. Withdrawals & Payouts" },
      { id: "transactions", label: "E. Transactions & Reconciliation" },
    ];
    $("#content").innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="filter-bar">
          <div class="tabs">
            ${tabs.map((t) => `<button class="tab ${custodyState.tab === t.id ? "active" : ""}" data-custody-tab="${t.id}">${esc(t.label)}</button>`).join("")}
          </div>
          <span class="spacer"></span>
          <span style="font-size:12px;color:var(--text-faint)">NOWPayments API & Custody Control Center</span>
        </div>
      </div>
      <div id="custody-body">${loading()}</div>`;

    $$("#content [data-custody-tab]").forEach((btn) => {
      btn.onclick = () => {
        custodyState.tab = btn.dataset.custodyTab;
        pageCustody();
      };
    });

    if (custodyState.tab === "overview") await renderCustodyOverview();
    else if (custodyState.tab === "assets") await renderCustodyAssets();
    else if (custodyState.tab === "conversions") await renderCustodyConversions();
    else if (custodyState.tab === "payouts") await renderCustodyPayouts();
    else if (custodyState.tab === "transactions") await renderCustodyTransactions();
  }

  async function renderCustodyOverview() {
    const target = $("#custody-body");
    if (!target) return;
    target.innerHTML = loading();
    let data;
    try {
      data = (await GET("/custody/overview")).data;
      custodyState.overviewData = data;
    } catch (error) {
      target.innerHTML = errorBox(error);
      return;
    }

    const cap = data.capabilities || {};
    const sum = data.localSummary || {};
    const capPill = (enabled, labelOn = "Enabled", labelOff = "Disabled") =>
      `<span class="pill ${enabled ? "green" : "gray"}">${esc(enabled ? labelOn : labelOff)}</span>`;

    target.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi">
          <div class="label">Provider API Health</div>
          <div class="value">${pill(data.providerHealth?.status || "down")}</div>
          <div class="foot">${esc(data.providerHealth?.message || "—")} · Synced ${dateFmt(data.lastSyncedAt)}</div>
        </div>
        <div class="kpi">
          <div class="label">Dynamic Asset Catalog</div>
          <div class="value">${num(data.catalogAssetsCount)} <span class="unit">assets</span></div>
          <div class="foot">${num(data.catalogGroupsCount)} base cryptocurrencies · ${num(data.totalTrackedAssets)} Custody wallets</div>
        </div>
        <div class="kpi">
          <div class="label">Completed Deposits</div>
          <div class="value">${money(sum.finishedToman || 0)}</div>
          <div class="foot">${num(sum.finishedCount || 0)} credited NOWPayments invoices</div>
        </div>
        <div class="kpi">
          <div class="label">Active / Warnings</div>
          <div class="value">${num(sum.pendingCount || 0)} <span class="unit">pending</span></div>
          <div class="foot">${num(sum.recoveryRequiredCount || 0)} recovery required · ${num(sum.underpaidCount || 0)} underpaid</div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-head">
            <h3>Custody Balances by Asset</h3>
            <span class="sub">Distinct assets are never summed together</span>
            <span class="spacer"></span>
            <button class="btn sm" id="custody-go-assets">View all assets</button>
          </div>
          ${data.balanceError ? `<div class="card-pad"><div class="warn-box">${esc(data.balanceError)}</div></div>` : ""}
          ${data.balances && data.balances.length ? `
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Asset</th><th>Network</th><th class="num">Available Balance</th><th class="num">Pending / Locked</th><th>Actions</th></tr></thead>
              <tbody>
                ${data.balances.map((b) => `
                  <tr>
                    <td><strong>${esc(b.ticker)}</strong> <span class="mono" style="color:var(--text-faint)">${esc(b.code)}</span></td>
                    <td><span class="pill blue">${esc(b.network)}</span></td>
                    <td class="num mono">${esc(b.availableDisplay)} ${esc(b.ticker)}</td>
                    <td class="num mono">${esc(b.pendingDisplay)} ${esc(b.ticker)}</td>
                    <td>
                      <button class="btn sm" data-quick-convert="${esc(b.code)}" ${cap.isOwner && cap.custodyJwtConfigured && b.availableAmount > 0 ? "" : "disabled"}>Convert</button>
                      <button class="btn sm" data-quick-withdraw="${esc(b.code)}" ${cap.isOwner && cap.custodyJwtConfigured && b.availableAmount > 0 ? "" : "disabled"}>Withdraw</button>
                    </td>
                  </tr>`).join("")}
              </tbody>
            </table></div>`
            : `<div class="empty">${icon("shield")} No Custody balances returned for this account yet.</div>`}
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Capabilities & Security Status</h3>
            <span class="sub">Server-side configuration & role checks</span>
          </div>
          <div class="card-pad">
            <div class="kv">
              <dt>API Key (x-api-key)</dt><dd>${capPill(cap.apiConfigured, "Configured", "Missing")}</dd>
              <dt>IPN HMAC-SHA512</dt><dd>${capPill(cap.ipnConfigured, "Configured", "Missing")}</dd>
              <dt>Custody JWT Auth</dt><dd>${capPill(cap.custodyJwtConfigured, "Configured", "Not configured")}</dd>
              <dt>Custody Balance API</dt><dd>${capPill(cap.balanceEnabled, "Active", "Unavailable")}</dd>
              <dt>Custody Conversions</dt><dd>${capPill(cap.conversionsEnabled, "Active", "Requires JWT / Custody")}</dd>
              <dt>Mass Payouts / Withdrawals</dt><dd>${capPill(cap.payoutsEnabled, "Active", "Requires JWT / Custody")}</dd>
              <dt>Current Session Role</dt><dd>${cap.isOwner ? `<span class="pill green">Owner (Full Custody Control)</span>` : `<span class="pill yellow">Admin (Read-Only Custody)</span>`}</dd>
            </div>
            ${!cap.custodyJwtConfigured ? `<div class="warn-box" style="margin-top:12px">To enable in-panel Custody conversions and withdrawals, set <span class="mono">NOWPAYMENTS_EMAIL</span> and <span class="mono">NOWPAYMENTS_PASSWORD</span> in server environment variables.</div>` : ""}
          </div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-head">
            <h3>Reconciliation Warnings</h3>
            <span class="sub">Underpayments, unknown creations & recovery items</span>
            <span class="spacer"></span>
            <button class="btn sm" id="custody-go-reconcile">Open Reconciliation</button>
          </div>
          ${data.reconciliationWarnings && data.reconciliationWarnings.length ? `
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Order ID</th><th>User</th><th>Asset</th><th class="num">Amount</th><th>Status / Reason</th></tr></thead>
              <tbody>
                ${data.reconciliationWarnings.map((w) => `
                  <tr data-payment="nowpayments:${esc(w.orderId)}">
                    <td class="mono">${esc(w.orderId.slice(0, 18))}…</td>
                    <td class="mono">${esc(w.userId)}</td>
                    <td class="mono">${esc((w.payCurrency || "trx").toUpperCase())}</td>
                    <td class="num">${money(w.amountToman)}</td>
                    <td>${pill(w.status)} <span style="font-size:11px;color:var(--text-faint)">${esc(w.reason || "")}</span></td>
                  </tr>`).join("")}
              </tbody>
            </table></div>`
            : `<div class="empty">No active NOWPayments reconciliation warnings.</div>`}
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Recent Custody Conversions & Withdrawals</h3>
            <span class="sub">Latest provider Custody activity</span>
          </div>
          <div class="card-pad">
            <div class="section-title" style="margin-bottom:8px">Recent Conversions</div>
            ${data.recentConversions && data.recentConversions.length ? `
              <div class="table-wrap"><table class="data">
                <thead><tr><th>ID</th><th>Pair</th><th class="num">From</th><th class="num">To</th><th>Status</th></tr></thead>
                <tbody>
                  ${data.recentConversions.map((c) => `
                    <tr>
                      <td class="mono">${esc(String(c.id).slice(0, 12))}</td>
                      <td class="mono">${esc(c.fromCurrency.toUpperCase())} → ${esc(c.toCurrency.toUpperCase())}</td>
                      <td class="num mono">${esc(c.fromAmountDisplay)}</td>
                      <td class="num mono">${esc(c.toAmountDisplay)}</td>
                      <td>${pill(c.status)}</td>
                    </tr>`).join("")}
                </tbody>
              </table></div>`
              : `<div style="color:var(--text-faint);font-size:12.5px;margin-bottom:12px">${esc(data.conversionsError || "No recent conversions.")}</div>`}

            <div class="section-title" style="margin:14px 0 8px">Recent Withdrawals / Payouts</div>
            ${data.recentPayouts && data.recentPayouts.length ? `
              <div class="table-wrap"><table class="data">
                <thead><tr><th>ID</th><th>Asset</th><th class="num">Amount</th><th>Address</th><th>Status</th></tr></thead>
                <tbody>
                  ${data.recentPayouts.map((p) => `
                    <tr>
                      <td class="mono">${esc(String(p.id).slice(0, 12))}</td>
                      <td>${esc(p.ticker)} <span class="mono" style="color:var(--text-faint)">${esc(p.network)}</span></td>
                      <td class="num mono">${esc(p.amountDisplay)}</td>
                      <td class="mono">${esc(String(p.address).slice(0, 14))}…</td>
                      <td>${pill(p.status)}</td>
                    </tr>`).join("")}
                </tbody>
              </table></div>`
              : `<div style="color:var(--text-faint);font-size:12.5px">${esc(data.payoutsError || "No recent payouts.")}</div>`}
          </div>
        </div>
      </div>`;

    const goAssets = $("#custody-go-assets");
    if (goAssets) goAssets.onclick = () => { custodyState.tab = "assets"; pageCustody(); };
    const goReconcile = $("#custody-go-reconcile");
    if (goReconcile) goReconcile.onclick = () => { custodyState.tab = "transactions"; pageCustody(); };

    target.querySelectorAll("tr[data-payment]").forEach((row) => {
      row.onclick = () => showPayment(row.dataset.payment);
    });
    target.querySelectorAll("[data-quick-convert]").forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => openConversionModal(btn.dataset.quickConvert);
    });
    target.querySelectorAll("[data-quick-withdraw]").forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => openWithdrawalModal(btn.dataset.quickWithdraw);
    });
  }

  async function renderCustodyAssets() {
    const target = $("#custody-body");
    if (!target) return;
    const q = custodyState.assets;
    target.innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <input id="ca-search" class="input search" placeholder="Search asset code, ticker, name, or network (e.g. usdttrc20, trx, btc)…" value="${esc(q.search)}" />
          <select id="ca-network" class="select">
            <option value="all">Network: all</option>
          </select>
          <select id="ca-filter" class="select">
            <option value="all">Filter: all assets</option>
            <option value="with-balance">With Custody balance</option>
            <option value="pending">With pending balance</option>
            <option value="fixed-rate">Fixed-rate supported</option>
          </select>
          <button class="btn sm" id="ca-refresh">${icon("refresh")} Refresh catalog</button>
        </div>
        <div id="ca-table">${loading()}</div>
      </div>`;
    $("#ca-filter").value = q.filter;
    $("#ca-search").oninput = debounce((e) => { q.search = e.target.value; q.page = 1; loadCustodyAssetsTable(false); }, 300);
    $("#ca-network").onchange = (e) => { q.network = e.target.value; q.page = 1; loadCustodyAssetsTable(false); };
    $("#ca-filter").onchange = (e) => { q.filter = e.target.value; q.page = 1; loadCustodyAssetsTable(false); };
    $("#ca-refresh").onclick = () => loadCustodyAssetsTable(true);
    await loadCustodyAssetsTable(false);
  }

  async function loadCustodyAssetsTable(forceRefresh = false) {
    const target = $("#ca-table");
    if (!target) return;
    target.innerHTML = loading();
    const q = custodyState.assets;
    const params = new URLSearchParams({
      search: q.search,
      network: q.network,
      filter: q.filter,
      page: q.page,
      pageSize: 20,
      ...(forceRefresh ? { refresh: "true" } : {}),
    });
    let data;
    try {
      data = (await GET(`/custody/assets?${params}`)).data;
    } catch (error) {
      target.innerHTML = errorBox(error);
      return;
    }

    const netSelect = $("#ca-network");
    if (netSelect && Array.isArray(data.networks)) {
      const current = q.network || "all";
      netSelect.innerHTML = `<option value="all">Network: all</option>` +
        data.networks.map((net) => `<option value="${esc(net)}" ${current.toUpperCase() === net ? "selected" : ""}>Network: ${esc(net)}</option>`).join("");
    }

    if (!data.items.length) {
      target.innerHTML = `<div class="empty">${icon("shield")} No assets match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "custodyAssets");
      bindPagers();
      return;
    }

    target.innerHTML = `
      ${data.balanceError ? `<div class="card-pad"><div class="warn-box">Custody balance note: ${esc(data.balanceError)}</div></div>` : ""}
      <div class="table-wrap"><table class="data">
        <thead>
          <tr>
            <th>Code</th>
            <th>Ticker / Name</th>
            <th>Network</th>
            <th class="num">Available Balance</th>
            <th class="num">Pending / Locked</th>
            <th class="num">Min Amount</th>
            <th>Capabilities</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${data.items.map((item) => `
            <tr>
              <td class="mono">${esc(item.code)}</td>
              <td><strong>${esc(item.ticker)}</strong> <span style="color:var(--text-faint);font-size:12px">${esc(item.name)}</span></td>
              <td><span class="pill blue">${esc(item.network)}</span></td>
              <td class="num mono">${item.availableDisplay != null ? `${esc(item.availableDisplay)} ${esc(item.ticker)}` : `<span style="color:var(--text-faint)">—</span>`}</td>
              <td class="num mono">${item.pendingDisplay != null ? `${esc(item.pendingDisplay)} ${esc(item.ticker)}` : `<span style="color:var(--text-faint)">—</span>`}</td>
              <td class="num mono">${item.minAmount != null ? esc(String(item.minAmount)) : "—"}</td>
              <td>
                ${item.supportedActions?.acceptPayment ? `<span class="pill green">Checkout</span>` : ""}
                ${item.fixedRateSupported ? `<span class="pill blue">Fixed-rate</span>` : ""}
                ${item.extraIdExists ? `<span class="pill yellow">Memo/Tag</span>` : ""}
              </td>
              <td>${dateShort(item.lastUpdatedAt)}</td>
              <td>
                <button class="btn sm" data-asset-convert="${esc(item.code)}" ${item.supportedActions?.convert ? "" : "disabled"}>Convert</button>
                <button class="btn sm" data-asset-withdraw="${esc(item.code)}" ${item.supportedActions?.withdraw ? "" : "disabled"}>Withdraw</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "custodyAssets")}`;

    PAGER_HANDLERS.custodyAssets = (page) => { custodyState.assets.page = page; loadCustodyAssetsTable(false); };
    bindPagers();
    target.querySelectorAll("[data-asset-convert]").forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => openConversionModal(btn.dataset.assetConvert);
    });
    target.querySelectorAll("[data-asset-withdraw]").forEach((btn) => {
      if (btn.disabled) return;
      btn.onclick = () => openWithdrawalModal(btn.dataset.assetWithdraw);
    });
  }

  async function renderCustodyConversions() {
    const target = $("#custody-body");
    if (!target) return;
    const q = custodyState.conversions;
    const statuses = ["all", "waiting", "processing", "finished", "failed", "rejected"];
    target.innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <div class="tabs">
            ${statuses.map((s) => `<button class="tab ${q.status === s ? "active" : ""}" data-conv-status="${s}">${s === "all" ? "All" : s}</button>`).join("")}
          </div>
          <span class="spacer"></span>
          <button class="btn primary sm" id="btn-new-conversion">🔄 New Custody Conversion</button>
        </div>
        <div class="filter-bar">
          <input id="conv-search" class="input search" placeholder="Search conversion ID, source or destination currency…" value="${esc(q.search)}" />
        </div>
        <div id="conv-table">${loading()}</div>
      </div>`;

    $$("#custody-body [data-conv-status]").forEach((tab) => {
      tab.onclick = () => { q.status = tab.dataset.convStatus; q.page = 1; renderCustodyConversions(); };
    });
    $("#conv-search").oninput = debounce((e) => { q.search = e.target.value; q.page = 1; loadCustodyConversionsTable(); }, 300);
    $("#btn-new-conversion").onclick = () => openConversionModal("");
    await loadCustodyConversionsTable();
  }

  async function loadCustodyConversionsTable() {
    const target = $("#conv-table");
    if (!target) return;
    target.innerHTML = loading();
    const q = custodyState.conversions;
    const params = new URLSearchParams({ status: q.status, search: q.search, page: q.page, pageSize: 15 });
    let data;
    try {
      data = (await GET(`/custody/conversions?${params}`)).data;
    } catch (error) {
      target.innerHTML = errorBox(error);
      return;
    }

    if (data.capabilityDisabled) {
      target.innerHTML = `<div class="card-pad"><div class="warn-box"><strong>Custody Conversions Status:</strong> ${esc(data.capabilityReason)}</div></div>`;
      return;
    }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">No Custody conversions match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "custodyConv");
      bindPagers();
      return;
    }

    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Conversion ID</th><th>From Asset</th><th>To Asset</th><th class="num">From Amount</th><th class="num">To Amount</th><th class="num">Rate</th><th>Created</th><th>Status</th></tr></thead>
        <tbody>
          ${data.items.map((c) => `
            <tr>
              <td class="mono">${esc(c.id)}</td>
              <td class="mono">${esc(c.fromCurrency.toUpperCase())}</td>
              <td class="mono">${esc(c.toCurrency.toUpperCase())}</td>
              <td class="num mono">${esc(c.fromAmountDisplay)}</td>
              <td class="num mono">${esc(c.toAmountDisplay)}</td>
              <td class="num mono">${c.rate != null ? esc(String(c.rate)) : "—"}</td>
              <td>${dateFmt(c.createdAt)}</td>
              <td>${pill(c.status)}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "custodyConv")}`;
    PAGER_HANDLERS.custodyConv = (page) => { custodyState.conversions.page = page; loadCustodyConversionsTable(); };
    bindPagers();
  }

  function openConversionModal(defaultFrom = "") {
    openModal({
      title: "Custody Asset Conversion",
      bodyHtml: `
        <div class="warn-box">Conversions execute inside your NOWPayments Custody account. Preview the live estimate before confirming. (Owner only)</div>
        <div class="field">
          <label>From Currency Code (e.g. trx, usdttrc20)</label>
          <input class="input mono" name="fromCurrency" id="conv-from" value="${esc(defaultFrom)}" placeholder="trx" required />
        </div>
        <div class="field">
          <label>To Currency Code (e.g. usdttrc20, btc)</label>
          <input class="input mono" name="toCurrency" id="conv-to" placeholder="usdttrc20" required />
        </div>
        <div class="field">
          <label>Amount to Convert</label>
          <input class="input mono" name="amount" id="conv-amt" type="number" step="any" min="0.000001" placeholder="100" required />
        </div>
        <div style="margin:10px 0">
          <button type="button" class="btn sm" id="btn-preview-conv">🔍 Preview Live Estimate</button>
        </div>
        <div id="conv-preview-box"></div>
        ${reasonField("Recorded in the immutable admin audit log.")}`,
      confirmText: "Confirm & Execute Conversion",
      onConfirm: async (values) => {
        try {
          const result = (await POST("/custody/conversions", {
            operationId: newOperationId(),
            fromCurrency: values.fromCurrency,
            toCurrency: values.toCurrency,
            amount: Number(values.amount),
            reason: values.reason,
          })).data;
          toast("success", `Conversion submitted (ID: ${result.id || "created"}).`);
          closeModal();
          if (custodyState.tab === "conversions") loadCustodyConversionsTable();
          else if (custodyState.tab === "overview") renderCustodyOverview();
        } catch (error) {
          toast("error", error.message);
        }
      },
    });

    const previewBtn = $("#btn-preview-conv");
    if (previewBtn) {
      previewBtn.onclick = async () => {
        const box = $("#conv-preview-box");
        const fromCurrency = $("#conv-from")?.value.trim();
        const toCurrency = $("#conv-to")?.value.trim();
        const amount = $("#conv-amt")?.value.trim();
        if (!fromCurrency || !toCurrency || !amount) {
          toast("error", "Enter source currency, destination currency, and amount first.");
          return;
        }
        box.innerHTML = loading();
        try {
          const prev = (await POST("/custody/conversions/preview", {
            fromCurrency,
            toCurrency,
            amount: Number(amount),
          })).data;
          box.innerHTML = `
            <div class="card" style="padding:10px;margin:8px 0;background:var(--bg-soft)">
              <div class="kv">
                <dt>Pair</dt><dd class="mono">${esc(prev.fromTicker)} (${esc(prev.fromNetwork)}) → ${esc(prev.toTicker)} (${esc(prev.toNetwork)})</dd>
                <dt>From Amount</dt><dd class="mono">${esc(String(prev.fromAmount))} ${esc(prev.fromTicker)}</dd>
                <dt>Estimated Output</dt><dd class="mono"><strong>${esc(String(prev.estimatedToAmount))} ${esc(prev.toTicker)}</strong></dd>
                <dt>Implied Rate</dt><dd class="mono">1 ${esc(prev.fromTicker)} ≈ ${esc(String(prev.impliedRate))} ${esc(prev.toTicker)}</dd>
                <dt>Available Balance</dt><dd class="mono">${prev.availableBalance != null ? `${esc(String(prev.availableBalance))} ${esc(prev.fromTicker)}` : "—"}</dd>
              </div>
            </div>`;
        } catch (error) {
          box.innerHTML = `<div class="danger-box">${esc(error.message)}</div>`;
        }
      };
    }
  }

  async function renderCustodyPayouts() {
    const target = $("#custody-body");
    if (!target) return;
    const q = custodyState.payouts;
    const statuses = ["all", "creating", "waiting", "processing", "sending", "finished", "failed", "rejected"];
    target.innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <div class="tabs">
            ${statuses.map((s) => `<button class="tab ${q.status === s ? "active" : ""}" data-payout-status="${s}">${s === "all" ? "All" : s}</button>`).join("")}
          </div>
          <span class="spacer"></span>
          <button class="btn sm" id="btn-verify-payout-modal">🔐 Verify 2FA Batch</button>
          <button class="btn primary sm" id="btn-new-payout">📤 New Withdrawal / Payout</button>
        </div>
        <div class="filter-bar">
          <input id="po-search" class="input search" placeholder="Search payout ID, batch ID, address, tx hash, or currency…" value="${esc(q.search)}" />
        </div>
        <div id="po-table">${loading()}</div>
      </div>`;

    $$("#custody-body [data-payout-status]").forEach((tab) => {
      tab.onclick = () => { q.status = tab.dataset.payoutStatus; q.page = 1; renderCustodyPayouts(); };
    });
    $("#po-search").oninput = debounce((e) => { q.search = e.target.value; q.page = 1; loadCustodyPayoutsTable(); }, 300);
    $("#btn-new-payout").onclick = () => openWithdrawalModal("");
    $("#btn-verify-payout-modal").onclick = () => openVerifyPayoutModal("");
    await loadCustodyPayoutsTable();
  }

  async function loadCustodyPayoutsTable() {
    const target = $("#po-table");
    if (!target) return;
    target.innerHTML = loading();
    const q = custodyState.payouts;
    const params = new URLSearchParams({ status: q.status, search: q.search, page: q.page, pageSize: 15 });
    let data;
    try {
      data = (await GET(`/custody/payouts?${params}`)).data;
    } catch (error) {
      target.innerHTML = errorBox(error);
      return;
    }

    if (data.capabilityDisabled) {
      target.innerHTML = `<div class="card-pad"><div class="warn-box"><strong>Custody Payouts Status:</strong> ${esc(data.capabilityReason)}</div></div>`;
      return;
    }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">No Custody withdrawals match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "custodyPayouts");
      bindPagers();
      return;
    }

    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Payout / Batch ID</th><th>Asset & Network</th><th class="num">Amount</th><th class="num">Fee</th><th>Destination Address</th><th>Tx Hash</th><th>Created</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>
          ${data.items.map((p) => `
            <tr>
              <td class="mono">${esc(p.id)}${p.batchWithdrawalId ? `<div style="font-size:11px;color:var(--text-faint)">batch: ${esc(p.batchWithdrawalId)}</div>` : ""}</td>
              <td><strong>${esc(p.ticker)}</strong> <span class="pill blue">${esc(p.network)}</span></td>
              <td class="num mono">${esc(p.amountDisplay)}</td>
              <td class="num mono">${p.fee != null ? esc(String(p.fee)) : "—"}</td>
              <td class="mono">${esc(p.address)}${p.extraId ? `<div style="font-size:11px;color:var(--text-faint)">memo: ${esc(p.extraId)}</div>` : ""}</td>
              <td class="mono">${p.hash ? esc(String(p.hash).slice(0, 14)) + "…" : "—"}</td>
              <td>${dateFmt(p.createdAt)}</td>
              <td>${pill(p.status)}</td>
              <td>
                ${p.batchWithdrawalId && (p.status === "creating" || p.status === "waiting")
                  ? `<button class="btn sm" data-verify-batch="${esc(p.batchWithdrawalId)}">Verify 2FA</button>`
                  : "—"}
              </td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "custodyPayouts")}`;
    PAGER_HANDLERS.custodyPayouts = (page) => { custodyState.payouts.page = page; loadCustodyPayoutsTable(); };
    bindPagers();
    target.querySelectorAll("[data-verify-batch]").forEach((btn) => {
      btn.onclick = () => openVerifyPayoutModal(btn.dataset.verifyBatch);
    });
  }

  function openWithdrawalModal(defaultCurrency = "") {
    openModal({
      title: "Custody Withdrawal / Payout",
      bodyHtml: `
        <div class="danger-box">Blockchain withdrawals are irreversible once verified. Validate the destination address and network fee before submitting. (Owner only)</div>
        <div class="field">
          <label>Currency Code (e.g. trx, usdttrc20, btc)</label>
          <input class="input mono" name="currency" id="po-currency" value="${esc(defaultCurrency)}" placeholder="trx" required />
        </div>
        <div class="field">
          <label>Destination Wallet Address</label>
          <input class="input mono" name="address" id="po-address" placeholder="Destination address on the selected network" required />
        </div>
        <div class="field">
          <label>Extra ID / Memo / Destination Tag (if required by network)</label>
          <input class="input mono" name="extraId" id="po-extra" placeholder="Optional" />
        </div>
        <div class="field">
          <label>Withdrawal Amount</label>
          <input class="input mono" name="amount" id="po-amount" type="number" step="any" min="0.000001" placeholder="50" required />
        </div>
        <div style="margin:10px 0">
          <button type="button" class="btn sm" id="btn-check-payout">✔ Validate Address & Estimate Fee</button>
        </div>
        <div id="po-check-box"></div>
        ${reasonField("Required audit reason for this withdrawal.")}`,
      confirmText: "Submit Withdrawal",
      danger: true,
      onConfirm: async (values) => {
        try {
          const result = (await POST("/custody/payouts", {
            operationId: newOperationId(),
            currency: values.currency,
            address: values.address,
            extraId: values.extraId || null,
            amount: Number(values.amount),
            reason: values.reason,
          })).data;
          toast("success", `Withdrawal created (ID: ${result.id || "submitted"}).`);
          closeModal();
          if (result.batchWithdrawalId) {
            openVerifyPayoutModal(result.batchWithdrawalId);
          } else if (custodyState.tab === "payouts") {
            loadCustodyPayoutsTable();
          }
        } catch (error) {
          toast("error", error.message);
        }
      },
    });

    const checkBtn = $("#btn-check-payout");
    if (checkBtn) {
      checkBtn.onclick = async () => {
        const box = $("#po-check-box");
        const currency = $("#po-currency")?.value.trim();
        const address = $("#po-address")?.value.trim();
        const extraId = $("#po-extra")?.value.trim();
        const amount = $("#po-amount")?.value.trim();
        if (!currency || !address || !amount) {
          toast("error", "Enter currency, address, and amount first.");
          return;
        }
        box.innerHTML = loading();
        try {
          const [addrRes, feeRes] = await Promise.all([
            POST("/custody/payouts/validate-address", { currency, address, extraId: extraId || null }),
            GET(`/custody/payouts/fee?currency=${encodeURIComponent(currency)}&amount=${encodeURIComponent(amount)}`),
          ]);
          const v = addrRes.data;
          const f = feeRes.data;
          box.innerHTML = `
            <div class="card" style="padding:10px;margin:8px 0;background:var(--bg-soft)">
              <div class="kv">
                <dt>Address Validation</dt><dd><span class="pill green">Valid (${esc(v.ticker)} on ${esc(v.network)})</span></dd>
                <dt>Destination</dt><dd class="mono">${esc(v.address)}</dd>
                <dt>Amount</dt><dd class="mono">${esc(String(f.amount))} ${esc(f.ticker)}</dd>
                <dt>Estimated Network Fee</dt><dd class="mono">${f.fee != null ? `${esc(String(f.fee))} ${esc(f.ticker)}` : "—"}</dd>
                <dt>Min Withdrawal</dt><dd class="mono">${f.minAmount != null ? `${esc(String(f.minAmount))} ${esc(f.ticker)}` : "—"}</dd>
              </div>
            </div>`;
        } catch (error) {
          box.innerHTML = `<div class="danger-box">${esc(error.message)}</div>`;
        }
      };
    }
  }

  function openVerifyPayoutModal(defaultBatchId = "") {
    openModal({
      title: "Verify Batch Withdrawal (2FA)",
      bodyHtml: `
        <div class="warn-box">Enter the 2FA or email verification code issued for this NOWPayments batch withdrawal. (Owner only)</div>
        <div class="field">
          <label>Batch Withdrawal ID</label>
          <input class="input mono" name="batchId" value="${esc(defaultBatchId)}" placeholder="Batch withdrawal ID" required />
        </div>
        <div class="field">
          <label>Verification Code (2FA / Email)</label>
          <input class="input mono" name="verificationCode" placeholder="123456" required />
        </div>
        ${reasonField("Audit note for payout verification.")}`,
      confirmText: "Verify Payout",
      onConfirm: async (values) => {
        try {
          await POST(`/custody/payouts/${encodeURIComponent(values.batchId.trim())}/verify`, {
            operationId: newOperationId(),
            verificationCode: values.verificationCode.trim(),
            reason: values.reason,
          });
          toast("success", "Batch payout verified.");
          closeModal();
          if (custodyState.tab === "payouts") loadCustodyPayoutsTable();
        } catch (error) {
          toast("error", error.message);
        }
      },
    });
  }

  async function renderCustodyTransactions() {
    const target = $("#custody-body");
    if (!target) return;
    const q = custodyState.transactions;
    const statuses = ["all", "pending", "waiting", "confirming", "partially_paid", "finished", "failed", "expired", "refunded", "recovery-required", "underpaid", "overpaid"];
    target.innerHTML = `
      <div class="card">
        <div class="filter-bar">
          <div class="tabs">
            ${statuses.map((s) => `<button class="tab ${q.status === s ? "active" : ""}" data-tx-status="${s}">${s === "all" ? "All" : s.replace("_", " ")}</button>`).join("")}
          </div>
          <span class="spacer"></span>
          <button class="btn primary sm" id="btn-run-reconcile">${icon("refresh")} Run Read-Only Reconciliation</button>
        </div>
        <div class="filter-bar">
          <input id="tx-search" class="input search" placeholder="Search order ID, invoice ID, payment ID, Telegram ID, or currency…" value="${esc(q.search)}" />
        </div>
        <div id="reconcile-results"></div>
        <div id="tx-table">${loading()}</div>
      </div>`;

    $$("#custody-body [data-tx-status]").forEach((tab) => {
      tab.onclick = () => { q.status = tab.dataset.txStatus; q.page = 1; renderCustodyTransactions(); };
    });
    $("#tx-search").oninput = debounce((e) => { q.search = e.target.value; q.page = 1; loadCustodyTransactionsTable(); }, 300);
    $("#btn-run-reconcile").onclick = () => runCustodyReconciliation();
    await loadCustodyTransactionsTable();
  }

  async function runCustodyReconciliation() {
    const box = $("#reconcile-results");
    if (!box) return;
    box.innerHTML = `<div class="card-pad">${loading()}</div>`;
    try {
      const report = (await POST("/custody/reconcile", { limit: 20 })).data;
      const discrepancies = (report.findings || []).filter((f) => f.classification !== "in_sync");
      box.innerHTML = `
        <div class="card-pad" style="border-bottom:1px solid var(--border)">
          <div class="section-title">Read-Only Reconciliation Report (${dateFmt(report.checkedAt)})</div>
          <div style="font-size:12.5px;color:var(--text-dim);margin:6px 0 10px">
            Checked ${num(report.checkedCount)} recent invoices against live NOWPayments status · Found <strong>${num(report.discrepancyCount)}</strong> discrepancy item(s). User balances were not modified during this read-only check.
          </div>
          ${discrepancies.length ? `
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Order ID</th><th>Payment ID</th><th>Local Status</th><th>Provider Status</th><th>Classification</th><th>Detail</th><th>Action</th></tr></thead>
              <tbody>
                ${discrepancies.map((d) => `
                  <tr>
                    <td class="mono">${esc(d.orderId)}</td>
                    <td class="mono">${esc(d.paymentId || "—")}</td>
                    <td>${pill(d.localStatus)}</td>
                    <td>${d.providerStatus ? pill(d.providerStatus) : "—"}</td>
                    <td><span class="pill ${d.severity === "critical" ? "red" : "yellow"}">${esc(d.classification)}</span></td>
                    <td style="font-size:12px">${esc(d.detail)}</td>
                    <td><button class="btn sm" data-inspect-payment="${esc(d.correctiveActionKey)}">Inspect & Resolve</button></td>
                  </tr>`).join("")}
              </tbody>
            </table></div>`
            : `<div class="pill green">All checked records are in sync with NOWPayments.</div>`}
        </div>`;
      box.querySelectorAll("[data-inspect-payment]").forEach((btn) => {
        btn.onclick = () => showPayment(btn.dataset.inspectPayment);
      });
    } catch (error) {
      box.innerHTML = `<div class="card-pad">${errorBox(error)}</div>`;
    }
  }

  async function loadCustodyTransactionsTable() {
    const target = $("#tx-table");
    if (!target) return;
    target.innerHTML = loading();
    const q = custodyState.transactions;
    const params = new URLSearchParams({ status: q.status, search: q.search, page: q.page, pageSize: 15 });
    let data;
    try {
      data = (await GET(`/custody/transactions?${params}`)).data;
    } catch (error) {
      target.innerHTML = errorBox(error);
      return;
    }
    if (!data.items.length) {
      target.innerHTML = `<div class="empty">No NOWPayments transactions match these filters.</div>` + pagerHtml(data.page, data.pages, data.total, "custodyTx");
      bindPagers();
      return;
    }
    target.innerHTML = `
      <div class="table-wrap"><table class="data">
        <thead>
          <tr>
            <th>Order ID</th>
            <th>Invoice / Payment ID</th>
            <th>User</th>
            <th>Asset / Network</th>
            <th class="num">Amount (Toman)</th>
            <th class="num">USD Price</th>
            <th class="num">Pay / Paid Crypto</th>
            <th>Credited</th>
            <th>Created</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.items.map((tx) => `
            <tr data-payment="${esc(tx.key)}">
              <td class="mono">${esc(tx.orderId.slice(0, 18))}…</td>
              <td class="mono">${esc(tx.invoiceId || "—")} / ${esc(tx.paymentId || "—")}</td>
              <td class="mono">${esc(tx.userId)}</td>
              <td><strong>${esc(tx.ticker)}</strong> <span class="pill blue">${esc(tx.network)}</span></td>
              <td class="num">${money(tx.amountToman)}</td>
              <td class="num mono">$${tx.priceAmountUsd != null ? esc(String(tx.priceAmountUsd)) : "—"}</td>
              <td class="num mono">${tx.actuallyPaid != null ? esc(String(tx.actuallyPaid)) : "0"} / ${tx.payAmount != null ? esc(String(tx.payAmount)) : (tx.estimatedPayAmount != null ? `~${esc(String(tx.estimatedPayAmount))}` : "—")} ${esc(tx.ticker)}</td>
              <td>${tx.balanceCredited ? `<span class="pill green">Yes</span>` : `<span class="pill gray">No</span>`}</td>
              <td>${dateShort(tx.createdAt)}</td>
              <td>${pill(tx.status)}${tx.recoveryStatus === "required" ? ` <span class="pill red">recovery</span>` : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>
      ${pagerHtml(data.page, data.pages, data.total, "custodyTx")}`;
    PAGER_HANDLERS.custodyTx = (page) => { custodyState.transactions.page = page; loadCustodyTransactionsTable(); };
    bindPagers();
    target.querySelectorAll("tr[data-payment]").forEach((row) => {
      row.onclick = () => showPayment(row.dataset.payment);
    });
  }

  // ── Mock tests ─────────────────────────────────────────────────────────────
  // Results come from the isolated harness (in-memory data, simulated
  // providers); the server refuses runs unless MOCK_TESTS_ENABLED=true.
  const mockStatusClass = (status) => String(status || "NOT RUN").replace(/\s+/g, "-");
  const mockBadge = (status) => `<span class="mock-status ${esc(mockStatusClass(status))}" data-no-i18n>${esc(status || "NOT RUN")}</span>`;
  let mockRunning = false;

  async function pageMockTests() {
    $("#content").innerHTML = `
      <div class="card card-pad mock-banner" style="margin-bottom:16px">${icon("shield")}
        <div>
          <strong>Isolated test harness</strong>
          <div style="color:var(--text-dim);font-size:13px;margin-top:4px;line-height:1.7">Scenarios run the real purchase, payment and test-service logic against in-memory data and simulated providers. No payment, wallet credit, blockchain transfer or VPN service is created, and results are kept apart from revenue, balances and transaction history.</div>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-head">
          <h3>Scenarios</h3><span class="sub" id="mock-enabled"></span>
          <span class="spacer"></span>
          <button class="btn primary sm" id="mock-run-all" type="button" disabled>${icon("refresh")} Run all scenarios</button>
        </div>
        <div class="card-pad" id="mock-scenarios">${loading()}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Run history</h3><span class="sub">Most recent runs</span></div>
        <div id="mock-history">${loading()}</div>
      </div>`;
    await loadMockTests();
  }

  async function loadMockTests() {
    if (!$("#mock-scenarios")) return;
    let data;
    try { data = (await GET("/mock-tests?limit=10")).data; }
    catch (error) { $("#mock-scenarios").innerHTML = errorBox(error); $("#mock-history").innerHTML = ""; return; }
    if (!$("#mock-scenarios")) return;
    const latest = data.items[0];
    const lastById = new Map((latest?.scenarios || []).map((scenario) => [scenario.id, scenario]));
    const canRun = data.enabled && !data.running && !mockRunning;
    $("#mock-enabled").textContent = data.enabled ? t("Enabled on this server") : t("Disabled on this server (MOCK_TESTS_ENABLED)");
    const runAll = $("#mock-run-all");
    runAll.disabled = !canRun;
    runAll.onclick = () => runMock("all");
    $("#mock-scenarios").innerHTML = `<div class="mock-scenarios">${data.scenarios.map((scenario) => {
      const last = lastById.get(scenario.id);
      const title = lang() === "fa" ? scenario.titleFa : scenario.title;
      const counts = last?.counts?.total
        ? t("{passed}/{total} assertions passed", { passed: num(last.counts.passed), total: num(last.counts.total - last.counts.skipped) })
          + (last.counts.skipped ? ` · ${t("{n} skipped", { n: num(last.counts.skipped) })}` : "")
        : t("Not run yet");
      return `<div class="mock-scenario">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><h4 data-no-i18n>${esc(title)}</h4>${mockBadge(last?.status)}</div>
          <div class="meta">${esc(counts)}</div>
          ${last?.explanation && last.status !== "PASS" ? `<div class="meta" style="color:var(--on-red)" data-no-i18n>${esc(last.explanation)}</div>` : ""}
          <button class="btn sm" type="button" data-mock-run="${esc(scenario.id)}" ${canRun ? "" : "disabled"}>${icon("refresh")} Run</button>
        </div>`;
    }).join("")}</div>`;
    $$("[data-mock-run]").forEach((button) => { button.onclick = () => runMock(button.dataset.mockRun); });

    if (!data.items.length) {
      $("#mock-history").innerHTML = `<div class="empty">${icon("inbox")} No mock-test runs yet.</div>`;
      return;
    }
    $("#mock-history").innerHTML = `
      ${data.source === "memory" ? `<div class="card-pad" style="padding-bottom:0"><div class="warn-box">${icon("alert")} Report history is unavailable from the database; showing runs kept in memory since the last restart.</div></div>` : ""}
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Run</th><th>Started</th><th>Admin</th><th>Source</th><th>Result</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Blocked</th></tr></thead>
        <tbody>${data.items.map((run) => `
          <tr data-mock-report="${esc(run.runId)}" tabindex="0" style="cursor:pointer">
            <td class="mono">${esc(run.runId)}</td>
            <td>${dateFmt(run.startedAt)}</td>
            <td class="mono">${esc(run.actorTelegramId)}</td>
            <td>${esc(run.trigger)}</td>
            <td>${mockBadge(run.summary?.overall)}</td>
            <td class="num">${num(run.summary?.PASS || 0)}</td>
            <td class="num">${num(run.summary?.FAIL || 0)}</td>
            <td class="num">${num(run.summary?.BLOCKED || 0)}</td>
          </tr>`).join("")}</tbody>
      </table></div>`;
    $$("[data-mock-report]").forEach((row) => {
      row.onclick = () => showMockReport(row.dataset.mockReport);
      row.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showMockReport(row.dataset.mockReport); } };
    });
  }

  async function runMock(target) {
    if (mockRunning) return;
    mockRunning = true;
    $$("#content [data-mock-run], #mock-run-all").forEach((button) => { button.disabled = true; });
    const runAll = $("#mock-run-all");
    if (runAll && target === "all") runAll.innerHTML = `<span class="btn-spinner" aria-hidden="true"></span> ${esc(t("Running…"))}`;
    try {
      const report = (await POST("/mock-tests/run", { scenarios: target === "all" ? "all" : [target] })).data;
      toast(report.summary.overall === "PASS" ? "success" : "error", t("Mock run finished: {result}", { result: report.summary.overall }));
      showMockReportData(report);
    } catch (error) {
      apiErrorToast(error);
    } finally {
      mockRunning = false;
      if (state.route === "mock") {
        if ($("#mock-run-all")) $("#mock-run-all").innerHTML = `${icon("refresh")} ${esc(t("Run all scenarios"))}`;
        loadMockTests();
      }
    }
  }

  async function showMockReport(runId) {
    openDrawer(t("Mock-test report"), runId, loading());
    try { showMockReportData((await GET(`/mock-tests/${encodeURIComponent(runId)}`)).data); }
    catch (error) { openDrawer(t("Mock-test report"), runId, errorBox(error)); }
  }

  function showMockReportData(report) {
    const mark = { pass: "✓", fail: "✗", skipped: "↷" };
    const scenarios = (report.scenarios || []).map((scenario) => {
      const title = lang() === "fa" ? scenario.titleFa : scenario.title;
      const assertions = scenario.assertions || [];
      return `
        <div class="card card-pad" style="margin-top:12px">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
            <strong data-no-i18n>${esc(title)}</strong>${mockBadge(scenario.status)}
          </div>
          <div style="color:var(--text-faint);font-size:12px;margin-top:6px">
            ${scenario.startedAt ? `${esc(dateFmt(scenario.startedAt))} → ${esc(dateFmt(scenario.completedAt))} · ${esc(num(scenario.durationMs || 0))} ms` : esc(t("Not executed"))}
          </div>
          ${scenario.explanation ? `<div class="${scenario.status === "PASS" ? "" : "danger-box"}" style="margin-top:10px" data-no-i18n>${esc(scenario.explanation)}</div>` : ""}
          ${scenario.error ? `<div class="mono" style="margin-top:8px;color:var(--on-red)">${esc(scenario.error)}</div>` : ""}
          ${(scenario.isolationViolations || []).length ? `<div class="danger-box" style="margin-top:8px" data-no-i18n>Isolation violations: ${esc(scenario.isolationViolations.join(", "))}</div>` : ""}
          ${(scenario.notes || []).map((note) => `<div style="margin-top:8px;color:var(--text-dim);font-size:12.5px" data-no-i18n>${esc(note)}</div>`).join("")}
          ${assertions.length ? `<ul class="assert-list" style="margin-top:10px" data-no-i18n>${assertions.map((entry) => `
            <li class="${esc(entry.status)}"><span class="mark" aria-label="${esc(entry.status)}">${mark[entry.status] || "•"}</span>
              <span>${esc(entry.name)}${entry.detail ? `<span class="detail">${esc(entry.detail)}</span>` : ""}</span></li>`).join("")}</ul>` : ""}
        </div>`;
    }).join("");
    const s = report.summary || {};
    openDrawer(t("Mock-test report"), report.runId, `
      <div class="kv">
        <dt>Run</dt><dd class="mono">${esc(report.runId)}</dd>
        <dt>Environment</dt><dd>${esc(t("Isolated — in-memory data, simulated providers"))}</dd>
        <dt>Admin</dt><dd class="mono">${esc(report.actorTelegramId)}</dd>
        <dt>Source</dt><dd>${esc(report.trigger)}</dd>
        <dt>Started</dt><dd>${esc(dateFmt(report.startedAt))}</dd>
        <dt>Completed</dt><dd>${esc(dateFmt(report.completedAt))}</dd>
        <dt>Result</dt><dd>${mockBadge(s.overall)} <span style="color:var(--text-faint);font-size:12px">${esc(t("{pass} passed · {fail} failed · {blocked} blocked · {notRun} not run", { pass: num(s.PASS || 0), fail: num(s.FAIL || 0), blocked: num(s.BLOCKED || 0), notRun: num(s["NOT RUN"] || 0) }))}</span></dd>
      </div>
      ${report.enabled === false ? `<div class="warn-box" style="margin-top:12px">${icon("alert")} Mock testing is disabled on this server, so no scenario was executed.</div>` : ""}
      ${scenarios}`);
  }

  // ── Routing ────────────────────────────────────────────────────────────────
  const PAGES = {
    dashboard: { title: "Dashboard", render: pageDashboard },
    analytics: { title: "Analytics", render: pageAnalytics },
    users: { title: "Users", render: pageUsers },
    vpns: { title: "VPN Services", render: pageVpns },
    payments: { title: "Payments", render: pagePayments },
    recovery: { title: "Payment Recovery", render: pageRecovery },
    custody: { title: "NOWPayments & Custody", render: pageCustody },
    products: { title: "Products", render: pageProducts },
    broadcast: { title: "Broadcast", render: pageBroadcast },
    referrals: { title: "Referrals", render: pageReferrals },
    audit: { title: "Audit Log", render: pageAudit },
    admins: { title: "Admins", render: pageAdmins },
    system: { title: "System", render: pageSystem },
    mock: { title: "Mock Tests", render: pageMockTests },
  };

  async function renderRoute(refresh = false, { quiet = false } = {}) {
    const seq = ++state.renderSeq;
    const route = (location.hash.replace(/^#\//, "") || "dashboard").split("?")[0];
    const sameRoute = state.route === (PAGES[route] ? route : "dashboard");
    state.route = PAGES[route] ? route : "dashboard";
    const page = PAGES[state.route];
    $("#page-title").textContent = page.title;
    renderNav();
    clearInterval(broadcastTimer);
    const scrollY = quiet && sameRoute ? window.scrollY : null;
    state.quiet = quiet && sameRoute;
    state.rendering = true;
    updateRefreshStatus();
    try {
      await page.render(refresh);
    } finally {
      if (seq === state.renderSeq) {
        state.quiet = false;
        state.rendering = false;
        state.lastLoadedAt = Date.now();
        state.lastLoadFailed = Boolean($("#content [data-retry]"));
        updateRefreshStatus();
        if (scrollY != null) window.scrollTo({ top: scrollY });
      }
    }
    refreshRecoveryBadge().catch(() => {});
  }

  window.addEventListener("hashchange", () => renderRoute());

  // ── Data freshness & auto-refresh ──────────────────────────────────────────
  // Every page render gets a sequence number; GET responses that arrive after a
  // newer render started are dropped (see api()), so a slow, older response can
  // never overwrite newer data. Auto-refresh polls only overview-type pages,
  // only while the tab is visible and nothing is open or being edited.
  const AUTO_REFRESH_MS = 60_000;
  const AUTO_ROUTES = new Set(["dashboard", "recovery", "payments", "mock", "system"]);
  let autoTimer = null;

  function autoRefreshOn() {
    try { return localStorage.getItem("swift.autoRefresh") === "1"; } catch { return false; }
  }

  function relativeAge(ms) {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return t("just now");
    return t("{n} min ago", { n: num(minutes) });
  }

  function updateRefreshStatus() {
    const el = $("#refresh-status");
    if (!el) return;
    el.classList.remove("stale", "failed", "loading");
    if (state.rendering) {
      el.classList.add("loading");
      el.innerHTML = `<span class="dot"></span><span>${esc(t("Loading…"))}</span>`;
      return;
    }
    if (!state.lastLoadedAt) { el.innerHTML = ""; return; }
    const age = Date.now() - state.lastLoadedAt;
    const staleAfter = autoRefreshOn() && AUTO_ROUTES.has(state.route) ? AUTO_REFRESH_MS * 2 : 5 * 60_000;
    if (state.lastLoadFailed) el.classList.add("failed");
    else if (age > staleAfter) el.classList.add("stale");
    const label = state.lastLoadFailed
      ? t("Refresh failed")
      : age > staleAfter ? t("Stale · updated {age}", { age: relativeAge(age) }) : t("Updated {age}", { age: relativeAge(age) });
    el.innerHTML = `<span class="dot"></span><span>${esc(label)}</span>`;
    el.title = `${t("Last loaded")}: ${dateFmt(new Date(state.lastLoadedAt))}`;
  }
  setInterval(updateRefreshStatus, 15_000);

  function syncAutoButton() {
    const button = $("#btn-auto");
    if (button) button.setAttribute("aria-pressed", String(autoRefreshOn()));
  }

  function scheduleAutoRefresh() {
    clearInterval(autoTimer);
    syncAutoButton();
    if (!autoRefreshOn()) return;
    autoTimer = setInterval(() => {
      const busy = document.hidden || state.rendering || !AUTO_ROUTES.has(state.route)
        || !$("#app").classList.contains("ready")
        || $("#drawer").classList.contains("open") || $("#modal-backdrop").classList.contains("show")
        || (document.activeElement && document.activeElement.matches("input, textarea, select"));
      if (!busy) renderRoute(true, { quiet: true });
    }, AUTO_REFRESH_MS);
  }

  $("#btn-auto").onclick = () => {
    const next = !autoRefreshOn();
    try { localStorage.setItem("swift.autoRefresh", next ? "1" : "0"); } catch { /* storage blocked */ }
    toast("success", next ? t("Auto-refresh on (every 60 seconds).") : t("Auto-refresh off."));
    scheduleAutoRefresh();
    updateRefreshStatus();
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !autoRefreshOn() || !$("#app").classList.contains("ready")) return;
    if (AUTO_ROUTES.has(state.route) && state.lastLoadedAt && Date.now() - state.lastLoadedAt > AUTO_REFRESH_MS && !state.rendering) {
      renderRoute(true, { quiet: true });
    }
  });

  // ── Auth flow ──────────────────────────────────────────────────────────────
  // Two steps: Telegram ID → one-time code. Neither value is ever written to
  // the URL, browser storage or the console; errors are generic by design.
  const RESEND_COOLDOWN_S = 45; // matches the server-side per-ID issue limit
  let resendTimer = null;
  let loginTelegramId = "";

  function loginAlert(kind, message) {
    const el = $("#login-alert");
    if (!message) { el.hidden = true; el.textContent = ""; el.className = "login-alert"; return; }
    el.className = `login-alert ${kind}`;
    el.textContent = t(message);
    el.hidden = false;
  }

  function setBusy(button, busy, busyLabel) {
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
    button.innerHTML = busy
      ? `<span class="btn-spinner" aria-hidden="true"></span><span class="label">${esc(t(busyLabel))}</span>`
      : button.dataset.idleHtml;
  }

  function setLoginStep(step) {
    $("#login-form-id").hidden = step !== 1;
    $("#login-form-code").hidden = step !== 2;
    $("#login-step-1").className = step === 1 ? "active" : "done";
    $("#login-step-2").className = step === 2 ? "active" : "";
    $("#login-step-1").setAttribute("aria-current", step === 1 ? "step" : "false");
    $("#login-step-2").setAttribute("aria-current", step === 2 ? "step" : "false");
    window.setTimeout(() => (step === 1 ? $("#login-tid") : $("#login-code")).focus(), 0);
  }

  function startResendCooldown() {
    let remaining = RESEND_COOLDOWN_S;
    const button = $("#login-resend");
    clearInterval(resendTimer);
    const tick = () => {
      if (remaining <= 0) {
        clearInterval(resendTimer);
        button.disabled = false;
        button.textContent = t("Resend code");
        return;
      }
      button.disabled = true;
      button.textContent = t("Resend in {n}s", { n: num(remaining) });
      remaining -= 1;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
  }

  function authErrorMessage(error, fallback) {
    if (error?.status === 429) return "Too many attempts. Wait a minute and try again.";
    if (error?.status >= 500) return "Sign-in is temporarily unavailable. Try again shortly.";
    if (error?.status === 401) return "The sign-in code is invalid, expired, or already used.";
    return error?.status ? fallback : "Network error — check your connection and try again.";
  }

  function resetLogin() {
    clearInterval(resendTimer);
    loginTelegramId = "";
    $("#login-code").value = "";
    $("#login-tid").removeAttribute("aria-invalid");
    $("#login-code").removeAttribute("aria-invalid");
    loginAlert(null);
    setLoginStep(1);
  }

  function showLogin() {
    state.csrfToken = null;
    state.actorId = null;
    $("#app").classList.remove("ready");
    if (!$("#login").classList.contains("show") || !state.loginInitialized) {
      state.loginInitialized = true;
      $("#login").classList.add("show");
      resetLogin();
    }
    clearInterval(autoTimer);
  }

  function showApp() {
    $("#login").classList.remove("show");
    $("#app").classList.add("ready");
    $("#admin-id").textContent = state.actorId;
    $("#login-code").value = "";
    clearInterval(resendTimer);
    renderRoute();
    scheduleAutoRefresh();
  }

  async function requestLoginCode({ resend = false } = {}) {
    const input = $("#login-tid");
    const telegramId = resend ? loginTelegramId : input.value.trim();
    if (!/^[1-9]\d{4,19}$/.test(telegramId)) {
      input.setAttribute("aria-invalid", "true");
      loginAlert("error", "Enter a numeric Telegram ID.");
      if (!resend) input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    loginAlert(null);
    const button = resend ? $("#login-resend") : $("#login-request");
    setBusy(button, true, "Sending…");
    try {
      await POST("/auth/request-code", { telegramId });
      loginTelegramId = telegramId;
      $("#login-sent-id").textContent = telegramId;
      setBusy(button, false);
      if (resend) loginAlert("info", "A new code was requested. Use the most recent message from the bot.");
      else setLoginStep(2);
      startResendCooldown();
    } catch (error) {
      setBusy(button, false);
      loginAlert("error", authErrorMessage(error, "Could not request a code. Try again."));
    }
  }

  async function verifyLoginCode() {
    const input = $("#login-code");
    const code = input.value.trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) {
      input.setAttribute("aria-invalid", "true");
      loginAlert("error", "That code does not look right — paste it exactly as received.");
      input.focus();
      return;
    }
    input.removeAttribute("aria-invalid");
    loginAlert(null);
    const button = $("#login-verify");
    setBusy(button, true, "Signing in…");
    try {
      const result = await POST("/auth/verify", { code });
      state.csrfToken = result.csrfToken;
      state.actorId = result.actorTelegramId;
      setBusy(button, false);
      toast("success", t("Signed in."));
      showApp();
    } catch (error) {
      setBusy(button, false);
      input.setAttribute("aria-invalid", "true");
      loginAlert("error", authErrorMessage(error, "The sign-in code is invalid, expired, or already used."));
      input.select();
    }
  }

  $("#login-form-id").addEventListener("submit", (event) => { event.preventDefault(); requestLoginCode(); });
  $("#login-form-code").addEventListener("submit", (event) => { event.preventDefault(); verifyLoginCode(); });
  $("#login-resend").addEventListener("click", () => requestLoginCode({ resend: true }));
  $("#login-change").addEventListener("click", () => resetLogin());
  $("#login-tid").addEventListener("input", () => $("#login-tid").removeAttribute("aria-invalid"));
  $("#login-code").addEventListener("input", () => $("#login-code").removeAttribute("aria-invalid"));

  $("#btn-logout").onclick = async () => {
    try { await POST("/auth/logout", {}); } catch { /* clearing local state regardless */ }
    showLogin();
  };

  $("#btn-refresh").onclick = () => renderRoute(true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeModal(); closeDrawer(); closeNav(); }
  });

  // ── Theme, language, mobile navigation, responsive tables ────────────────────
  const currentTheme = () => (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");

  function syncControls() {
    const light = currentTheme() === "light";
    $$("[data-theme-toggle]").forEach((button) => {
      const label = light ? "Switch to dark theme" : "Switch to light theme";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.innerHTML = icon(light ? "moon" : "sun");
    });
    $$("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === lang())));
    const toggle = $("#nav-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", String($("#sidebar").classList.contains("open")));
  }

  function setTheme(theme) {
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", theme);
    try { localStorage.setItem("swift.theme", theme); } catch { /* storage blocked */ }
    window.setTimeout(() => root.classList.remove("theme-switching"), 320);
    syncControls();
    // Charts bake theme-independent colours only; grid/labels follow CSS tokens, so no re-render is needed.
  }

  function setLanguage(next) {
    if (next === lang()) return;
    I18N.setLang(next);
    syncControls();
    window.dispatchEvent(new Event("swift:langchange"));
  }

  const mobileNav = window.matchMedia("(max-width: 900px)");
  function syncNavInert() {
    const sidebar = $("#sidebar");
    if (!sidebar) return;
    const open = sidebar.classList.contains("open");
    if (mobileNav.matches && !open) sidebar.setAttribute("inert", ""); else sidebar.removeAttribute("inert");
  }
  let navOpener = null;
  function openNav() {
    navOpener = document.activeElement;
    $("#sidebar").classList.add("open");
    $("#sidebar").removeAttribute("inert");
    document.body.classList.add("nav-open");
    syncControls();
    const first = $("#sidebar .nav-item");
    if (first) window.setTimeout(() => first.focus(), 0);
  }
  function closeNav() {
    const sidebar = $("#sidebar");
    if (!sidebar || !sidebar.classList.contains("open")) return;
    sidebar.classList.remove("open");
    document.body.classList.remove("nav-open");
    syncNavInert();
    syncControls();
    if (navOpener && typeof navOpener.focus === "function") navOpener.focus();
    navOpener = null;
  }
  mobileNav.addEventListener("change", () => { if (!mobileNav.matches) closeNav(); syncNavInert(); });
  $("#nav-toggle").onclick = () => ($("#sidebar").classList.contains("open") ? closeNav() : openNav());
  $("#nav-backdrop").onclick = closeNav;

  // Keep keyboard focus inside whichever overlay is open.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const layer = document.body.classList.contains("nav-open") ? $("#sidebar")
      : $("#modal-backdrop").classList.contains("show") ? $("#modal-backdrop .modal")
      : $("#drawer").classList.contains("open") ? $("#drawer") : null;
    if (!layer) return;
    const focusable = [...layer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  $$("[data-theme-toggle]").forEach((button) => { button.onclick = () => setTheme(currentTheme() === "light" ? "dark" : "light"); });
  $$("[data-lang]").forEach((button) => { button.onclick = () => setLanguage(button.dataset.lang); });
  window.addEventListener("swift:langchange", () => {
    if ($("#app").classList.contains("ready")) { renderNav(); renderRoute(true); }
  });

  // Wide tables turn into labelled card lists on phones (CSS) - labels come from <th>.
  function enhanceTables(rootNode) {
    rootNode.querySelectorAll("table.data").forEach((table) => {
      const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      table.querySelectorAll("tbody tr").forEach((row) => {
        [...row.children].forEach((cell, index) => {
          if (cell.tagName === "TD" && !cell.hasAttribute("data-label") && headers[index]) cell.setAttribute("data-label", headers[index]);
        });
      });
      table.classList.add("stack");
    });
  }
  let enhanceQueued = false;
  new MutationObserver(() => {
    if (enhanceQueued) return;
    enhanceQueued = true;
    window.requestAnimationFrame(() => {
      enhanceQueued = false;
      ["#content", "#drawer-body", "#modal-body"].forEach((selector) => { const el = $(selector); if (el) enhanceTables(el); });
    });
  }).observe(document.body, { childList: true, subtree: true });

  // The "Try again" button carries no inline handler (strict CSP).
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry]")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  // ── Boot ───────────────────────────────────────────────────────────────────
  syncControls();
  syncNavInert();
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
