import { useCallback, useEffect, useRef, useState } from "react";

import { getStoreJson } from "@/lib/api";
import { storageGet, storageSet } from "@/lib/format";
import { DURATION_STORAGE_KEY, catalogView, pickDuration, type StoreCatalog } from "@/lib/store";

export type CatalogState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty"; catalog: StoreCatalog }
  | { status: "ready"; catalog: StoreCatalog };

/** Loads the live catalog (re-validated server-side again at hand-off) and owns the duration selection. */
export function useCatalog() {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const [duration, setDurationState] = useState<number | null>(null);
  const sequence = useRef(0);
  const firstLoad = useRef(true);

  /**
   * `silent` refreshes in the background (used when the order dialog learns a
   * plan was retired): the visible catalog, the selected duration and any open
   * dialog stay put, and a failed refresh keeps the last good data.
   */
  const load = useCallback((options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    const seq = ++sequence.current;
    if (!silent) setState({ status: "loading" });
    // The first load consumes the <link rel="preload" as="fetch"> in pages/index.tsx; every later load is fresh.
    const fresh = !firstLoad.current;
    firstLoad.current = false;
    getStoreJson<StoreCatalog>("/api/store/catalog", undefined, { fresh })
      .then((catalog) => {
        if (seq !== sequence.current) return; // a newer load superseded this one
        const saved = Number(storageGet(DURATION_STORAGE_KEY));
        setDurationState((current) => pickDuration(catalog.durations, silent && current !== null ? current : Number.isFinite(saved) && saved > 0 ? saved : null));
        setState({ status: catalogView(catalog) === "ready" ? "ready" : "empty", catalog });
      })
      .catch(() => {
        if (seq === sequence.current && !silent) setState({ status: "error" });
      });
  }, []);

  useEffect(() => {
    load();
    return () => { sequence.current += 1; };
  }, [load]);

  const setDuration = useCallback((days: number) => {
    setDurationState(days);
    storageSet(DURATION_STORAGE_KEY, String(days));
  }, []);

  const reload = useCallback(() => load(), [load]);
  const refresh = useCallback(() => load({ silent: true }), [load]);

  return { state, duration, setDuration, reload, refresh };
}
