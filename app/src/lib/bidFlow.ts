import type { IntentsErrorKind } from '@tender/intents';
import { parseUnits, priceToP } from './amounts';
import { humanError } from './errors';
import { depositAmountFor } from './oneclick';
import type { Sale } from './views';

// Pure decisions of the bid wizard: what to validate, when funding is skipped and where each failure sends the user.

export const MIN_ESCROW = 1_000_000n; // 1 USDC per bid (the contract refunds anything smaller)
const U64_MAX = (1n << 64n) - 1n;

export type Step = 'wallet' | 'bid' | 'fund' | 'seal' | 'sign' | 'relay' | 'done';

export const STEPS: { id: Step; label: string }[] = [
  { id: 'wallet', label: 'Connect wallet' },
  { id: 'bid', label: 'Price, size and escrow' },
  { id: 'fund', label: 'Fund your Intents account' },
  { id: 'seal', label: 'Seal in your browser' },
  { id: 'sign', label: 'Sign one transfer' },
  { id: 'relay', label: 'Relay' },
  { id: 'done', label: 'Bid stored' },
];

export type BidValidation =
  | { ok: true; p: bigint; q: bigint; B: bigint; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Checks the form against the sale. `q` is the most the bidder will spend (USDC), `B` the escrow that is locked.
 * Chain time (`nowNs`) decides whether the sale is still open for bids.
 */
export function validateBid(o: {
  priceText: string;
  sizeText: string;
  escrowText: string;
  sale: Pick<Sale, 'state' | 'closeNs' | 'reserve' | 'lotExp'>;
  nowNs: bigint;
}): BidValidation {
  const errors: string[] = [];
  let p = 0n;
  let q = 0n;
  let B = 0n;
  try {
    p = priceToP(o.priceText, o.sale.lotExp);
  } catch (e) {
    errors.push(`Price: ${(e as Error).message}`);
  }
  try {
    q = parseUnits(o.sizeText, 6);
  } catch (e) {
    errors.push(`Size: ${(e as Error).message}`);
  }
  try {
    B = parseUnits(o.escrowText, 6);
  } catch (e) {
    errors.push(`Escrow: ${(e as Error).message}`);
  }
  if (errors.length === 0) {
    if (B < MIN_ESCROW) errors.push('Escrow must be at least 1 USDC.');
    if (q < 1n) errors.push('Size must be above zero.');
    if (q > B) errors.push('Size cannot exceed the escrow.');
    if (q > U64_MAX) errors.push('Size is too large.');
  }
  if (o.sale.state !== 'Open') errors.push(`This sale is ${o.sale.state}; it no longer takes bids.`);
  else if (o.nowNs >= o.sale.closeNs) errors.push('This sale is closed.');
  if (errors.length > 0) return { ok: false, errors };
  const warnings: string[] = [];
  if (p < o.sale.reserve) {
    warnings.push(
      'Below reserve: this bid will not win and will be refunded in full; it still counts toward the public open conditions.',
    );
  }
  return { ok: true, p, q, B, warnings };
}

export type FundDecision = { skip: true } | { skip: false; gap: bigint; deposit: bigint };

/** Skip the deposit when the Intents account already holds the escrow. */
export function fundDecision(balance: bigint, escrow: bigint): FundDecision {
  if (balance >= escrow) return { skip: true };
  const gap = escrow - balance;
  return { skip: false, gap, deposit: depositAmountFor(gap) };
}

export type Recovery =
  | { to: 'fund'; message: string }
  | { to: 'register_key'; message: string }
  | { to: 'sign_again'; message: string }
  | { to: 'retry'; message: string }
  | { to: 'fail'; message: string };

/** Where a failed pre-flight simulation or a refused relay sends the user. The message is the one-sentence `humanError` text. */
export function recoveryFor(kind: IntentsErrorKind | 'busy' | 'unconfigured' | 'unavailable', detail: string): Recovery {
  const message = humanError(kind, detail);
  switch (kind) {
    case 'insufficient_balance':
      return { to: 'fund', message };
    case 'public_key_not_registered':
      return { to: 'register_key', message };
    case 'invalid_salt':
    case 'deadline_expired':
    case 'deadline_gt_nonce':
    case 'nonce_expired':
      return { to: 'sign_again', message };
    case 'busy':
      return { to: 'retry', message };
    default:
      return { to: 'fail', message };
  }
}

/** Existing bids of this signer in the sale (informational: several bids are allowed). */
export function bidsOf(bids: { bidder: string }[], signerId: string): number {
  return bids.filter((b) => b.bidder === signerId).length;
}
