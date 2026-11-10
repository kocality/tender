import { keccak_256 } from '@noble/hashes/sha3.js';
import { b58encode, concatBytes, fromHex, utf8 } from './encoding.js';
import type { MultiPayload } from './types.js';

/** EVM bidder's Intents account: the lowercase 0x address (A11). */
export function evmSignerId(addr: string): string {
  const id = addr.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw new Error(`not an EVM address: ${addr}`);
  return id;
}

/** keccak256("\x19Ethereum Signed Message:\n" + len + msg), len = byte length in ASCII decimal. */
export function erc191Prehash(msg: string | Uint8Array): Uint8Array {
  const bytes = typeof msg === 'string' ? utf8(msg) : msg;
  return keccak_256(concatBytes(utf8(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
}

/** Wrap a personal_sign result (0x + 65 bytes r ‖ s ‖ v). v 27/28 → 0/1; the contract rejects any other v. */
export function erc191FromWallet(payloadStr: string, sigHex: string): MultiPayload {
  const sig = fromHex(sigHex);
  if (sig.length !== 65) throw new Error(`erc191 signature must be 65 bytes, got ${sig.length}`);
  const v = sig[64]!;
  if (v === 27 || v === 28) sig[64] = v - 27;
  else if (v !== 0 && v !== 1) throw new Error(`invalid erc191 recovery byte ${v}`);
  return { standard: 'erc191', payload: payloadStr, signature: `secp256k1:${b58encode(sig)}` };
}
