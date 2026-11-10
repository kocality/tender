import { fromHex, type RevealItem } from '@tender/intents';
import { commitmentHex } from '@tender/seal';
import type { Bid } from './views';

// "Reveal from my bid file": `pnpm seal:bid` keeps {sale, contract, network, signer, cm, p, q, salt, ...} in ~/.tender/bids/ (0600).
// That file is the one recovery path when the sale key cannot decrypt a bid here (a wrong key, a ciphertext that does not open).
// Nothing in a file is trusted: the commitment is recomputed with the bidder and escrow the contract holds, so only a bid the contract will accept is offered.

export interface BidFileTarget {
  saleId: string;
  contract: string;
  network: 'mainnet' | 'testnet';
}

export interface BidFileItems {
  items: (RevealItem & { bidder: string })[];
  /** One line per file that gave no item, for the page to show. */
  notes: string[];
}

const U64_MAX = (1n << 64n) - 1n;

const uint = (v: unknown): bigint | null => (typeof v === 'string' && /^[0-9]{1,20}$/.test(v) && BigInt(v) <= U64_MAX ? BigInt(v) : null);

export function itemsFromBidFiles(texts: string[], bids: Pick<Bid, 'idx' | 'state' | 'bidder' | 'escrow' | 'cm'>[], target: BidFileTarget): BidFileItems {
  const items: BidFileItems['items'] = [];
  const notes: string[] = [];
  texts.forEach((text, n) => {
    const at = `File ${n + 1}`;
    let o: Record<string, unknown>;
    try {
      const j = JSON.parse(text) as unknown;
      if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('not an object');
      o = j as Record<string, unknown>;
    } catch {
      notes.push(`${at}: not a bid file (expected the JSON that \`pnpm seal:bid\` saved).`);
      return;
    }
    if (String(o.sale) !== target.saleId) return void notes.push(`${at}: this bid is for sale ${String(o.sale)}, this page is sale ${target.saleId}.`);
    if (o.contract !== target.contract || o.network !== target.network) {
      return void notes.push(`${at}: sealed for ${String(o.contract)} on ${String(o.network)}, but this page uses ${target.contract} on ${target.network}.`);
    }
    const p = uint(o.p);
    const q = uint(o.q);
    if (p === null || q === null || typeof o.salt !== 'string' || !/^[0-9a-f]{32}$/.test(o.salt) || typeof o.cm !== 'string') {
      return void notes.push(`${at}: p, q, salt or cm is missing or malformed.`);
    }
    const bid = bids.find((b) => b.cm === o.cm);
    if (!bid) return void notes.push(`${at}: its commitment matches no bid of sale ${target.saleId} (re-sealed or refunded bid).`);
    if (bid.state !== 'Sealed') return void notes.push(`${at}: bid #${bid.idx} is already ${bid.state}.`);
    if (commitmentHex({ sale: BigInt(target.saleId), bidder: bid.bidder, B: bid.escrow, p, q, salt: fromHex(o.salt) }) !== bid.cm) {
      return void notes.push(`${at}: p, q and salt do not open bid #${bid.idx} (its bidder or escrow differs from the file).`);
    }
    if (q < 1n || q > bid.escrow) return void notes.push(`${at}: bid #${bid.idx} has a size outside 1..escrow, the contract refuses to reveal it.`);
    if (items.some((i) => i.idx === bid.idx)) return void notes.push(`${at}: bid #${bid.idx} is already listed from another file.`);
    items.push({ idx: bid.idx, p: p.toString(), q: q.toString(), salt: o.salt, bidder: bid.bidder });
  });
  return { items, notes };
}
