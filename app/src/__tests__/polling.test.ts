import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The real hook, with React's state and effect reduced to what it needs: the effect runs at once, the state is one slot.
const h = vi.hoisted(() => ({ state: undefined as unknown, cleanups: [] as (() => void)[] }));
vi.mock('react', () => ({
  useState: (init: unknown) => {
    h.state ??= init;
    return [h.state, (v: unknown) => void (h.state = typeof v === 'function' ? (v as (s: unknown) => unknown)(h.state) : v)];
  },
  useEffect: (fn: () => void | (() => void)) => {
    const c = fn();
    if (c) h.cleanups.push(c);
  },
}));

import { usePolling } from '../lib/usePolling';

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const snapshot = () => h.state as { data: string | null; error: string | null; loading: boolean };

beforeEach(() => {
  h.state = undefined;
  h.cleanups = [];
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible' });
});
afterEach(() => {
  h.cleanups.forEach((c) => c());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('overlapping polls (X12-02 tabs)', () => {
  test('an older, slower read cannot replace a newer one', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    usePolling(load, 1000, []);
    await vi.advanceTimersByTimeAsync(1000); // second run starts while the first is still reading
    fast.resolve('Revealed');
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot().data).toBe('Revealed');
    slow.resolve('Sealed'); // the older answer arrives last
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot().data).toBe('Revealed');
  });

  test('an older failure cannot replace newer data either', async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    usePolling(load, 1000, []);
    await vi.advanceTimersByTimeAsync(1000);
    fast.resolve('Revealed');
    await vi.advanceTimersByTimeAsync(0);
    slow.reject(new Error('HTTP 429'));
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot()).toMatchObject({ data: 'Revealed', error: null });
  });

  test('in order, each answer still replaces the last, and a failure keeps the last good data', async () => {
    const load = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockRejectedValueOnce(new Error('down'));
    usePolling(load, 1000, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot().data).toBe('a');
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshot().data).toBe('b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshot()).toMatchObject({ data: 'b', error: 'down' });
  });
});
