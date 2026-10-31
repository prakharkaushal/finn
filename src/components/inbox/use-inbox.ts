"use client";

import { useCallback, useEffect, useState } from "react";
import { inboxQueryString, type InboxQuery } from "@/lib/inbox/params";
import type { InboxResponse } from "@/lib/inbox/types";

type State = { data?: InboxResponse; error?: string; loading: boolean };

const AUTO_REFRESH_MS = 5 * 60_000;

/** Fetches the inbox; keeps the last good response on screen while refreshing or on error. */
export function useInbox(query: InboxQuery | null) {
  const [state, setState] = useState<State>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const qs = query ? inboxQueryString(query) : null;

  useEffect(() => {
    if (!qs) return;
    const ctrl = new AbortController();
    // A new query or manual refresh starts a fetch; the previous data stays visible meanwhile.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fetch(`/api/inbox?${qs}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({ error: `Server responded ${res.status}` }));
        if (!res.ok) throw new Error(body.error ?? `Server responded ${res.status}`);
        return body as InboxResponse;
      })
      .then((data) => setState({ data, loading: false }))
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ data: s.data, loading: false, error: err instanceof Error ? err.message : "Network error" }));
      });
    return () => ctrl.abort();
  }, [qs, nonce]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setNonce((n) => n + 1);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}
