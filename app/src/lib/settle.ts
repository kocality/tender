import { classifyTx, fetchTx, isNonceUsed, rpcRequest, type TxOutcome } from '@tender/intents';
import { config } from '../config';
import { ticketNonceB64, type Ticket } from './ticket';
import { getAllBids } from './views';

// The one resolver (DOUBLE-PLAN layer 4, point 3). After any unclear relay answer, and after anything that could mean
// "an earlier signature already ran", the page asks the chain what became of the bid before it offers to fund, quote, seal
// or sign for it again. Every read is made at one final block so the answers describe the same moment.

export interface BidRow {
  idx: number;
  bidder: string;
  cm: string;
  escrow?: bigint;
}

export interface SettleIO {
  finalBlock(): Promise<{ height: number; tsMs: number }>;
  bids(at: number): Promise<BidRow[]>;
  /** Whether the Intents nonce of any commitment of the ticket was used. */
  nonceUsed(at: number): Promise<boolean>;
  /** What Tender logged for the transactions the relayer sent for this ticket; empty when there are none to read. */
  txOutcomes(): Promise<(TxOutcome | null)[]>;
}

export type Settled =
  | { kind: 'stored'; idx: number; cm: string }
  /** `bid_seq`: another bid of this account took the slot; `other`: Tender refused it for the named reason, or nothing was stored 90 s after the nonce was used. */
  | { kind: 'refunded'; why: string; other?: number[] }
  /** The nonce is used and Tender's receipt has not shown a bid yet: the money moved, the bid is on its way. Never "refunded". */
  | { kind: 'executed'; sinceMs: number }
  /** Not used yet and still able to land until `untilMs`. */
  | { kind: 'pending'; untilMs: number }
  /** Not used and its deadline passed: this signature can never run. */
  | { kind: 'dead' }
  | { kind: 'unknown' };

/** How long Tender's receipt may trail the Intents receipt before "used, no bid" is read as a refund (chain time). */
export const TENDER_WAIT_MS = 90_000;

export async function settle(io: SettleIO, t: Ticket): Promise<{ verdict: Settled; usedSeenMs: number | null }> {
  try {
    const b = await io.finalBlock();
    const [bids, used, outcomes] = await Promise.all([io.bids(b.height), io.nonceUsed(b.height), io.txOutcomes().catch(() => [])]);
    const mine = bids.filter((x) => x.bidder === t.signer);
    // "Stored" is only ever a bid row with one of this plan's commitments. A relayer 409, a tx event or a row of another bid does not count.
    const ours = mine.find((x) => t.cms.includes(x.cm));
    if (ours) return { verdict: { kind: 'stored', idx: ours.idx, cm: ours.cm }, usedSeenMs: t.usedSeenMs };
    const refund = outcomes.find((o) => o?.kind === 'refunded');
    if (refund?.kind === 'refunded') {
      return { verdict: { kind: 'refunded', why: refund.reason, ...(refund.reason === 'bid_seq' ? { other: mine.map((x) => x.idx) } : {}) }, usedSeenMs: t.usedSeenMs };
    }
    if (used) {
      if (mine.length > t.seq) return { verdict: { kind: 'refunded', why: 'bid_seq', other: mine.map((x) => x.idx) }, usedSeenMs: t.usedSeenMs ?? b.tsMs };
      const since = t.usedSeenMs ?? b.tsMs;
      const verdict: Settled = b.tsMs - since > TENDER_WAIT_MS ? { kind: 'refunded', why: 'other' } : { kind: 'executed', sinceMs: since };
      return { verdict, usedSeenMs: since };
    }
    // Sent, a transaction is still executing: its Intents receipt has not committed the nonce at this block yet.
    if (outcomes.some((o) => o?.kind === 'running')) return { verdict: { kind: 'executed', sinceMs: t.usedSeenMs ?? b.tsMs }, usedSeenMs: t.usedSeenMs };
    if (t.payloadDeadlineMs !== null && b.tsMs <= t.payloadDeadlineMs) return { verdict: { kind: 'pending', untilMs: t.payloadDeadlineMs }, usedSeenMs: t.usedSeenMs };
    return { verdict: { kind: 'dead' }, usedSeenMs: t.usedSeenMs };
  } catch {
    return { verdict: { kind: 'unknown' }, usedSeenMs: t.usedSeenMs };
  }
}

/** What the page may offer for a settled ticket. "Sign" of the same ticket is always harmless: its nonce is the same. */
export function offers(v: Settled): { sign: boolean; fund: boolean; seal: boolean; another: boolean } {
  switch (v.kind) {
    case 'stored':
      return { sign: false, fund: false, seal: false, another: true };
    case 'refunded':
      return { sign: false, fund: true, seal: true, another: false }; // the nonce is spent: seal again, never sign again
    case 'dead':
      return { sign: true, fund: true, seal: false, another: false };
    default:
      return { sign: true, fund: false, seal: false, another: false }; // executed, pending, unknown
  }
}

/** The verdict closes the ticket (it will not be asked about again). */
export const isFinal = (v: Settled): boolean => v.kind === 'stored' || v.kind === 'refunded' || v.kind === 'dead';

/** One sentence for a verdict that is not final yet (the page shows it next to the buttons it still offers). `hhmm` formats an instant in ms. */
export function pendingText(v: Settled, hhmm: (ms: number) => string): string {
  switch (v.kind) {
    case 'pending':
      return `Your signed bid may still land until ${hhmm(v.untilMs)}. Funding, sealing and a second bid stay off until the chain says what became of it. Signing again is safe: it repeats the same nonce.`;
    case 'executed':
      return 'The bid was executed in NEAR Intents and the contract has not logged it yet. This page keeps checking; do not fund or seal again.';
    case 'dead':
      return 'The signature expired without running, so nothing was spent. Sign again (it repeats the same nonce) or start over.';
    case 'unknown':
      return 'The chain could not be read just now, so nothing is known about this bid. Check again before you fund or seal anything.';
    default:
      return '';
  }
}

/** The result line of a bid that was refunded, with the reason when the chain showed one. */
export function refundedText(why: string, other?: number[]): string {
  if (why === 'bid_seq') {
    const ids = (other ?? []).map((i) => `#${i}`).join(', ');
    return `Not stored: another bid of yours${ids ? ` (${ids})` : ''} took this slot while this one was on its way, so the contract refunded this one in full (reason bid_seq). Nothing is lost.`;
  }
  if (why === 'dup_bid') return 'Not stored: the contract already holds this sealed bid, so it refunded the copy (reason dup_bid).';
  return '';
}

export type FailureRoute = 'settle' | 'retry' | 'fund' | 'sign_again' | 'other';

/** Where a failed simulation or relay goes. After a payload of the plan has been sent, every answer except "busy" asks the chain first. */
export function routeFailure(kind: string, sent: boolean): FailureRoute {
  if (kind === 'busy') return 'retry';
  if (sent) return 'settle';
  if (kind === 'insufficient_balance') return 'fund';
  if (kind === 'nonce_used' || kind === 'execute_unknown' || kind === 'already_stored' || kind === 'bid_seq') return 'settle';
  if (['deadline_expired', 'invalid_salt', 'nonce_expired', 'deadline_gt_nonce'].includes(kind)) return 'sign_again';
  return 'other';
}

export type PreSign =
  | { ok: true }
  /** The same bid is already stored: show it, ask for no signature. */
  | { stored: number; cm: string }
  /** The nonce ran but no row yet: let the resolver decide. */
  | { settle: true }
  /** This account has more bids than the plan's `seq` now: name them and let the user choose. */
  | { stale: number[] }
  /** The read failed. `signAnyway`: the plan was sent before, so a signature repeats the same nonce and is harmless. */
  | { retry: true; signAnyway: boolean };

/** The read just before the wallet prompt of "Sign", at one final block. */
export function preSign(r: { bids: BidRow[]; used: boolean } | null, t: Pick<Ticket, 'signer' | 'cms' | 'seq' | 'sent'>): PreSign {
  if (!r) return { retry: true, signAnyway: t.sent };
  const mine = r.bids.filter((b) => b.bidder === t.signer);
  const same = mine.find((b) => t.cms.includes(b.cm));
  if (same) return { stored: same.idx, cm: same.cm };
  if (r.used) return { settle: true };
  if (mine.length > t.seq) return { stale: mine.map((b) => b.idx) };
  return { ok: true };
}

// ---- production reads ----

export async function finalBlock(): Promise<{ height: number; tsMs: number }> {
  const block = (await rpcRequest(config.rpcUrls, 'block', { finality: 'final' })) as { header: { height: number; timestamp_nanosec: string } };
  return { height: block.header.height, tsMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) };
}

/** The account's bids in one sale at one final block. `null` when a read failed. */
export async function readBids(sale: string): Promise<{ height: number; tsMs: number; bids: BidRow[] } | null> {
  try {
    const b = await finalBlock();
    return { ...b, bids: await getAllBids(sale, b.height) };
  } catch {
    return null;
  }
}

/** Nonce reads for the live ticket, plus the bids, at one block: what the pre-sign check needs. */
export async function readForSign(t: Ticket): Promise<{ bids: BidRow[]; used: boolean } | null> {
  try {
    const b = await finalBlock();
    const [bids, used] = await Promise.all([getAllBids(t.sale, b.height), ticketNonceUsed(t, b.height)]);
    return { bids, used };
  } catch {
    return null;
  }
}

// Only the live (last) commitment's nonce counts: an earlier one of the plan was refunded and its nonce stays spent.
async function ticketNonceUsed(t: Ticket, at: number): Promise<boolean> {
  return isNonceUsed(config.rpcUrls, config.intentsContractId, t.signer, ticketNonceB64(t), { blockId: at });
}

export function chainIO(t: Ticket): SettleIO {
  return {
    finalBlock,
    bids: (at) => getAllBids(t.sale, at),
    nonceUsed: (at) => ticketNonceUsed(t, at),
    txOutcomes: async () => {
      if (!t.relayer || t.txHashes.length === 0) return [];
      const relayer = t.relayer;
      return Promise.all(
        t.txHashes.map(async (h) => {
          const res = await fetchTx(config.rpcUrls, h, relayer);
          return res === null ? null : classifyTx(res, t.contract, t.signer);
        }),
      );
    },
  };
}
