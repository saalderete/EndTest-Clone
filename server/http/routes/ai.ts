// AI assistance: drafting tests and explaining failed runs. See services/ai.ts.
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { requireRole, ws } from "../authz";
import { HttpError } from "../../lib/errors";
import { audit } from "../../services/audit";
import { aiStatus, analyzeFailure, draftCase, storedAnalysis } from "../../services/ai";
import { idParam, parse } from "../validate";

export const aiRouter = Router({ mergeParams: true });

// Per person, on top of the workspace's monthly budget.
const aiLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `ai|${req.user?.id ?? "anon"}`,
  handler: (_req, _res, next) => next(new HttpError(429, "That's a lot of AI requests in an hour. Try again later.", "rate_limited")),
});

aiRouter.get("/ai/status", async (req, res) => {
  res.json(await aiStatus(ws(req)));
});

aiRouter.post("/ai/case-drafts", requireRole("editor"), aiLimiter, async (req, res) => {
  const body = parse(
    z.object({
      description: z.string().trim().min(10, "Describe the journey in a sentence or two").max(4000),
      environmentId: z.number().int().positive().nullable().optional(),
      caseId: z.number().int().positive().nullable().optional(),
    }),
    req.body,
  );
  const draft = await draftCase(ws(req), req.user!.id, body);
  await audit(req, "ai.case_drafted", body.caseId ? { type: "case", id: body.caseId } : undefined, { steps: draft.steps.length, requestId: draft.requestId }, { aiInvolved: true });
  res.json(draft);
});

aiRouter.get("/ai/failure-analysis/:runId", async (req, res) => {
  res.json(await storedAnalysis(ws(req).id, idParam(req.params.runId, "Run")));
});

aiRouter.post("/ai/failure-analysis", requireRole("runner"), aiLimiter, async (req, res) => {
  const { runId } = parse(z.object({ runId: z.number().int().positive() }), req.body);
  const result = await analyzeFailure(ws(req), req.user!.id, runId);
  await audit(req, "ai.failure_analyzed", { type: "run", id: runId }, { likelyCause: result.likelyCause, confidence: result.confidence, requestId: result.requestId }, { aiInvolved: true });
  res.json(result);
});
