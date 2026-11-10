import { clear, type ClearResult } from '@tender/clearing';
import type { Bid, Sale, SaleResult } from './views';

export interface ResultDiff {
  field: string;
  onChain: string;
  recomputed: string;
}

export interface Recomputed {
  clear: ClearResult;
  diffs: ResultDiff[];
  /** `true` when every compared field agrees with the contract's stored result. */
  match: boolean;
}

const s = (v: bigint | null): string => (v === null ? 'none' : v.toString());
const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/**
 * Re-runs the clearing in the browser from the revealed bids and compares it field by field with `get_result` and the
 * per-bid fields the contract stored. Bids must be the sale's full list in idx order.
 */
export function recompute(sale: Pick<Sale, 'supply' | 'decimals' | 'lotExp' | 'reserve'>, bids: Bid[], result: SaleResult): Recomputed {
  const out = clear(
    { S: sale.supply, decimals: sale.decimals, lot_exp: sale.lotExp, reserve: sale.reserve },
    bids.map((b) => ({ idx: b.idx, B: b.escrow, p: b.p, q: b.q, state: b.state })),
  );
  const diffs: ResultDiff[] = [];
  const cmp = (field: string, onChain: bigint | null, local: bigint | null) => {
    if (onChain !== local) diffs.push({ field, onChain: s(onChain), recomputed: s(local) });
  };
  cmp('p_star', result.pStar, out.P_star);
  cmp('sold', result.sold, sum(out.alloc));
  cmp('seller_usdc', result.sellerUsdc, out.seller_usdc);
  cmp('seller_tokens_back', result.sellerTokensBack, out.seller_tokens_back);
  cmp('token_dust', result.tokenDust, out.dust);
  cmp('penalty_pool', result.penaltyPool, sum(out.penalty));
  for (const b of bids) {
    cmp(`bid ${b.idx} alloc`, b.alloc, out.alloc[b.idx]!);
    cmp(`bid ${b.idx} spend`, b.spend, out.spend[b.idx]!);
    cmp(`bid ${b.idx} penalty`, b.penalty, out.penalty[b.idx]!);
    cmp(`bid ${b.idx} penalty_share`, b.penaltyShare, out.penalty_share[b.idx]!);
  }
  return { clear: out, diffs, match: diffs.length === 0 };
}

/** Refund of one bid as the contract pays it: escrow - spend - penalty + penalty share. */
export function refundOf(b: Pick<Bid, 'escrow' | 'spend' | 'penalty' | 'penaltyShare'>): bigint {
  return b.escrow - b.spend - b.penalty + b.penaltyShare;
}
