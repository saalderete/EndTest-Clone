// Serves the built React app in production.
import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const dist = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(dist)) throw new Error(`Build output not found at ${dist}. Run npm run build first.`);
  app.use(express.static(dist, { index: false, maxAge: "1h", setHeaders: (res, p) => p.includes("/assets/") && res.setHeader("Cache-Control", "public, max-age=31536000, immutable") }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(dist, "index.html"));
  });
}
