import type { ZodTypeAny, z } from "zod";
import { fromZod, notFound } from "../lib/errors";

/** Validates input against a schema; a failure becomes a 400 with field messages. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw fromZod(result.error);
  return result.data;
}

/** A positive integer route parameter, or 404. */
export function idParam(raw: unknown, what = "That item"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw notFound(what);
  return n;
}
