import { useEffect, useState } from 'react';

export interface Polled<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Runs `load` now and then every `intervalMs` (0 = once) while the tab is visible. A failed refresh keeps the last good data. */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, deps: readonly unknown[]): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const data = await load();
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false }));
      }
    };
    setState({ data: null, error: null, loading: true });
    void run();
    const t =
      intervalMs > 0
        ? setInterval(() => {
            if (document.visibilityState === 'visible') void run();
          }, intervalMs)
        : null;
    return () => {
      alive = false;
      if (t !== null) clearInterval(t);
    };
  }, deps);

  return state;
}
