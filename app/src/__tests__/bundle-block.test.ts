import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadSaleBundle } from '../lib/loaders';
import { chainNowMs, setChainOffset } from '../lib/chainClock';
import { buildBidPayload } from '../lib/bidPayload';
import { buildSelfReveal } from '../lib/selfReveal';
import { buildWithdrawPayload } from '../lib/withdrawFlow';
import { decodeVersionedNonce } from '@tender/intents';
import sale1Keyed from '../__fixtures__/views/sale-1-keyed.json';
import bids1 from '../__fixtures__/views/bids-1.json';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setChainOffset(0);
});

const bytes = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

describe('one bundle, one block (X12-02 tabs)', () => {
  test('sale, bids and key log are all read at the same final height', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { method, params } = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
        calls.push({ method, params });
        if (method === 'block') return Response.json({ jsonrpc: '2.0', id: 'tender', result: { header: { height: 123456, timestamp_nanosec: '1' } } });
        const name = params.method_name as string;
        const out = name === 'get_sale' ? sale1Keyed : name === 'get_bids' ? bids1 : [];
        return Response.json({ jsonrpc: '2.0', id: 'tender', result: { result: bytes(out), logs: [] } });
      }),
    );
    await loadSaleBundle('1');
    const views = calls.filter((c) => c.method === 'query');
    expect(views.length).toBeGreaterThanOrEqual(3);
    for (const v of views) {
      expect(v.params.block_id, String(v.params.method_name)).toBe(123456);
      expect(v.params).not.toHaveProperty('finality');
    }
  });
});

describe('payload deadlines follow the chain clock (QA-15)', () => {
  const ten = 10 * 60_000;
  test('a device clock 11 minutes slow still gets a deadline 10 minutes after the chain\'s now', async () => {
    const chain = Date.parse('2026-11-13T02:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(chain - 11 * 60_000); // the device clock
    setChainOffset(11 * 60_000); // measured: chain is 11 minutes ahead
    expect(chainNowMs()).toBe(chain);
    const deadlineOf = (p: { deadline: string }) => Date.parse(p.deadline);
    const bid = await buildBidPayload({ signerId: 'a.near', receiverId: 'v1.tenderseal.near', quoteToken: 'nep141:x', amount: 1n, sale: '1', ct: 'c', cm: 'd', saltHex: '252812b3' });
    const reveal = await buildSelfReveal({ signerId: 'a.near', contract: 'v1.tenderseal.near', quoteToken: 'nep141:x', sale: '1', items: [], saltHex: '252812b3' });
    const withdraw = await buildWithdrawPayload({ signerId: 'a.near', depositAddress: 'abc', tokenId: 'nep141:x', amountIn: 1n, saltHex: '252812b3' });
    for (const p of [bid, reveal, withdraw]) {
      expect(Math.abs(deadlineOf(p) - (chain + ten))).toBeLessThan(1000);
      expect(Number(decodeVersionedNonce(p.nonce).deadlineNs / 1_000_000n)).toBe(deadlineOf(p));
    }
  });
});
