import { useEffect, useState } from 'react';
import { blockTimestampNs } from '@tender/intents';
import { config } from '../config';

/** Chain-time "now" in ns from the local clock and the measured offset (chain ms minus local ms). */
export function nowNsFrom(offsetMs: number, localMs: number): bigint {
  return BigInt(Math.round(localMs + offsetMs)) * 1_000_000n;
}

/**
 * Chain time for countdowns and button gates, so a wrong local clock cannot open a button early.
 * The offset is re-measured every 30 s from the latest final block; before any measurement the local clock is used
 * and `synced` is false.
 */
export function useChainClock(): { nowNs: bigint; synced: boolean } {
  const [offsetMs, setOffsetMs] = useState<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const measure = async () => {
      try {
        const ns = await blockTimestampNs(config.rpcUrls);
        if (alive) setOffsetMs(Number(ns / 1_000_000n) - Date.now());
      } catch {
        // keep the previous offset; the page still works on the local clock
      }
    };
    void measure();
    const m = setInterval(measure, 30_000);
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      alive = false;
      clearInterval(m);
      clearInterval(t);
    };
  }, []);

  return { nowNs: nowNsFrom(offsetMs ?? 0, Date.now()), synced: offsetMs !== null };
}
