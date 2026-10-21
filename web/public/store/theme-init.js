/* Applies the saved/system theme before first paint (external file: the
   storefront CSP forbids inline scripts). The storefront is Persian/RTL.
   Sets both `data-theme` (legacy static page) and the `dark` class (the
   shadcn/Tailwind storefront). Keep this file tiny and synchronous. */
(function () {
  var root = document.documentElement;
  var theme = null;
  try { theme = localStorage.getItem("swift.theme"); } catch (e) { /* storage blocked */ }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  root.setAttribute("data-theme", theme);
  if (root.classList) root.classList.toggle("dark", theme === "dark");
})();
