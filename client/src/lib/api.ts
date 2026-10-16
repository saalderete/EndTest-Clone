// The one way the UI talks to the API. Every call sends the header the server
// requires for state-changing requests and turns errors into readable messages.
import { QueryClient } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public requestId?: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "X-Requested-With": "testharvest", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new CustomEvent("th:unauthorized"));
    throw new ApiError(res.status, data?.message ?? `Request failed (${res.status})`, data?.code, data?.requestId ?? res.headers.get("x-request-id") ?? undefined, data?.details);
  }
  return data as T;
}

export const get = <T,>(url: string) => api<T>("GET", url);
export const post = <T,>(url: string, body: unknown = {}) => api<T>("POST", url, body);
export const put = <T,>(url: string, body: unknown) => api<T>("PUT", url, body);
export const patch = <T,>(url: string, body: unknown) => api<T>("PATCH", url, body);
export const del = <T,>(url: string, body?: unknown) => api<T>("DELETE", url, body);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: ({ queryKey }) => get(queryKey.join("/")),
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
