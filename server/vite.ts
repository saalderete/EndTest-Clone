// Development only: Vite middleware with hot reload. Production uses static.ts.
// index.ts loads this lazily so the production bundle never imports Vite.
import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

export async function setupVite(app: Express, server: Server) {
  const { createServer, createLogger } = await import("vite");
  const viteConfig = (await import("../vite.config")).default;
  const logger = createLogger();
  const vite = await createServer({
    ...viteConfig,
    configFile: false,
    customLogger: logger,
    server: { middlewareMode: true, hmr: { server }, allowedHosts: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    try {
      const file = path.resolve(import.meta.dirname, "..", "client", "index.html");
      let template = await fs.promises.readFile(file, "utf-8");
      template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${randomUUID()}"`);
      const page = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
