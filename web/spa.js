import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";

const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const OPTIONS = {
  dotfiles: "ignore",
  extensions: [],
  fallthrough: true,
  index: false,
  maxAge: "1h",
  redirect: false,
};

let staticMiddleware = null;

function ensureStatic() {
  if (staticMiddleware) return staticMiddleware;
  staticMiddleware = express.static(webRoot, OPTIONS);
  return staticMiddleware;
}

function safeRelative(urlPath) {
  // Express req.path is absolute ("/admin/users"); strip it before normalizing
  // so traversal attempts and absolute paths are both rejected.
  const stripped = String(urlPath).replace(/^\/+/, "");
  const resolved = path.normalize(stripped).replace(/^([.][.][/\\])+/, "");
  if (!resolved || resolved === "." || resolved.startsWith("..") || path.isAbsolute(resolved)) return null;
  return resolved;
}

export function serveAdminSpa(req, res, next) {
  // API and health endpoints are never handled by the SPA.
  if (req.path.startsWith("/api/") || ["/health", "/ready", "/livez"].includes(req.path)) return next();

  const relative = safeRelative(req.path);
  if (!relative) return next();

  const candidate = path.join(webRoot, relative);
  if (!candidate.startsWith(webRoot)) return next();

  fs.stat(candidate, (statError, stats) => {
    if (!statError && stats.isFile()) {
      return ensureStatic()(req, res, next);
    }
    // History-API fallback: any non-file path serves the app shell.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.sendFile(path.join(webRoot, "index.html"), (sendError) => {
      if (sendError) next();
    });
  });
}

export function notFoundHandler(req, res) {
  if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "not_found" });
  res.status(404).send("Not found");
}
