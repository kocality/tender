import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64, fromHex, toHex, utf8 } from './encoding.js';

// Versioned nonce V1 (near/intents @16d04f6e nonce/versioned.rs):
// magic(4) ‖ version 0x00 ‖ salt(4) ‖ deadline i64 LE ns ‖ random(15) = 32 bytes.
export const VERSIONED_MAGIC = Uint8Array.of(0x56, 0x28, 0xf6, 0xc6);

/**
 * Deadline rounded down to a whole second, so the payload deadline (RFC 3339, ms precision)
 * and the nonce deadline (ns) are the same instant (the contract rejects payload > nonce).
 * `notAfterMs` caps the deadline: a bid signed for a sale must not stay valid past the sale's close (X12P-02).
 */
export function makeDeadline(nowMs = Date.now(), ttlMs = 600_000, notAfterMs = Infinity): { deadlineMs: number; deadlineIso: string } {
  const deadlineMs = Math.floor(Math.min(nowMs + ttlMs, notAfterMs) / 1000) * 1000;
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

// ---- One nonce per sealed bid / per withdraw quote -------------------------------------------------------------
// intents.near runs a nonce at most once. If every signature of the same sealed bid carries the same nonce, a second
// signature (a lost relay answer, a second tab, a re-run script) is refused with `nonce_used` instead of paying twice.

/** A bid is not worth sending in the last minute: its payload and nonce stop a minute before close. */
export const BID_NONCE_MARGIN_NS = 60_000_000_000n;

/** Nonce deadline of every bid in a sale: close - 60 s in whole seconds, the latest payload deadline the app signs. */
export function bidNonceDeadlineMs(closeNs: bigint): number {
  return Math.floor(Number((closeNs - BID_NONCE_MARGIN_NS) / 1_000_000n) / 1000) * 1000;
}

const lengthPrefixed = (s: string): Uint8Array => {
  const b = utf8(s);
  if (b.length > 255) throw new Error(`nonce input too long (${b.length} bytes)`);
  return Uint8Array.of(b.length, ...b);
};

function leBytes(x: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return out;
}

function tailOf(...parts: Uint8Array[]): Uint8Array {
  const pre = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    pre.set(p, o);
    o += p.length;
  }
  return sha256(pre).subarray(0, 15);
}

/**
 * The Intents nonce of a sealed bid: `magic ‖ 0 ‖ salt ‖ deadline(close - 60 s) ‖ sha256("tender/bid-nonce/v1" ‖
 * len(contract) ‖ contract ‖ u64_le(sale) ‖ len(signer) ‖ signer ‖ cm)[0..15]`. `seq` is not in the hash: a bid that moves to
 * another slot keeps its nonce. Anyone holding (contract, sale, signer, cm) and the salt derives the same 32 bytes.
 */
export function bidNonce(o: { saltHex: string; closeNs: bigint; contract: string; sale: string | bigint; signer: string; cm: string }): Uint8Array {
  return buildVersionedNonce({
    saltHex: o.saltHex,
    deadlineMs: bidNonceDeadlineMs(o.closeNs),
    random15: tailOf(utf8('tender/bid-nonce/v1'), lengthPrefixed(o.contract), leBytes(BigInt(o.sale), 8), lengthPrefixed(o.signer), fromHex(o.cm)),
  });
}

/**
 * The nonce of a withdrawal: tied to the 1Click quote (signer, deposit address, token, amount) and to the quote's deadline,
 * so a re-signature of the same quote repeats it and a second transfer to a filled deposit address is refused.
 */
export function withdrawNonce(o: {
  saltHex: string;
  deadlineMs: number;
  signer: string;
  depositAddress: string;
  tokenId: string;
  amount: bigint;
}): Uint8Array {
  return buildVersionedNonce({
    saltHex: o.saltHex,
    deadlineMs: Math.floor(o.deadlineMs / 1000) * 1000,
    random15: tailOf(utf8('tender/withdraw-nonce/v1'), lengthPrefixed(o.signer), lengthPrefixed(o.depositAddress), lengthPrefixed(o.tokenId), leBytes(o.amount, 16)),
  });
}
