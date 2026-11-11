import { b58decode, isEd25519Point } from '@tender/intents';
import { isAddress } from 'viem';
import { ORIGIN_ASSET, ORIGIN_TOKEN_ADDRESS } from './oneclick';

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

const NOT_A_WALLET = 'This is not a wallet address (a contract, mint, program or burn address). Funds sent there are lost. Enter the address of your own wallet.';

/** Addresses that pass every format check but are never somebody's wallet: sending USDC there loses it (X12A-04). */
const EVM_NOT_WALLETS = new Set(
  ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', ORIGIN_TOKEN_ADDRESS.base, ORIGIN_TOKEN_ADDRESS.arb].map((a) => a.toLowerCase()),
);

/** System Program, USDC mint, wrapped SOL mint, Token, Token-2022 and associated token account programs: on the curve, so only a list catches them. */
const SOL_NOT_WALLETS = new Set([
  '11111111111111111111111111111111',
  ORIGIN_TOKEN_ADDRESS.sol,
  'So11111111111111111111111111111111111111112',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
]);

/** `null` when `address` is a valid recipient on `chain`, else the message to show. */
export function recipientError(chain: DestChain, address: string): string | null {
  const a = address.trim();
  if (a === '') return 'Enter the recipient address.';
  if (chain === 'sol') {
    try {
      const raw = b58decode(a);
      if (raw.length === 32) {
        // A wallet is a point on the ed25519 curve; PDAs, vaults and token accounts' owners are not. 1Click pays them out all the same.
        return isEd25519Point(raw) && !SOL_NOT_WALLETS.has(a) ? null : NOT_A_WALLET;
      }
    } catch {
      // not base58
    }
    return 'Not a Solana address (base58, 32 bytes).';
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return 'Not an EVM address (0x followed by 40 hex characters).';
  if (EVM_NOT_WALLETS.has(a.toLowerCase())) return NOT_A_WALLET;
  // A mixed-case address carries an EIP-55 checksum: one wrong character in it is a typo that would send the funds to nobody.
  return isAddress(a, { strict: true }) ? null : 'The checksum of this address is wrong (upper and lower case letters do not match EIP-55). Check it character by character, or paste it in lower case.';
}

/** The connected wallet's own address on `chain`; empty when the wallet lives on another chain. */
export function defaultRecipient(chain: DestChain, signer: { kind: 'evm' | 'phantom' | 'near'; signerId: string; publicKey?: string }): string {
  if (chain === 'sol') return signer.kind === 'phantom' ? (signer.publicKey ?? '') : '';
  return signer.kind === 'evm' ? signer.signerId : '';
}
