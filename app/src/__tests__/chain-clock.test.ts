import { afterEach, describe, expect, test, vi } from 'vitest';
import { rt, runEffects, settle } from './helpers/shallow';

vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

import { chainNowMs, setChainOffset, useChainOffset } from '../lib/chainClock';

afterEach(() => {
  vi.unstubAllGlobals();
  setChainOffset(0);
});

describe('the chain clock reads the head block (X12-02 time)', () => {
  test('it asks for optimistic finality, and the measured offset reaches the payload clock', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ jsonrpc: '2.0', id: 'tender', result: { header: { timestamp_nanosec: String((BigInt(Date.now()) + 5_000n) * 1_000_000n) } } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    rt.slots = [];
    rt.i = 0;
    rt.effects = [];
    useChainOffset();
    const cleanups = runEffects();
    await settle();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { params: { finality: string } };
    expect(body.params.finality).toBe('optimistic');
    expect(Math.abs(chainNowMs() - (Date.now() + 5_000))).toBeLessThan(500); // chain is 5 s ahead of this device
    cleanups.forEach((c) => typeof c === 'function' && c());
    await settle();
  });
});
