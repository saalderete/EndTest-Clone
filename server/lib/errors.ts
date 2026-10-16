// Errors that map to an HTTP status and a user-safe message.
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, "bad_request", details);
export const unauthorized = (message = "Sign in to continue.") => new HttpError(401, message, "unauthorized");
export const forbidden = (message = "You don't have permission to do that.") => new HttpError(403, message, "forbidden");
// Resources in other workspaces answer 404, so their existence isn't revealed.
export const notFound = (what = "That item") => new HttpError(404, `${what} was not found.`, "not_found");
export const conflict = (message: string) => new HttpError(409, message, "conflict");

export function fromZod(err: ZodError): HttpError {
  const fields = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return new HttpError(400, fields[0]?.message ?? "Invalid request", "validation", fields);
}
