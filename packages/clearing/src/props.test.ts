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
/** Uniform-ish bigint in [lo, hi] from 32-bit draws (mulberry32 yields 32 bits; scaling it to 53 bits left the low 21
 * bits zero, so every small span drew lo). */
const bits128 = (r: () => number): bigint => {
  let x = 0n;
  for (let i = 0; i < 4; i++) x = (x << 32n) + BigInt(Math.floor(r() * 2 ** 32));
  return x;
};
function between(lo: bigint, hi: bigint): bigint {
  return lo + (bits128(rand) % (hi - lo + 1n));
}
const int = (lo: number, hi: number) => Number(between(BigInt(lo), BigInt(hi)));
const U64_MAX = (1n << 64n) - 1n;

function randomSale(): { sale: ClearSale; bids: ClearBid[] } {
  const decimals = int(0, 24);
  const lot_exp = int(0, 26 - decimals);
  // p and reserve anywhere in u64 half the time, q == B half the time (same ranges as the Rust proptest)
  const price = () => (rand() < 0.5 ? between(1n, 10n ** 13n) : between(1n, U64_MAX));
  const S = rand() < 0.5 ? between(1n, 10n ** 26n) : between(1n, 10n ** 14n);
  const sale: ClearSale = { S, decimals, lot_exp, reserve: price() };
  const n = int(1, 64);
  // clustered prices make ties and marginal groups common
  const pricePool = Array.from({ length: 4 }, price);
  const bids: ClearBid[] = Array.from({ length: n }, (_, idx) => {
    const B = between(1_000_000n, 15_625_000_000n);
    if (rand() < 0.2) return { idx, B, p: null, q: null, state: 'Sealed' };
    const p = rand() < 0.5 ? pricePool[int(0, 3)]! : price();
    return { idx, B, p, q: rand() < 0.5 ? B : between(1n, B), state: 'Revealed' };
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
      expect(sum(r.spend) + sum(r.refund) + sum(r.penalty), `${tag} usdc (pool stays in the contract)`).toBe(
        sum(bids.map((b) => b.B)),
      );
      expect(sum(r.alloc) + r.seller_tokens_back, `${tag} tokens`).toBe(sale.S);
      expect(r.seller_usdc, `${tag} seller gets spend only`).toBe(sum(r.spend));
      expect(sum(r.penalty_share), `${tag} pool paid to nobody`).toBe(0n);
      if (revealed.length === 0) expect(sum(r.penalty), `${tag} no penalty without reveals`).toBe(0n);
      for (const b of bids) {
        const i = b.idx;
        expect(r.spend[i]! <= (b.q ?? 0n), `${tag} bid ${i} spend ≤ q`).toBe(true);
        expect(r.refund[i]! >= 0n, `${tag} bid ${i} refund ≥ 0`).toBe(true);
        if (r.alloc[i]! > 0n) expect(r.P_star !== null && r.P_star <= b.p!, `${tag} bid ${i} P* ≤ p`).toBe(true);
        if (b.state !== 'Revealed' || r.P_star === null || b.p! < r.P_star) {
          expect(r.alloc[i], `${tag} bid ${i} loser alloc`).toBe(0n);
          expect(r.spend[i], `${tag} bid ${i} loser spend`).toBe(0n);
          expect(r.refund[i], `${tag} bid ${i} loser refund`).toBe(b.B - r.penalty[i]!);
        }
      }
      if (r.P_star !== null) expect(r.P_star >= sale.reserve, `${tag} P* ≥ reserve`).toBe(true);
    }
  });
});

// C-01 / S-01 knife edge (mirror of the Rust prop_knife_edge_spend_le_q): a full winner A at P+1 and a marginal B at P,
// both with q == B, and S = floor(q_a·scale/P) + floor(q_b·scale/P) + 1 with r_a + r_b > P (r = q·scale mod P). Without
// the marginal cap the floor losses push B's spend to q_b + 1 and its refund below zero.
describe('marginal knife edge (512 seeded cases, seed 1310)', () => {
  it('spend ≤ q and USDC conserved', () => {
    const r2 = mulberry32(1310);
    const draw = (lo: bigint, hi: bigint) => lo + (bits128(r2) % (hi - lo + 1n));
    let ran = 0;
    for (let tries = 0; ran < 512 && tries < 100_000; tries++) {
      const exp = Number(draw(20n, 26n));
      const scale = 10n ** BigInt(exp);
      const P = draw(1n, U64_MAX - 1n);
      const qa = draw(1_000_000n, 500_000_000_000n);
      const qb = draw(1_000_000n, 500_000_000_000n);
      if (((qa * scale) % P) + ((qb * scale) % P) <= P) continue;
      const S = (qa * scale) / P + (qb * scale) / P + 1n;
      if (S > 10n ** 26n) continue;
      const decimals = Math.min(exp, 24);
      const r = clear({ S, decimals, lot_exp: exp - decimals, reserve: 1n }, [
        { idx: 0, B: qa, p: P + 1n, q: qa, state: 'Revealed' },
        { idx: 1, B: qb, p: P, q: qb, state: 'Revealed' },
      ]);
      const tag = `exp ${exp} P ${P} qa ${qa} qb ${qb}`;
      expect(r.P_star, tag).toBe(P);
      expect(r.spend[0]! <= qa && r.spend[1]! <= qb, `${tag} spend ${r.spend}`).toBe(true);
      expect(sum(r.spend) + sum(r.refund), tag).toBe(qa + qb);
      ran++;
    }
    expect(ran).toBe(512);
  });
});
