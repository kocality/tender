// Persistent UI text. The honest-claims rule applies to every string in this app.

export const TRUST_LINE =
  "Privacy rests on NEAR's MPC threshold (11 of 16 nodes on 2026-11-10; `pnpm verify` prints the live value). We add no TEE and no committee of our own; the MPC nodes additionally run in attested TEEs. Resharing does not revoke old shares, so the condition is fewer than 11 of the parties that hold or ever held a share of the domain-2 key.";

export const OPEN_RULE =
  "At close anyone can call open(). The locked contract asks NEAR's MPC network for the sale's key only if the sale's public open conditions hold: total escrow ≥ min_escrow and distinct bidders ≥ min_bidders. These conditions read public escrow, not sealed prices.";

export const HOSTED_BUNDLE =
  'If this hosted page were malicious it could leak your price before sealing, or swap the sealed bid you paste. Run the app locally, or seal with `pnpm seal:bid`, paste the result below and check that the cm in your wallet prompt equals the cm it printed. Paste only output you produced yourself.';

/** The penalty as the contract applies it: the 10% stays in the contract's NEAR Intents balance and no Tender method pays it out. Every screen that mentions the penalty says this. */
export const PENALTY_RULE =
  "When at least one bid in the sale is revealed, an unrevealed bid gets 90% of its escrow back (100% if no bid is revealed). The other 10% stays in the contract's NEAR Intents balance. No Tender method pays it to anyone: not to the seller, not to other bidders, not to us. Like any Intents balance, intents.near's own admin roles could move it.";

/** Why a relayed bid can be missing from the sale: the contract refunds it with one of these reasons (the refund event is in the transaction logs). */
export const NOT_STORED_CAUSES =
  "Usual causes: the bid arrived after close, the sale is full (maximum bids or escrow cap), the bid came from the sale's own seller account (refund reason seller_bid), or the message is over 2048 bytes (refund reason msg_too_long; this page never sends one that long). A refund lands in your NEAR Intents balance; Withdraw moves it out.";

/** Intents balances credited to the contract outside a bid or reveal message cannot be moved again (the contract has no admin method). */
export const UNRECOVERABLE_TRANSFER =
  'Only place bids through this page or `pnpm seal:bid`. A plain Intents transfer to the contract without a bid message credits the contract and cannot be recovered: it has no admin method.';

export const VERIFY_KEYS_LINE = 'Check it: `pnpm verify --keys`';

const ORIGIN_NAMES = { base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR' } as const;

/** Chain badge text. The origin is declared by the bidder, never proof of where the funds came from (C7). */
export function originBadge(origin: string | null | undefined): string {
  const name = Object.hasOwn(ORIGIN_NAMES, origin ?? '') ? ORIGIN_NAMES[origin as keyof typeof ORIGIN_NAMES] : undefined;
  return name ? `via ${name} (self-declared)` : 'origin not declared';
}

/** The only place the "never requested" label may be produced: Cancelled with zero key requests. */
export function cancelledLabel(state: string, keyRequests: string | number | bigint): string | null {
  if (state !== 'Cancelled') return null;
  const n = BigInt(keyRequests);
  if (n === 0n) return 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';
  return `Cancelled after ${n} key requests · may be decryptable`;
}

export const TRY_RESULT = {
  insufficientBalance: 'signature valid · insufficient balance (simulation only, nothing was sent)',
  notRegistered:
    "signature valid · this NEAR key is not registered in NEAR Intents yet (named accounts register once; implicit and EVM/Solana accounts don't need to)",
  otherAccount: 'the signature was made by a different account than the one shown (switch the wallet back to it, or reconnect)',
  funded: 'signature valid · this account holds funds; simulation only, nothing was sent',
} as const;
