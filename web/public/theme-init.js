/* Runs synchronously in <head> (before first paint) so the saved/system theme,
   language and text direction are applied with no flash of the wrong theme.
   Kept as an external file: the admin CSP forbids inline scripts. */
(function () {
  var root = document.documentElement;
  var theme = null;
  var lang = null;
  try {
    theme = localStorage.getItem("swift.theme");
    lang = localStorage.getItem("swift.lang");
  } catch (e) { /* storage blocked: fall back to system defaults */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  if (lang !== "fa" && lang !== "en") {
    lang = String(navigator.language || "").toLowerCase().indexOf("fa") === 0 ? "fa" : "en";
  }
  root.setAttribute("data-theme", theme);
  root.setAttribute("lang", lang);
  root.setAttribute("dir", lang === "fa" ? "rtl" : "ltr");
  var meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", theme);
})();
