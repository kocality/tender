import { b58decode } from '@tender/intents';
import { ORIGIN_ASSET } from './oneclick';

// What can leave an Intents account and where it can go (1Click INTENTS -> DESTINATION_CHAIN).

export type DestChain = 'base' | 'arb' | 'sol';

export interface WithdrawSource {
  tokenId: string;
  symbol: string;
  decimals: number;
}

export interface WithdrawTarget {
  id: 'base-usdc' | 'arb-usdc' | 'sol-usdc' | 'sol';
  label: string;
  assetId: string;
  chain: DestChain;
  symbol: string;
  decimals: number;
}

/** Tokens a bidder may hold in Intents after a sale: the sale's quote token (USDC), wNEAR and JAMBO. */
export function withdrawSources(quoteToken: string): WithdrawSource[] {
  const all: WithdrawSource[] = [
    { tokenId: quoteToken, symbol: 'USDC', decimals: 6 },
    { tokenId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 },
    { tokenId: 'nep141:jambo-1679.meme-cooking.near', symbol: 'JAMBO', decimals: 18 },
  ];
  return all.filter((s, i) => all.findIndex((x) => x.tokenId === s.tokenId) === i);
}

export const WITHDRAW_TARGETS: WithdrawTarget[] = [
  { id: 'base-usdc', label: 'Base USDC', assetId: ORIGIN_ASSET.base, chain: 'base', symbol: 'USDC', decimals: 6 },
  { id: 'arb-usdc', label: 'Arbitrum USDC', assetId: ORIGIN_ASSET.arb, chain: 'arb', symbol: 'USDC', decimals: 6 },
  { id: 'sol-usdc', label: 'Solana USDC', assetId: ORIGIN_ASSET.sol, chain: 'sol', symbol: 'USDC', decimals: 6 },
  { id: 'sol', label: 'Solana SOL', assetId: 'nep141:sol.omft.near', chain: 'sol', symbol: 'SOL', decimals: 9 },
];

const EXPLORER_TX: Record<DestChain, string> = {
  base: 'https://basescan.org/tx/',
  arb: 'https://arbiscan.io/tx/',
  sol: 'https://solscan.io/tx/',
};

export function destinationTxUrl(chain: DestChain, hash: string): string {
  return `${EXPLORER_TX[chain]}${hash}`;
}

/** `null` when `address` is a valid recipient on `chain`, else the message to show. */
export function recipientError(chain: DestChain, address: string): string | null {
  const a = address.trim();
  if (a === '') return 'Enter the recipient address.';
  if (chain === 'sol') {
    try {
      if (b58decode(a).length === 32) return null;
    } catch {
      // not base58
    }
    return 'Not a Solana address (base58, 32 bytes).';
  }
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? null : 'Not an EVM address (0x followed by 40 hex characters).';
}

/** The connected wallet's own address on `chain`; empty when the wallet lives on another chain. */
export function defaultRecipient(chain: DestChain, signer: { kind: 'evm' | 'phantom' | 'near'; signerId: string; publicKey?: string }): string {
  if (chain === 'sol') return signer.kind === 'phantom' ? (signer.publicKey ?? '') : '';
  return signer.kind === 'evm' ? signer.signerId : '';
}
