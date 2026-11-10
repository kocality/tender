/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { fromFixture } from '@tender/clearing';
import { recompute } from '../lib/results';
import { parseBid, parseSale, parseResult } from '../lib/views';
import sale1 from '../__fixtures__/views/sale-1-finalized.json';

const demo = JSON.parse(readFileSync(new URL('../../../fixtures/clearing/demo-sale-1.json', import.meta.url), 'utf8')) as {
  bids: { idx: number; B: string; p: string; q: string; state: string }[];
  expected: { P_star: string; alloc: string[]; spend: string[]; penalty: string[]; penalty_share: string[]; seller_usdc: string; seller_tokens_back: string; dust: string };
};
const e = demo.expected;
const sale = parseSale(sale1);
const mkBids = () =>
  demo.bids.map((b, i) =>
    parseBid({
      idx: b.idx, bidder: `b${i}.near`, escrow: b.B, ct: '', cm: '', origin: null, block: '1', ns: '1', state: b.state, p: b.p, q: b.q, salt: null, revealed_by: null,
      alloc: e.alloc[i], spend: e.spend[i], penalty: e.penalty[i], penalty_share: e.penalty_share[i], paid: { usdc: '0', tokens: '0', ok: true },
    }),
  );
const mkResult = () =>
  parseResult({ p_star: e.P_star, sold: e.alloc.reduce((a, b) => (BigInt(a) + BigInt(b)).toString(), '0'), seller_usdc: e.seller_usdc, seller_tokens_back: e.seller_tokens_back, token_dust: e.dust, penalty_pool: '0', block: '1', ns: '1', cancelled: false })!;

describe('recompute', () => {
  test('the demo sale clears at 3.60 and matches a contract result that stores the same numbers', () => {
    const out = recompute(sale, mkBids(), mkResult());
    expect(out.clear.P_star).toBe(3_600_000n);
    expect(out.diffs).toEqual([]);
    expect(out.match).toBe(true);
  });
  test('the golden fixture agrees with the clearing package', () => {
    const f = fromFixture(JSON.parse(readFileSync(new URL('../../../fixtures/clearing/demo-sale-1.json', import.meta.url), 'utf8')));
    expect(f.expected.P_star).toBe(3_600_000n);
  });
  test('a wrong stored field produces a difference table', () => {
    const r = mkResult();
    r.sellerUsdc += 1n;
    const out = recompute(sale, mkBids(), r);
    expect(out.match).toBe(false);
    expect(out.diffs).toEqual([{ field: 'seller_usdc', onChain: '10800002', recomputed: '10800001' }]);
  });
  test('a wrong per-bid allocation is named', () => {
    const bids = mkBids();
    bids[3]!.alloc += 1n;
    const out = recompute(sale, bids, mkResult());
    expect(out.diffs.map((d) => d.field)).toEqual(['bid 3 alloc']);
  });
});
