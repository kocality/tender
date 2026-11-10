import { fromBase64, fromHex, toHex } from './encoding.js';

// Versioned nonce V1 (near/intents @16d04f6e nonce/versioned.rs):
// magic(4) ‖ version 0x00 ‖ salt(4) ‖ deadline i64 LE ns ‖ random(15) = 32 bytes.
export const VERSIONED_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);

/**
 * Deadline rounded down to a whole second, so the payload deadline (RFC 3339, ms precision)
 * and the nonce deadline (ns) are the same instant (the contract rejects payload > nonce).
 */
export function makeDeadline(nowMs = Date.now(), ttlMs = 600_000): { deadlineMs: number; deadlineIso: string } {
  const deadlineMs = Math.floor((nowMs + ttlMs) / 1000) * 1000;
  return { deadlineMs, deadlineIso: new Date(deadlineMs).toISOString() };
}

export function buildVersionedNonce({
  saltHex,
  deadlineMs,
  random15,
}: {
  saltHex: string;
  deadlineMs: number;
  random15?: Uint8Array;
}): Uint8Array {
  const salt = fromHex(saltHex);
  if (salt.length !== 4) throw new Error(`salt must be 4 bytes, got ${salt.length}`);
  const random = random15 ?? crypto.getRandomValues(new Uint8Array(15));
  if (random.length !== 15) throw new Error(`random part must be 15 bytes, got ${random.length}`);
  const n = new Uint8Array(32);
  n.set(VERSIONED_MAGIC, 0);
  n[4] = 0;
  n.set(salt, 5);
  new DataView(n.buffer).setBigInt64(9, BigInt(deadlineMs) * 1_000_000n, true);
  n.set(random, 17);
  return n;
}

export function decodeVersionedNonce(b64: string): { saltHex: string; deadlineNs: bigint; random: Uint8Array } {
  const n = fromBase64(b64);
  if (n.length !== 32) throw new Error(`nonce must be 32 bytes, got ${n.length}`);
  if (!VERSIONED_MAGIC.every((b, i) => n[i] === b)) throw new Error('not a versioned nonce (magic mismatch)');
  if (n[4] !== 0) throw new Error(`unsupported versioned nonce version ${n[4]}`);
  return {
    saltHex: toHex(n.subarray(5, 9)),
    deadlineNs: new DataView(n.buffer, n.byteOffset).getBigInt64(9, true),
    random: n.slice(17),
  };
}
