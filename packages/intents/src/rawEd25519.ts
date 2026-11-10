import { b58encode, toHex } from './encoding.js';
import type { MultiPayload } from './types.js';

/** Solana bidder's Intents account: the implicit account = 64 lowercase hex of the ed25519 key (A12). */
export function solanaSignerId(pk32: Uint8Array): string {
  if (pk32.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${pk32.length}`);
  return toHex(pk32);
}

/** Wrap a plain ed25519 signature over the UTF-8 bytes of the payload string (Phantom signMessage). */
export function rawEd25519FromWallet(payloadStr: string, pk32: Uint8Array, sig64: Uint8Array): MultiPayload {
  if (pk32.length !== 32) throw new Error(`ed25519 public key must be 32 bytes, got ${pk32.length}`);
  if (sig64.length !== 64) throw new Error(`ed25519 signature must be 64 bytes, got ${sig64.length}`);
  return {
    standard: 'raw_ed25519',
    payload: payloadStr,
    public_key: `ed25519:${b58encode(pk32)}`,
    signature: `ed25519:${b58encode(sig64)}`,
  };
}
