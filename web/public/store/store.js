/* ============================================================================
   SWIFT VPN storefront
   Reads the live customer catalog from /api/store/catalog, lets the visitor
   pick a plan, re-validates it on the server and hands checkout off to the
   Telegram bot (where the wallet, payment providers and order live).
   ========================================================================== */
(function () {
  "use strict";

  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  var faNumber = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
  var REQUEST_TIMEOUT_MS = 10000;
  var state = { catalog: null, duration: null, loadSeq: 0, sheetOpener: null, checkSeq: 0 };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function icon(name) { return '<svg aria-hidden="true"><use href="#s-' + name + '"/></svg>'; }
  function toman(value) { return faNumber.format(value); }
  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* storage blocked */ } }

  function getJson(url) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(url, { headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined, credentials: "omit" })
      .then(function (response) {
        return response.json().catch(function () { return null; }).then(function (body) {
          if (!response.ok || !body || body.ok !== true) {
            var error = new Error((body && body.error) || "request_failed");
            error.status = response.status;
            throw error;
          }
          return body.data;
        });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  function syncThemeButton() {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    var button = $("#theme-toggle");
    button.innerHTML = icon(light ? "moon" : "sun");
    button.setAttribute("aria-label", light ? "پوسته تیره" : "پوسته روشن");
    button.setAttribute("title", light ? "پوسته تیره" : "پوسته روشن");
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", light ? "#FAFAFA" : "#0B0F0D");
  }
  $("#theme-toggle").addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    storageSet("swift.theme", next);
    syncThemeButton();
  });
  syncThemeButton();

  // ── Catalog states ─────────────────────────────────────────────────────────
  function skeletons(count) {
    var html = "";
    for (var i = 0; i < count; i += 1) {
      html += '<div class="plan-card skeleton" aria-hidden="true"><div class="sk sk-a"></div><div class="sk sk-b"></div><div class="sk sk-c"></div><div class="sk sk-d"></div><div class="sk sk-e"></div></div>';
    }
    return html;
  }

  function showStatus(kind, message, withRetry) {
    var status = $("#plan-status");
    status.innerHTML = '<div class="notice ' + kind + '">' + (kind === "error" ? icon("alert") : "") +
      "<span>" + esc(message) + "</span>" +
      (withRetry ? '<button type="button" class="btn btn-ghost btn-sm" data-retry>' + icon("refresh") + " تلاش دوباره</button>" : "") +
      "</div>";
  }

  function loadCatalog() {
    var seq = ++state.loadSeq;
    var grid = $("#plan-grid");
    grid.setAttribute("aria-busy", "true");
    grid.innerHTML = skeletons(4);
    $("#plan-status").innerHTML = "";
    $("#duration-tabs").innerHTML = "";
    return getJson("/api/store/catalog").then(function (catalog) {
      if (seq !== state.loadSeq) return; // a newer load superseded this one
      state.catalog = catalog;
      renderLinks();
      renderPayMethods();
      if (!catalog.plans || !catalog.plans.length) {
        grid.innerHTML = "";
        grid.setAttribute("aria-busy", "false");
        showStatus("", "در حال حاضر پلنی برای فروش فعال نیست. لطفاً بعداً دوباره سر بزنید.");
        return;
      }
      var available = catalog.durations.map(function (d) { return d.days; });
      var saved = Number(storageGet("swift.store.duration"));
      state.duration = available.indexOf(saved) !== -1 ? saved : available[0];
      renderTabs();
      renderPlans();
    }).catch(function () {
      if (seq !== state.loadSeq) return;
      grid.innerHTML = "";
      grid.setAttribute("aria-busy", "false");
      showStatus("error", "دریافت فهرست پلن‌ها ممکن نشد. اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.", true);
    });
  }

  document.addEventListener("click", function (event) {
    if (event.target.closest("[data-retry]")) loadCatalog();
  });

  // ── Duration tabs (WAI-ARIA tabs pattern) ──────────────────────────────────
  function renderTabs() {
    var tabs = $("#duration-tabs");
    tabs.innerHTML = state.catalog.durations.map(function (d) {
      var selected = d.days === state.duration;
      return '<button type="button" class="tab" role="tab" id="tab-' + d.days + '" aria-controls="plan-grid" aria-selected="' + selected +
        '" tabindex="' + (selected ? "0" : "-1") + '" data-days="' + d.days + '">' + esc(d.title) +
        '<span class="tab-days">' + toman(d.days) + " روز</span></button>";
    }).join("");
    $("#plan-grid").setAttribute("role", "tabpanel");
    $("#plan-grid").setAttribute("aria-labelledby", "tab-" + state.duration);
  }

  function selectDuration(days, focus) {
    state.duration = days;
    storageSet("swift.store.duration", String(days));
    renderTabs();
    renderPlans();
    if (focus) $("#tab-" + days).focus();
  }

  $("#duration-tabs").addEventListener("click", function (event) {
    var tab = event.target.closest(".tab");
    if (tab) selectDuration(Number(tab.dataset.days), false);
  });
  $("#duration-tabs").addEventListener("keydown", function (event) {
    var list = state.catalog ? state.catalog.durations.map(function (d) { return d.days; }) : [];
    var index = list.indexOf(state.duration);
    if (index === -1) return;
    var rtl = document.documentElement.getAttribute("dir") === "rtl";
    var next = null;
    if (event.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = list[(index + 1) % list.length];
    else if (event.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = list[(index - 1 + list.length) % list.length];
    else if (event.key === "Home") next = list[0];
    else if (event.key === "End") next = list[list.length - 1];
    if (next == null) return;
    event.preventDefault();
    selectDuration(next, true);
  });

  // ── Plans ──────────────────────────────────────────────────────────────────
  function durationTitle(days) {
    var option = state.catalog.durations.filter(function (d) { return d.days === days; })[0];
    return option ? option.title : toman(days) + " روزه";
  }

  function renderPlans() {
    var grid = $("#plan-grid");
    var plans = state.catalog.plans
      .filter(function (plan) { return plan.days === state.duration; })
      .sort(function (a, b) { return a.gig - b.gig; });
    grid.setAttribute("aria-busy", "false");
    if (!plans.length) {
      grid.innerHTML = "";
      showStatus("", "برای این مدت پلن فعالی وجود ندارد.");
      return;
    }
    $("#plan-status").innerHTML = "";
    grid.innerHTML = plans.map(function (plan, index) {
      var perGb = plan.gig > 0 ? Math.round(plan.price / plan.gig) : null;
      return '<article class="plan-card" style="animation-delay:' + Math.min(index * 40, 240) + 'ms">' +
        '<div class="plan-volume">' + toman(plan.gig) + "<small>گیگابایت</small></div>" +
        '<div class="plan-duration">' + esc(durationTitle(plan.days)) + " · " + toman(plan.days) + " روز</div>" +
        '<div class="plan-price">' + toman(plan.price) + "<small>تومان</small></div>" +
        '<div class="plan-unit">' + (perGb ? "هر گیگابایت حدود " + toman(perGb) + " تومان" : "") + "</div>" +
        '<ul class="plan-features">' +
          "<li>" + icon("check") + " اتصال نامحدود کاربر</li>" +
          "<li>" + icon("check") + " " + toman(plan.days) + " روز اعتبار</li>" +
          "<li>" + icon("check") + " تحویل خودکار در تلگرام</li>" +
        "</ul>" +
        '<button type="button" class="btn btn-primary btn-block" data-plan="' + esc(plan.id) + '" aria-label="انتخاب پلن ' +
          esc(toman(plan.gig) + " گیگابایت " + durationTitle(plan.days)) + '">انتخاب این پلن</button>' +
        "</article>";
    }).join("");
  }

  $("#plan-grid").addEventListener("click", function (event) {
    var button = event.target.closest("[data-plan]");
    if (!button || !state.catalog) return;
    var plan = state.catalog.plans.filter(function (p) { return p.id === button.dataset.plan; })[0];
    if (plan) openSheet(plan, button);
  });

  // ── Payment methods / links ────────────────────────────────────────────────
  var PAY_LABELS = { hooshpay: ["card", "پرداخت آنلاین کارت به کارت"], crypto: ["coin", "پرداخت با ارز دیجیتال"] };
  function renderPayMethods() {
    var methods = (state.catalog.paymentMethods || []).filter(function (m) { return m.available && PAY_LABELS[m.id]; });
    $("#pay-methods").innerHTML = (methods.length
      ? '<span class="pay-chip">' + icon("wallet") + " شارژ کیف پول در ربات با:</span>" + methods.map(function (m) {
        return '<span class="pay-chip">' + icon(PAY_LABELS[m.id][0]) + " " + PAY_LABELS[m.id][1] + "</span>";
      }).join("")
      : '<span class="pay-chip off">' + icon("wallet") + " روش‌های پرداخت فعال در ربات نمایش داده می‌شوند</span>");
  }

  function renderLinks() {
    var checkout = state.catalog.checkout || {};
    var support = state.catalog.support || {};
    if (checkout.available && checkout.botUrl) {
      $("#trial-link").href = checkout.botUrl;
      $("#trial-link-wrap").hidden = false;
      $("#footer-bot").href = checkout.botUrl;
      $("#footer-bot").hidden = false;
    }
    if (support.url) {
      $("#footer-support").href = support.url;
      $("#footer-support").hidden = false;
    }
  }

  // ── Review sheet (dialog) ──────────────────────────────────────────────────
  function summaryHtml(plan) {
    return '<dl class="summary">' +
      "<div><dt>پلن</dt><dd>" + esc(toman(plan.gig) + " گیگابایت") + "</dd></div>" +
      "<div><dt>مدت</dt><dd>" + esc(durationTitle(plan.days) + " (" + toman(plan.days) + " روز)") + "</dd></div>" +
      "<div><dt>حداکثر اتصال</dt><dd>نامحدود</dd></div>" +
      '<div class="total"><dt>مبلغ قابل پرداخت</dt><dd>' + toman(plan.price) + " تومان</dd></div>" +
      "</dl>";
  }

  function setFoot(html) { $("#sheet-foot").innerHTML = html; }

  function openSheet(plan, opener) {
    state.sheetOpener = opener || document.activeElement;
    $("#sheet-body").innerHTML = summaryHtml(plan);
    setFoot('<button type="button" class="btn btn-primary btn-lg btn-block" disabled aria-disabled="true"><span class="spinner" aria-hidden="true"></span> در حال بررسی موجودی پلن…</button>' +
      '<button type="button" class="btn btn-ghost btn-block" data-close>بازگشت به پلن‌ها</button>');
    $("#sheet-backdrop").hidden = false;
    document.body.classList.add("sheet-open");
    $("#sheet-close").focus();
    validatePlan(plan);
  }

  function validatePlan(plan) {
    var seq = ++state.checkSeq;
    getJson("/api/store/plans/" + encodeURIComponent(plan.id)).then(function (data) {
      if (seq !== state.checkSeq || $("#sheet-backdrop").hidden) return;
      // The server response is authoritative for what is shown at hand-off.
      $("#sheet-body").innerHTML = summaryHtml(data.plan);
      if (data.checkout && data.checkout.available && data.checkout.url) {
        setFoot('<a class="btn btn-primary btn-lg btn-block" href="' + esc(data.checkout.url) + '" target="_blank" rel="noopener">' + icon("send") + " ادامه خرید در تلگرام</a>" +
          '<button type="button" class="btn btn-ghost btn-block" data-close>بازگشت به پلن‌ها</button>');
      } else {
        setFoot('<p class="sheet-error" role="alert">ربات تلگرام در حال حاضر در دسترس نیست؛ لطفاً چند دقیقه بعد دوباره تلاش کنید.</p>' +
          '<button type="button" class="btn btn-ghost btn-block" data-close>بازگشت به پلن‌ها</button>');
      }
    }).catch(function (error) {
      if (seq !== state.checkSeq || $("#sheet-backdrop").hidden) return;
      var gone = error && error.status === 404;
      setFoot('<p class="sheet-error" role="alert">' + (gone
        ? "این پلن دیگر برای فروش فعال نیست. فهرست پلن‌ها به‌روزرسانی شد."
        : "بررسی پلن ممکن نشد. اتصال را بررسی کنید و دوباره تلاش کنید.") + "</p>" +
        (gone ? "" : '<button type="button" class="btn btn-primary btn-block" data-recheck>' + icon("refresh") + " تلاش دوباره</button>") +
        '<button type="button" class="btn btn-ghost btn-block" data-close>بازگشت به پلن‌ها</button>');
      if (gone) loadCatalog();
      state.recheckPlan = plan;
    });
  }

  function closeSheet() {
    if ($("#sheet-backdrop").hidden) return;
    state.checkSeq += 1;
    $("#sheet-backdrop").hidden = true;
    document.body.classList.remove("sheet-open");
    var opener = state.sheetOpener;
    state.sheetOpener = null;
    if (opener && document.contains(opener) && typeof opener.focus === "function") opener.focus();
    else { var title = $("#plans-title"); title.setAttribute("tabindex", "-1"); title.focus(); }
  }

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", function (event) {
    if (event.target.id === "sheet-backdrop" || event.target.closest("[data-close]")) closeSheet();
    if (event.target.closest("[data-recheck]") && state.recheckPlan) validatePlan(state.recheckPlan);
  });
  document.addEventListener("keydown", function (event) {
    if ($("#sheet-backdrop").hidden) return;
    if (event.key === "Escape") { event.preventDefault(); closeSheet(); return; }
    if (event.key !== "Tab") return;
    var focusable = Array.prototype.slice.call($("#sheet-backdrop .sheet").querySelectorAll('a[href], button:not([disabled])'));
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  try {
    $("#year").textContent = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric" }).format(new Date()).replace(/[^۰-۹0-9]/g, "");
  } catch (e) {
    $("#year").textContent = String(new Date().getFullYear());
  }
  loadCatalog();
})();
