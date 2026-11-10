// Hand-computed demo-sale-1 (spec §5.5 table; checked with Python on 2026-11-10). Runs without the WS1 fixtures.
// If fixtures/clearing/demo-sale-1.json disagrees, the fixture wins: find the root cause, do not edit this to match.
import { describe, expect, it } from 'vitest';
import { type ClearBid, clear } from './index.js';

const M = 1_000_000n;
const bids: ClearBid[] = [
  [5n * M, 3_900_000n, 4n * M],
  [5n * M, 3_800_000n, 3n * M],
  [3n * M, 3_700_000n, 3n * M],
  [3n * M, 3_600_000n, 2n * M],
  [3n * M, 3_200_000n, 3n * M],
  [2n * M, 2_900_000n, 2n * M],
].map(([B, p, q], idx) => ({ idx, B: B!, p: p!, q: q!, state: 'Revealed' }));

describe('demo-sale-1 crosscheck', () => {
  it('P* = 3.60 with the marginal bid paying 0.800001', () => {
    const r = clear({ S: 3n * 10n ** 24n, decimals: 24, lot_exp: 0, reserve: 3_000_000n }, bids);
    expect(r.P_star).toBe(3_600_000n);
    expect(r.alloc).toEqual([
      1111111111111111111111111n,
      833333333333333333333333n,
      833333333333333333333333n,
      222222222222222222222223n,
      0n,
      0n,
    ]);
    expect(r.spend).toEqual([4_000_000n, 3_000_000n, 3_000_000n, 800_001n, 0n, 0n]);
    expect(r.refund).toEqual([1_000_000n, 2_000_000n, 0n, 2_199_999n, 3_000_000n, 2_000_000n]);
    expect(r.seller_usdc).toBe(10_800_001n);
    expect(r.seller_tokens_back).toBe(0n);
    expect(r.dust).toBe(0n);
    expect(r.penalty).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    expect(r.final_state).toEqual(Array(6).fill('Revealed'));
  });
});
