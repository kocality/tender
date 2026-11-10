// Persistent UI text. The honest-claims rule applies to every string in this app.

export const TRUST_LINE =
  "Privacy rests on NEAR's MPC threshold (11 of 16 nodes on 2026-11-10; `pnpm verify` prints the live value). We add no TEE and no committee of our own; the MPC nodes additionally run in attested TEEs.";

export const OPEN_RULE =
  "At close anyone can call open(). The locked contract asks NEAR's MPC network for the sale's key only if the sale's public open conditions hold: total escrow ≥ min_escrow and distinct bidders ≥ min_bidders. These conditions read public escrow, not sealed prices.";

export const HOSTED_BUNDLE =
  'If this hosted page were malicious it could leak your price before sealing, or swap the sealed bid you paste. Run the app locally, or seal with `pnpm seal:bid`, paste the result below and check that the cm in your wallet prompt equals the cm it printed. Paste only output you produced yourself.';

export const VERIFY_KEYS_LINE = 'Check it: `pnpm verify --keys`';

const ORIGIN_NAMES = { base: 'Base', arb: 'Arbitrum', sol: 'Solana', near: 'NEAR' } as const;

/** Chain badge text. The origin is declared by the bidder, never proof of where the funds came from (C7). */
export function originBadge(origin: string | null | undefined): string {
  const name = ORIGIN_NAMES[origin as keyof typeof ORIGIN_NAMES];
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
