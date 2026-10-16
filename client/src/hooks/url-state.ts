// Filters live in the URL, so a view can be shared and the back button works.
import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";

export function useUrlState<T extends Record<string, string | undefined>>(defaults: T) {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const state = useMemo(() => {
    const out: Record<string, string | undefined> = { ...defaults };
    for (const k of Object.keys(defaults)) {
      const v = params.get(k);
      if (v !== null) out[k] = v;
    }
    return out as T;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const set = useCallback(
    (patch: Partial<T>, opts: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === "" || v === defaults[k]) next.delete(k);
        else next.set(k, String(v));
      }
      const qs = next.toString();
      navigate(`${location}${qs ? `?${qs}` : ""}`, { replace: opts.replace ?? true });
    },
    [search, location, navigate, defaults],
  );
  return [state, set] as const;
}
