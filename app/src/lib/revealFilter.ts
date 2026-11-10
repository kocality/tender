import type { RevealItem } from '@tender/intents';
import type { DecryptResult } from './decrypt';
import type { Bid, Sale } from './views';

export const REVEAL_BATCH_SIZE = 8;

/** The reveal window is open while the sale is Keyed and chain time is before its deadline. */
export function revealWindowOpen(sale: Pick<Sale, 'state' | 'revealDeadlineNs'>, nowNs: bigint): boolean {
  return sale.state === 'Keyed' && sale.revealDeadlineNs !== null && nowNs < sale.revealDeadlineNs;
}

/**
 * Bids that may be revealed: decrypted with a matching commitment, 1 <= q <= escrow (the contract's reveal rule) and
 * still Sealed. One bad item makes the whole `reveal` call panic, so everything else is left out. Nothing is returned
 * unless the key check passed.
 */
export function revealable(decrypted: DecryptResult | null, bids: Pick<Bid, 'idx' | 'state' | 'bidder' | 'escrow'>[]): (RevealItem & { bidder: string })[] {
  if (!decrypted?.keyOk) return [];
  const byIdx = new Map(bids.map((b) => [b.idx, b]));
  const out: (RevealItem & { bidder: string })[] = [];
  for (const r of decrypted.rows) {
    const bid = byIdx.get(r.idx);
    if (r.status !== 'ok' || !bid || bid.state !== 'Sealed' || r.p === undefined || r.q === undefined || !r.salt) continue;
    if (r.q < 1n || r.q > bid.escrow) continue;
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

/**
 * Sends the batches one after another. Each batch waits for a wallet confirmation (minutes, perhaps), and another
 * tab, the keeper or a self-reveal can reveal some of its bids meanwhile, so the bids are read again right before
 * each batch and only the ones still Sealed go out (X12-01 tabs). A batch with nothing left is skipped. A failed
 * read or send stops the loop: it never sends a batch blind.
 */
export async function sendRevealBatches(o: {
  saleId: string;
  groups: RevealItem[][];
  load: (saleId: string) => Promise<Pick<Bid, 'idx' | 'state'>[]>;
  send: (saleId: string, items: RevealItem[]) => Promise<string | null>;
  onWaiting?: (i: number, n: number) => void;
  onSent?: (i: number, n: number, count: number, hash: string | null) => void;
  onSkipped?: (i: number, n: number) => void;
}): Promise<void> {
  for (const [i, g] of o.groups.entries()) {
    const sealed = new Set((await o.load(o.saleId)).filter((b) => b.state === 'Sealed').map((b) => b.idx));
    const items = g.filter((it) => sealed.has(it.idx));
    if (items.length === 0) {
      o.onSkipped?.(i, o.groups.length);
      continue;
    }
    o.onWaiting?.(i, o.groups.length);
    const hash = await o.send(o.saleId, items);
    o.onSent?.(i, o.groups.length, items.length, hash);
  }
}

/** Sealed bids that cannot be revealed: they will be penalized if they are still unrevealed when the window ends. */
export function unrevealable(decrypted: DecryptResult | null, bids: Pick<Bid, 'idx' | 'state' | 'escrow'>[]): number[] {
  if (!decrypted) return [];
  const ok = new Set(revealable(decrypted, bids.map((b) => ({ ...b, bidder: '' }))).map((i) => i.idx));
  return bids.filter((b) => b.state === 'Sealed' && !ok.has(b.idx)).map((b) => b.idx);
}
