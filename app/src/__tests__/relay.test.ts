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

describe('relay answers that are not "retry" (DOUBLE-PLAN step 3)', () => {
  test('202 execute_unknown is an unclear outcome with the hashes, never a success and never "retry"', async () => {
    answer(202, { status: 'execute_unknown', txHashes: ['H1', 'H2'], sender: 'relayer.near', until: '2026-11-13T02:10:00.000Z', detail: 'timeout' });
    const err = await relay(signed, 'http://relay.invalid').catch((e: RelayError) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ kind: 'execute_unknown', unknown: { txHashes: ['H1', 'H2'], sender: 'relayer.near', untilMs: Date.parse('2026-11-13T02:10:00.000Z') } });
  });
  test('409 already_stored and 409 bid_seq keep their own kinds, with the relayer numbers', async () => {
    answer(409, { error: 'already_stored', detail: 'stored as your bid #1', sale: '1', n: 1 });
    await expect(relay(signed, 'http://relay.invalid')).rejects.toMatchObject({ kind: 'already_stored' });
    answer(409, { error: 'bid_seq', detail: 'you already have 2', sale: '1', have: 2, seq: 1 });
    await expect(relay(signed, 'http://relay.invalid')).rejects.toMatchObject({ kind: 'bid_seq' });
  });
  test('a 200 keeps the relayer account when it names it, so the page can read what the transaction logged', async () => {
    answer(200, { txHash: 'H1', sender: 'relayer.near' });
    expect(await relay(signed, 'http://relay.invalid')).toEqual({ txHash: 'H1', sender: 'relayer.near' });
    answer(200, { txHash: 'H1' });
    expect(await relay(signed, 'http://relay.invalid')).toEqual({ txHash: 'H1' });
  });
  test('a 503 that signed nothing is still the retry kind', async () => {
    answer(503, { error: 'execute_unavailable', detail: 'could not send', retry: true });
    await expect(relay(signed, 'http://relay.invalid')).rejects.toMatchObject({ kind: 'unavailable' });
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
    // every read from the third on fails; the deadline leaves room for at least three reads on a loaded machine
    expect(await pollBid(() => undefined, '1', { timeoutMs: 200, intervalMs: 1, load })).toBe('unknown');
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
