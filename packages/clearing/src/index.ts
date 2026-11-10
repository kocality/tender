// @tender/clearing: uniform-price clearing with the unrevealed-bid penalty, integer-only (bigint).
// Same algorithm and fixtures (fixtures/clearing/*.json) as contract/src/clearing.rs.

export interface ClearSale {
  S: bigint; // supply, token base units
  decimals: number;
  lot_exp: number;
  reserve: bigint; // micro-USDC per 10^lot_exp whole tokens
}
export type BidState = 'Sealed' | 'Revealed' | 'Penalized';
export interface ClearBid {
  idx: number;
  B: bigint; // escrow, micro-USDC
  p: bigint | null;
  q: bigint | null;
  state: BidState;
}
export type FinalState = 'Sealed' | 'Revealed' | 'Penalized';
export interface ClearResult {
  P_star: bigint | null;
  alloc: bigint[];
  spend: bigint[];
  refund: bigint[];
  penalty: bigint[];
  penalty_share: bigint[];
  final_state: FinalState[];
  seller_usdc: bigint;
  seller_tokens_back: bigint;
  dust: bigint;
}
// field names = fixtures/clearing `expected` keys exactly; `dust` is token base units (view name: get_result.token_dust)

const U128 = 1n << 128n;

/** The contract computes in u128; flag any value TS could hold but Rust would overflow on. */
function u128(x: bigint): bigint {
  if (x < 0n || x >= U128) throw new Error(`clearing overflow: ${x} outside u128`);
  return x;
}

const cdiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b; // a ≥ 0, b > 0

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * Pure, deterministic. Unrevealed bids (Sealed or Penalized) lose 10% of B when at least one bid was revealed; the
 * pool is paid to nobody (not to revealed bids, not to the seller) and stays in the contract, so
 * Σ refund + seller_usdc + pool = Σ B. With no revealed bid there is no penalty.
 * Eligible bids: revealed with p ≥ reserve, sorted by p descending then idx. A marginal bid never gets more than its
 * q buys at P* (floor(q·scale/P*)), so spend ≤ q; the excess is dust.
 */
export function clear(sale: ClearSale, bids: ClearBid[]): ClearResult {
  const { S, reserve } = sale;
  const scale = 10n ** BigInt(sale.decimals + sale.lot_exp);
  const n = bids.length;
  for (const [i, b] of bids.entries()) if (b.idx !== i) throw new Error(`bids must be ordered by idx (bid ${i} has idx ${b.idx})`);
  const zero = () => Array.from({ length: n }, () => 0n);
  const alloc = zero();
  const spend = zero();
  const pen = zero();

  const rev = bids.filter((b) => b.state === 'Revealed');
  const unrevealed = bids.filter((b) => b.state !== 'Revealed');
  for (const b of rev) if (b.p === null || b.q === null) throw new Error(`revealed bid ${b.idx} has no p/q`);
  if (rev.length > 0) for (const b of unrevealed) pen[b.idx] = b.B / 10n;

  const pool = sum(pen);

  const el = rev
    .filter((b) => b.p! >= reserve)
    .sort((a, b) => (a.p! === b.p! ? a.idx - b.idx : a.p! > b.p! ? -1 : 1));
  let P: bigint | null = null;
  let Q = 0n;
  let dust = 0n;
  for (const [k, b] of el.entries()) {
    Q += b.q!;
    const c = cdiv(u128(Q * scale), S);
    const cand = c > reserve ? c : reserve;
    const nxt = el[k + 1]?.p ?? null;
    if (cand <= b.p! && (nxt === null || cand > nxt)) {
      P = cand;
      for (const w of el.slice(0, k + 1)) {
        spend[w.idx] = w.q!;
        alloc[w.idx] = u128(w.q! * scale) / P;
      }
      break;
    }
    if (cand > b.p!) {
      P = b.p!;
      const full = el.filter((w) => w.p! > P!);
      const marg = el.filter((w) => w.p! === P);
      for (const w of full) {
        spend[w.idx] = w.q!;
        alloc[w.idx] = u128(w.q! * scale) / P;
      }
      const R = S - sum(alloc);
      const qm = sum(marg.map((w) => w.q!));
      for (const w of marg) {
        const cap = u128(w.q! * scale) / P;
        const t0 = u128(R * w.q!) / qm;
        const t = t0 < cap ? t0 : cap;
        alloc[w.idx] = t;
        spend[w.idx] = cdiv(u128(t * P), scale);
      }
      dust = R - sum(marg.map((w) => alloc[w.idx]!));
      break;
    }
  }

  const refund = bids.map((b) => {
    const r = b.B - spend[b.idx]! - pen[b.idx]!;
    if (r < 0n) throw new Error(`clearing underflow: bid ${b.idx} refund ${r}`); // the contract's u128 sub panics here
    return r;
  });
  const final_state: FinalState[] = bids.map((b) =>
    b.state === 'Revealed' ? 'Revealed' : rev.length > 0 ? 'Penalized' : 'Sealed',
  );
  const seller_usdc = sum(spend);
  if (seller_usdc + sum(refund) + pool !== sum(bids.map((b) => b.B))) throw new Error('clearing: USDC not conserved');
  if (sum(alloc) > S) throw new Error('clearing: allocation exceeds supply');
  return {
    P_star: P,
    alloc,
    spend,
    refund,
    penalty: pen,
    penalty_share: zero(), // kept for the fixture/view shape; always 0 since the pool goes to nobody
    final_state,
    seller_usdc,
    seller_tokens_back: S - sum(alloc),
    dust,
  };
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
  throw new Error(`fixture: ${what} must be a decimal string`);
};
const bigOrNull = (v: unknown, what: string): bigint | null => (v === null || v === undefined ? null : big(v, what));
const bigs = (v: unknown, what: string): bigint[] => {
  if (!Array.isArray(v)) throw new Error(`fixture: ${what} must be an array`);
  return v.map((x, i) => big(x, `${what}[${i}]`));
};

/** Parse a fixtures/clearing/*.json document (all amounts are decimal strings). */
export function fromFixture(json: unknown): { sale: ClearSale; bids: ClearBid[]; expected: ClearResult } {
  const j = json as {
    sale: Record<string, unknown>;
    bids: Record<string, unknown>[];
    expected: Record<string, unknown>;
  };
  const sale: ClearSale = {
    S: big(j.sale.S, 'sale.S'),
    decimals: Number(j.sale.decimals),
    lot_exp: Number(j.sale.lot_exp),
    reserve: big(j.sale.reserve, 'sale.reserve'),
  };
  const bids: ClearBid[] = j.bids.map((b, i) => ({
    idx: Number(b.idx),
    B: big(b.B, `bids[${i}].B`),
    p: bigOrNull(b.p, `bids[${i}].p`),
    q: bigOrNull(b.q, `bids[${i}].q`),
    state: b.state as BidState,
  }));
  const e = j.expected;
  const expected: ClearResult = {
    P_star: bigOrNull(e.P_star, 'expected.P_star'),
    alloc: bigs(e.alloc, 'alloc'),
    spend: bigs(e.spend, 'spend'),
    refund: bigs(e.refund, 'refund'),
    penalty: bigs(e.penalty, 'penalty'),
    penalty_share: bigs(e.penalty_share, 'penalty_share'),
    final_state: e.final_state as FinalState[],
    seller_usdc: big(e.seller_usdc, 'seller_usdc'),
    seller_tokens_back: big(e.seller_tokens_back, 'seller_tokens_back'),
    dust: big(e.dust, 'dust'),
  };
  return { sale, bids, expected };
}
