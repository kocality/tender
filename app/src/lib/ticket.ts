import { bidNonce, toBase64 } from '@tender/intents';

// The saved ticket of one sealed bid (DOUBLE-PLAN layer 4, step 6). A reload, a second tab or a crash after an unclear relay
// answer must find the bid again and ask the chain about it before it funds, quotes or seals anything. The ticket holds the
// public parts only (cm, ct, escrow, the pinned Intents salt, seq, the payload deadline, tx hashes): never a price, a size, the
// commitment salt, a signature or a key. Every access is guarded: blocked storage means "the page does not remember", never a crash.

export interface Ticket {
  v: 1;
  network: string;
  contract: string;
  sale: string;
  /** The sale's creation time: a testnet redeploy that reuses sale ids must not restore an old bid. */
  saleCreatedNs: string;
  signer: string;
  /** Every commitment this plan sealed (a re-seal after a refund adds one); the last one is the live bid. */
  cms: string[];
  ct: string;
  /** Escrow B in micro-USDC. */
  B: string;
  origin: 'base' | 'arb' | 'sol' | 'near';
  /** The Intents salt pinned when the bid was sealed (8 hex). */
  intentsSalt: string;
  /** Stored bids of this account in the sale when the plan began; fixed for the plan. */
  seq: number;
  closeNs: string;
  /** A signed payload of this plan left the page. */
  sent: boolean;
  /** The latest payload deadline signed for this plan (ms, chain clock). */
  payloadDeadlineMs: number | null;
  txHashes: string[];
  /** The account that signed the relayer's transactions (needed to look their hashes up). */
  relayer: string | null;
  /** Chain time (ms) at which "nonce used, no bid row yet" was first seen. */
  usedSeenMs: number | null;
}

export type TicketKey = Pick<Ticket, 'network' | 'contract' | 'sale' | 'saleCreatedNs' | 'signer'>;

export const ticketKey = (k: TicketKey): string => `tender:ticket:v1:${k.network}:${k.contract}:${k.sale}:${k.saleCreatedNs}:${k.signer}`;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadTicket(k: TicketKey): Ticket | null {
  try {
    const raw = store()?.getItem(ticketKey(k));
    const t = raw ? (JSON.parse(raw) as Ticket) : null;
    return t?.v === 1 && Array.isArray(t.cms) && t.cms.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** `false` when the browser would not keep it (blocked storage, private window, full). */
export function saveTicket(t: Ticket): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(ticketKey(t), JSON.stringify(t));
    return loadTicket(t) !== null;
  } catch {
    return false;
  }
}

export function clearTicket(k: TicketKey): void {
  try {
    store()?.removeItem(ticketKey(k));
  } catch {
    // storage is only a convenience
  }
}

/**
 * Saves a freshly sealed ticket unless another live ticket already holds this sale and account (a second tab): that one is
 * returned instead and the caller shows it. A re-seal of the same plan (the stored ticket is the caller's own, `own`) replaces it.
 */
export function claimTicket(t: Ticket, own: boolean): { ticket: Ticket; saved: boolean; restored: boolean } {
  const live = loadTicket(t);
  if (live && !own && !live.cms.includes(t.cms[t.cms.length - 1]!)) return { ticket: live, saved: true, restored: true };
  return { ticket: t, saved: saveTicket(t), restored: false };
}

/** The ticket alone gives the nonce of its live bid: no signature has to be stored to ask intents.near whether it ran. */
export const ticketNonceB64 = (t: Ticket, cm: string = t.cms[t.cms.length - 1]!): string =>
  toBase64(bidNonce({ saltHex: t.intentsSalt, closeNs: BigInt(t.closeNs), contract: t.contract, sale: t.sale, signer: t.signer, cm }));
