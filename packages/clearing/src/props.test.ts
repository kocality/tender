// 512 seeded random sales (Q4), invariants of the uniform-price clearing. No property-testing dependency.
import { describe, expect, it } from 'vitest';
import { type ClearBid, type ClearSale, clear } from './index.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(1114);
/** Uniform-ish bigint in [lo, hi] from 53-bit draws. */
function between(lo: bigint, hi: bigint): bigint {
  const span = hi - lo + 1n;
  let x = 0n;
  for (let i = 0; i < 3; i++) x = (x << 53n) + BigInt(Math.floor(rand() * 2 ** 53));
  return lo + (x % span);
}
const int = (lo: number, hi: number) => Number(between(BigInt(lo), BigInt(hi)));

function randomSale(): { sale: ClearSale; bids: ClearBid[] } {
  const decimals = int(0, 24);
  const lot_exp = int(0, 26 - decimals);
  const sale: ClearSale = { S: between(1n, 10n ** 26n), decimals, lot_exp, reserve: between(1n, 10n ** 13n) };
  const n = int(1, 64);
  // clustered prices make ties and marginal groups common
  const pricePool = Array.from({ length: 4 }, () => between(1n, 10n ** 13n));
  const bids: ClearBid[] = Array.from({ length: n }, (_, idx) => {
    const B = between(1_000_000n, 15_625_000_000n);
    if (rand() < 0.2) return { idx, B, p: null, q: null, state: 'Sealed' };
    const p = rand() < 0.5 ? pricePool[int(0, 3)]! : between(1n, 10n ** 13n);
    return { idx, B, p, q: between(1n, B), state: 'Revealed' };
  });
  return { sale, bids };
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('clearing invariants (512 seeded sales, seed 1114)', () => {
  it('hold for every sale', () => {
    for (let c = 0; c < 512; c++) {
      const { sale, bids } = randomSale();
      const r = clear(sale, bids);
      const tag = `case ${c}`;
      const revealed = bids.filter((b) => b.state === 'Revealed');
      expect(sum(r.alloc) <= sale.S, `${tag} supply`).toBe(true);
      expect(sum(r.spend) + sum(r.refund), `${tag} usdc`).toBe(sum(bids.map((b) => b.B)));
      expect(sum(r.alloc) + r.seller_tokens_back, `${tag} tokens`).toBe(sale.S);
      expect(r.seller_usdc, `${tag} seller gets spend only`).toBe(sum(r.spend));
      expect(sum(r.penalty_share), `${tag} pool fully shared`).toBe(sum(r.penalty));
      if (revealed.length === 0) expect(sum(r.penalty), `${tag} no penalty without reveals`).toBe(0n);
      for (const b of bids) {
        const i = b.idx;
        expect(r.spend[i]! <= (b.q ?? 0n), `${tag} bid ${i} spend ≤ q`).toBe(true);
        expect(r.refund[i]! >= 0n, `${tag} bid ${i} refund ≥ 0`).toBe(true);
        if (r.alloc[i]! > 0n) expect(r.P_star !== null && r.P_star <= b.p!, `${tag} bid ${i} P* ≤ p`).toBe(true);
        if (b.state !== 'Revealed' || r.P_star === null || b.p! < r.P_star) {
          expect(r.alloc[i], `${tag} bid ${i} loser alloc`).toBe(0n);
          expect(r.spend[i], `${tag} bid ${i} loser spend`).toBe(0n);
          expect(r.refund[i], `${tag} bid ${i} loser refund`).toBe(b.B - r.penalty[i]! + r.penalty_share[i]!);
        }
      }
      if (r.P_star !== null) expect(r.P_star >= sale.reserve, `${tag} P* ≥ reserve`).toBe(true);
    }
  });
});
