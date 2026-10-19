/* Localization engine for the admin dashboard.
 *
 * Resource model: English is the source language and the message key; every
 * other language is a plain dictionary registered with SwiftI18n.register()
 * (see i18n-fa.js). All UI text lives in those dictionaries - there are no
 * per-call ternaries. Two entry points:
 *   t("Some text", { n: 3 })   for strings built in JavaScript ({n} placeholders)
 *   the DOM translator        which localizes rendered text, placeholders,
 *                             titles and aria-labels (including toasts, modals
 *                             and tables) and restores English when switching back.
 * Text that has no dictionary entry is shown in English (never blank). Elements
 * with data-no-i18n, .mono/code/pre, inputs' values and numbers/IDs are untouched.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SwiftI18n = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  var dictionaries = { en: {}, fa: {} };
  var patterns = { fa: [] };
  var current = "en";
  var originals = new WeakMap();   // text node / element attr bag -> original English
  var applied = new WeakMap();     // text node -> last text we wrote
  var observer = null;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, SVG: 1, TITLE: 0 };
  var ATTRS = ["placeholder", "title", "aria-label", "alt", "data-label"];

  function register(lang, dictionary, extraPatterns) {
    dictionaries[lang] = Object.assign(dictionaries[lang] || {}, dictionary);
    if (extraPatterns) patterns[lang] = (patterns[lang] || []).concat(extraPatterns);
  }

  function interpolate(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (m, key) { return vars[key] === undefined ? m : String(vars[key]); });
  }

  function lookup(text, lang) {
    var dict = dictionaries[lang];
    if (!dict) return null;
    if (Object.prototype.hasOwnProperty.call(dict, text)) return dict[text];
    var list = patterns[lang] || [];
    for (var i = 0; i < list.length; i += 1) {
      var match = list[i][0].exec(text);
      if (match) return list[i][1].apply(null, match.slice(1));
    }
    return null;
  }

  function t(key, vars) {
    var translated = current === "en" ? null : lookup(key, current);
    return interpolate(translated == null ? key : translated, vars);
  }

  function translateRaw(text, lang) {
    if (lang === "en") return text;
    var trimmed = text.trim();
    if (!trimmed) return text;
    var translated = lookup(trimmed, lang);
    if (translated == null) return text;
    var lead = text.match(/^\s*/)[0];
    var trail = text.match(/\s*$/)[0];
    return lead + translated + trail;
  }

  function skipped(element) {
    for (var node = element; node && node.nodeType === 1; node = node.parentNode) {
      if (SKIP_TAGS[node.tagName] === 1) return true;
      if (node.hasAttribute && node.hasAttribute("data-no-i18n")) return true;
      if (node.classList && (node.classList.contains("mono") || node.classList.contains("ltr"))) return true;
    }
    return false;
  }

  function translateTextNode(node) {
    var value = node.nodeValue;
    if (applied.get(node) === value) return; // our own write
    if (!value || !value.trim() || skipped(node.parentNode)) return;
    originals.set(node, value);
    var out = translateRaw(value, current);
    if (out !== value) {
      applied.set(node, out);
      node.nodeValue = out;
    } else {
      applied.delete(node);
    }
  }

  function translateAttributes(element) {
    if (element.nodeType !== 1 || skipped(element)) return;
    for (var i = 0; i < ATTRS.length; i += 1) {
      var name = ATTRS[i];
      if (!element.hasAttribute(name)) continue;
      var bagKey = "data-i18n-orig-" + name;
      var value = element.getAttribute(name);
      var original = element.hasAttribute(bagKey) ? element.getAttribute(bagKey) : null;
      // A value we did not write means the app set fresh English text.
      if (original === null || (current !== "en" && value !== translateRaw(original, current))) {
        original = value;
        element.setAttribute(bagKey, original);
      }
      var out = translateRaw(original, current);
      if (out !== value) element.setAttribute(name, out);
    }
  }

  function walk(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) return translateTextNode(rootNode);
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) {
      if (skipped(rootNode)) return;
      translateAttributes(rootNode);
    }
    var children = rootNode.childNodes;
    for (var i = 0; i < children.length; i += 1) walk(children[i]);
  }

  function restoreEnglish(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) {
      var original = originals.get(rootNode);
      if (original != null && applied.get(rootNode) === rootNode.nodeValue) { applied.delete(rootNode); rootNode.nodeValue = original; }
      return;
    }
    if (rootNode.nodeType === 1) {
      for (var i = 0; i < ATTRS.length; i += 1) {
        var bagKey = "data-i18n-orig-" + ATTRS[i];
        if (rootNode.hasAttribute(bagKey)) rootNode.setAttribute(ATTRS[i], rootNode.getAttribute(bagKey));
      }
    }
    var children = rootNode.childNodes;
    for (var j = 0; j < children.length; j += 1) restoreEnglish(children[j]);
  }

  function apply(rootNode) {
    if (typeof document === "undefined") return;
    var target = rootNode || document.body;
    if (current === "en") restoreEnglish(target); else walk(target);
    if (target === document.body || !rootNode) translateDocumentTitle();
  }

  function translateDocumentTitle() {
    if (typeof document === "undefined") return;
    if (!document.documentElement.hasAttribute("data-i18n-title")) document.documentElement.setAttribute("data-i18n-title", document.title);
    document.title = translateRaw(document.documentElement.getAttribute("data-i18n-title"), current);
  }

  function startObserving() {
    if (observer || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    observer = new MutationObserver(function (mutations) {
      if (current === "en") return;
      for (var i = 0; i < mutations.length; i += 1) {
        var m = mutations[i];
        if (m.type === "characterData") translateTextNode(m.target);
        else if (m.type === "attributes") translateAttributes(m.target);
        else for (var j = 0; j < m.addedNodes.length; j += 1) walk(m.addedNodes[j]);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function setLang(lang, options) {
    if (lang !== "fa" && lang !== "en") lang = "en";
    current = lang;
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("lang", lang);
      document.documentElement.setAttribute("dir", lang === "fa" ? "rtl" : "ltr");
      try { if (!options || options.persist !== false) localStorage.setItem("swift.lang", lang); } catch (e) { /* storage blocked */ }
      apply(document.body);
      startObserving();
    }
    return current;
  }

  function init() {
    var lang = typeof document !== "undefined" && document.documentElement.getAttribute("lang");
    setLang(lang === "fa" ? "fa" : "en", { persist: false });
  }

  return {
    register: register,
    t: t,
    apply: apply,
    setLang: setLang,
    init: init,
    lang: function () { return current; },
    dir: function () { return current === "fa" ? "rtl" : "ltr"; },
    has: function (text, lang) { return lookup(text, lang || "fa") != null; },
    translateRaw: translateRaw,
    _dictionaries: dictionaries
  };
});
