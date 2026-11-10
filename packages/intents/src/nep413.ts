import { sha256 } from '@noble/hashes/sha2.js';
import { b58encode, concatBytes, fromBase64, toBase64, utf8 } from './encoding.js';
import { nep413Message } from './payload.js';
import type { DefusePayload, MultiPayload } from './types.js';

/** NEP-461 offchain prefix tag for NEP-413: 2^31 + 413. */
export const NEP413_TAG = 2147484061;

function u32le(x: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, x, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const b = utf8(s);
  return concatBytes(u32le(b.length), b);
}

export interface Nep413Input {
  message: string;
  nonce32: Uint8Array;
  recipient: string;
  callbackUrl?: string;
}

/** borsh(u32 tag) ‖ borsh(Nep413Payload{message, nonce[32], recipient, callback_url: Option<String>}). */
export function nep413Borsh({ message, nonce32, recipient, callbackUrl }: Nep413Input): Uint8Array {
  if (nonce32.length !== 32) throw new Error(`nep413 nonce must be 32 bytes, got ${nonce32.length}`);
  const callback = callbackUrl === undefined ? Uint8Array.of(0) : concatBytes(Uint8Array.of(1), borshString(callbackUrl));
  return concatBytes(u32le(NEP413_TAG), borshString(message), nonce32, borshString(recipient), callback);
}

export function nep413Prehash(input: Nep413Input): Uint8Array {
  return sha256(nep413Borsh(input));
}

/**
 * Wrap a NEAR wallet signMessage result. `signature` is either "ed25519:<b58>" or base64 (most wallets).
 * The envelope recipient is the payload's verifying_contract.
 */
export function nep413FromWallet({
  payload,
  nonce32,
  publicKey,
  signature,
}: {
  payload: DefusePayload;
  nonce32: Uint8Array;
  publicKey: string;
  signature: string;
}): MultiPayload {
  const nonce = toBase64(nonce32);
  if (nonce !== payload.nonce) throw new Error('nep413 nonce does not match payload nonce');
  return {
    standard: 'nep413',
    payload: { message: nep413Message(payload), nonce, recipient: payload.verifying_contract },
    public_key: publicKey,
    signature: signature.startsWith('ed25519:') ? signature : `ed25519:${b58encode(fromBase64(signature))}`,
  };
}
