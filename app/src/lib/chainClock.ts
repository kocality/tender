import { useEffect, useState } from 'react';
import { blockTimestampNs } from '@tender/intents';
import { config } from '../config';

// The offset measured by the clock hook, shared with code that is not a component (payload deadlines).
let sharedOffsetMs = 0;

export function setChainOffset(offsetMs: number): void {
  sharedOffsetMs = offsetMs;
}

/**
 * Chain-time "now" in ms. Payload deadlines and nonces are judged against the chain's clock: a device clock that runs
 * 10 or more minutes slow would make every signature arrive as expired.
 */
export function chainNowMs(): number {
  return Date.now() + sharedOffsetMs;
}

/** Chain-time "now" in ns from the local clock and the measured offset (chain ms minus local ms). */
export function nowNsFrom(offsetMs: number, localMs: number): bigint {
  return BigInt(Math.round(localMs + offsetMs)) * 1_000_000n;
}

/**
 * Measures the chain-minus-local offset now and every 30 s from the head block, and shares it with `chainNowMs()`.
 * `null` until the first measurement. Pages that only need correct payload deadlines call this one (no re-render per second).
 */
export function useChainOffset(): number | null {
  const [offsetMs, setOffsetMs] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const measure = async () => {
      try {
        const ns = await blockTimestampNs(config.rpcUrls, { finality: 'optimistic' });
        if (alive) {
          const offset = Number(ns / 1_000_000n) - Date.now();
          setChainOffset(offset);
          setOffsetMs(offset);
        }
      } catch {
        // keep the previous offset; the page still works on the local clock
      }
    };
    void measure();
    const m = setInterval(measure, 30_000);
    return () => {
      alive = false;
      clearInterval(m);
    };
  }, []);

  return offsetMs;
}

/**
 * Chain time for countdowns and button gates, so a wrong local clock cannot open a button early.
 * The offset comes from the head block (optimistic finality: the final block trails it by about 3 s and would make the
 * clock run slow); before any measurement the local clock is used and `synced` is false.
 */
export function useChainClock(): { nowNs: bigint; synced: boolean } {
  const offsetMs = useChainOffset();
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return { nowNs: nowNsFrom(offsetMs ?? 0, Date.now()), synced: offsetMs !== null };
}
