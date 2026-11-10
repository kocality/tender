import type { RevealItem } from '@tender/intents';
import type { DecryptResult } from './decrypt';
import type { Bid, Sale } from './views';

export const REVEAL_BATCH_SIZE = 8;

/** The reveal window is open while the sale is Keyed and chain time is before its deadline. */
export function revealWindowOpen(sale: Pick<Sale, 'state' | 'revealDeadlineNs'>, nowNs: bigint): boolean {
  return sale.state === 'Keyed' && sale.revealDeadlineNs !== null && nowNs < sale.revealDeadlineNs;
}

/**
 * Bids that may be revealed: decrypted with a matching commitment and still Sealed. One bad item makes the whole
 * `reveal` call panic, so everything else is left out. Nothing is returned unless the key check passed.
 */
export function revealable(decrypted: DecryptResult | null, bids: Pick<Bid, 'idx' | 'state' | 'bidder'>[]): (RevealItem & { bidder: string })[] {
  if (!decrypted?.keyOk) return [];
  const byIdx = new Map(bids.map((b) => [b.idx, b]));
  const out: (RevealItem & { bidder: string })[] = [];
  for (const r of decrypted.rows) {
    const bid = byIdx.get(r.idx);
    if (r.status !== 'ok' || !bid || bid.state !== 'Sealed' || r.p === undefined || r.q === undefined || !r.salt) continue;
    out.push({ idx: r.idx, p: r.p.toString(), q: r.q.toString(), salt: r.salt, bidder: bid.bidder });
  }
  return out;
}

/** Items without the local-only bidder field, as the contract wants them. */
export function toRevealItems(items: (RevealItem & { bidder?: string })[]): RevealItem[] {
  return items.map(({ idx, p, q, salt }) => ({ idx, p, q, salt }));
}

export function batches<T>(items: T[], size = REVEAL_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Sealed bids that cannot be revealed: they will be penalized if they are still unrevealed when the window ends. */
export function unrevealable(decrypted: DecryptResult | null, bids: Pick<Bid, 'idx' | 'state'>[]): number[] {
  if (!decrypted) return [];
  const ok = new Set(revealable(decrypted, bids.map((b) => ({ ...b, bidder: '' }))).map((i) => i.idx));
  return bids.filter((b) => b.state === 'Sealed' && !ok.has(b.idx)).map((b) => b.idx);
}
