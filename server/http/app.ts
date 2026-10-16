// The Express app (API only; static files and Vite are attached in index.ts).
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { pool } from "../db/client";
import { HttpError } from "../lib/errors";
import { errorFields, log } from "../lib/log";
import { loadUser, requireUser, workspaceParam } from "./authz";
import { authRouter } from "./routes/auth";
import { workspacesRouter, workspaceScoped } from "./routes/workspaces";
import { testsRouter } from "./routes/tests";
import { runsRouter } from "./routes/runs";
import { schedulesRouter } from "./routes/schedules";
import { insightsRouter } from "./routes/insights";
import { systemRouter } from "./routes/system";
import { aiRouter } from "./routes/ai";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.TRUST_PROXY) app.set("trust proxy", 1);

  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const start = Date.now();
    res.on("finish", () => {
      if (!req.path.startsWith("/api") || req.path === "/api/health") return;
      log.info("request", { requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, user: req.user?.id });
    });
    next();
  });

  const https = config.APP_URL.startsWith("https:");
  app.use(
    helmet({
      // Vite's dev server injects inline scripts; the production build does not.
      contentSecurityPolicy:
        config.NODE_ENV === "production"
          ? {
              directives: {
                defaultSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "blob:"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'"],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                // Only over HTTPS: on a plain-http install this would make browsers
                // request every asset over https and the app would load blank.
                upgradeInsecureRequests: https ? [] : null,
              },
            }
          : false,
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: https,
    }),
  );

  app.use(express.json({ limit: "1mb" }));

  const PgStore = connectPg(session);
  app.use(
    session({
      name: "th.sid",
      store: new PgStore({ pool, tableName: "sessions", createTableIfMissing: false, pruneSessionInterval: 15 * 60 }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        // Secure whenever the public address is HTTPS; a plain-http local install can still sign in.
        secure: https,
        maxAge: 7 * 24 * 3600_000,
      },
    }),
  );
  app.use(loadUser);

  // Cross-site request forgery: every state-changing API call must carry a
  // header a cross-site form can't send, and a matching Origin when present.
  const appOrigin = new URL(config.APP_URL).origin;
  app.use("/api", (req, _res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("x-requested-with") !== "testharvest") return next(new HttpError(403, "Missing request header.", "csrf"));
    const origin = req.get("origin");
    if (origin && origin !== appOrigin && !(config.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))
      return next(new HttpError(403, "Cross-site request refused.", "csrf"));
    next();
  });

  app.use("/api", systemRouter);
  app.use("/api", authRouter);

  // Everything below needs a signed-in user.
  const api = express.Router();
  api.use(requireUser);
  api.use(workspacesRouter);
  // Every /workspaces/:wid route first proves membership (non-members get 404).
  api.use(
    "/workspaces/:wid",
    (req, res, next) => workspaceParam(req, res, next, String(req.params.wid)),
    workspaceScoped,
    testsRouter,
    runsRouter,
    schedulesRouter,
    insightsRouter,
    aiRouter,
  );
  app.use("/api", api);

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "No such API route.", "not_found")));

  // One error handler. It never re-throws, never leaks internals, and always
  // returns the request ID so a user report can be matched to the log.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const known = err instanceof HttpError;
    const status = known ? err.status : (err as { status?: number })?.status === 400 ? 400 : 500;
    if (!known && status === 500) log.error("unhandled error", { requestId: req.requestId, path: req.path, ...errorFields(err) });
    if (res.headersSent) return;
    res.status(status).json({
      message: known ? err.message : status === 400 ? "That request couldn't be read." : "Something went wrong on our side.",
      code: known ? err.code : status === 400 ? "bad_request" : "internal",
      details: known ? err.details : undefined,
      requestId: req.requestId,
    });
  });

  return app;
}
