import { afterEach, describe, expect, test, vi } from 'vitest';
import { RelayError, confirmBid, pollBid, relay } from '../lib/relay';
import type { Bid } from '../lib/views';

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: object) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
const signed = [{ standard: 'erc191', payload: '{}', signature: 'secp256k1:x' } as const];

describe('relay failures other than 429 (QA-04)', () => {
  test('a relayer 502 or 503 is "unavailable" (try again), not an opaque failure', async () => {
    answer(502, { error: 'upstream_error', detail: 'NEAR RPC unreachable' });
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'unavailable' });
    answer(503, { error: 'relayer_allowance_low', detail: 'allowance low' });
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'unavailable' });
  });
  test('a 502 execute_failed is a failure of the signed payload: its Intents kind and tx hash survive', async () => {
    answer(502, { error: 'execute_failed', txHash: 'H', detail: 'Smart contract panicked: insufficient balance or overflow' });
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'insufficient_balance', txHash: 'H' });
    answer(502, { error: 'execute_failed', txHash: 'H2', detail: 'Smart contract panicked: deadline has expired' });
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'deadline_expired', txHash: 'H2' });
  });
  test('an unreachable relayer and 429 keep their kinds; a simulate_failed 400 keeps its Intents kind', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'unavailable' });
    answer(429, {});
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'busy' });
    answer(400, { error: 'simulate_failed', detail: 'invalid salt' });
    await expect(relay([...signed], 'http://relay.invalid')).rejects.toMatchObject({ kind: 'invalid_salt' });
    await expect(relay([...signed], '')).rejects.toBeInstanceOf(RelayError);
  });
});

describe('confirming a stored bid (QA-08)', () => {
  const bid = { idx: 3, bidder: 'a.near', cm: 'ab'.repeat(32) } as unknown as Bid;
  const fast = { timeoutMs: 10, intervalMs: 1 };
  test('reads that always fail are "unknown", never "not stored"', async () => {
    const out = await confirmBid({ sale: '1', bidder: 'a.near', cm: bid.cm, ...fast, load: async () => Promise.reject(new Error('HTTP 429')) });
    expect(out).toBe('unknown');
  });
  test('reads that work and show no bid are "not stored" (null)', async () => {
    expect(await confirmBid({ sale: '1', bidder: 'a.near', cm: bid.cm, ...fast, load: async () => [] })).toBeNull();
  });
  test('a bid that shows up is returned, and a failed read before it does not hide it', async () => {
    let n = 0;
    const load = async () => (++n === 1 ? Promise.reject(new Error('429')) : [bid]);
    expect(await confirmBid({ sale: '1', bidder: 'a.near', cm: bid.cm, timeoutMs: 50, intervalMs: 1, load })).toBe(bid);
  });
  test('pollBid with a failing last read is unknown even after good reads', async () => {
    let n = 0;
    const load = async () => (++n < 3 ? [] : Promise.reject(new Error('down')));
    expect(await pollBid(() => undefined, '1', { timeoutMs: 8, intervalMs: 3, load })).toBe('unknown');
  });
});
