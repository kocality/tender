// C9 commitment and C10 plaintext layouts. Same bytes as contract/src/seal.rs (fixtures/seal/commitment.json).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PLAINTEXT_LEN } from './constants.js';

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const DOMAIN = new TextEncoder().encode('tender/v1');

export interface CommitmentInput {
  sale: bigint;
  bidder: string;
  B: bigint;
  p: bigint;
  q: bigint;
  salt: Uint8Array;
}

function check(v: bigint, max: bigint, name: string): void {
  if (v < 0n || v > max) throw new Error(`${name} out of range: ${v}`);
}

function checkSalt(salt: Uint8Array): void {
  if (salt.length !== 16) throw new Error(`salt must be 16 bytes, got ${salt.length}`);
}

function leBytes(v: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** u64_le(p) || u64_le(q) || salt16 (32 bytes). */
export function encodePlaintext(p: bigint, q: bigint, salt: Uint8Array): Uint8Array {
  check(p, U64_MAX, 'p');
  check(q, U64_MAX, 'q');
  checkSalt(salt);
  const out = new Uint8Array(PLAINTEXT_LEN);
  out.set(leBytes(p, 8), 0);
  out.set(leBytes(q, 8), 8);
  out.set(salt, 16);
  return out;
}

export function decodePlaintext(pt: Uint8Array): { p: bigint; q: bigint; salt: Uint8Array } {
  if (pt.length !== PLAINTEXT_LEN) throw new Error(`plaintext must be ${PLAINTEXT_LEN} bytes, got ${pt.length}`);
  const dv = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
  return { p: dv.getBigUint64(0, true), q: dv.getBigUint64(8, true), salt: pt.slice(16, 32) };
}

/** "tender/v1" || u64_le(sale) || u8(len) || utf8(bidder) || u128_le(B) || u64_le(p) || u64_le(q) || salt16. */
export function commitmentPreimage({ sale, bidder, B, p, q, salt }: CommitmentInput): Uint8Array {
  check(sale, U64_MAX, 'sale');
  check(B, U128_MAX, 'B');
  check(p, U64_MAX, 'p');
  check(q, U64_MAX, 'q');
  checkSalt(salt);
  const who = new TextEncoder().encode(bidder);
  if (who.length < 1 || who.length > 64) throw new Error(`bidder must be 1..64 bytes, got ${who.length}`);
  const parts = [DOMAIN, leBytes(sale, 8), Uint8Array.of(who.length), who, leBytes(B, 16), leBytes(p, 8), leBytes(q, 8), salt];
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

export const commitment = (c: CommitmentInput): Uint8Array => sha256(commitmentPreimage(c));
export const commitmentHex = (c: CommitmentInput): string => bytesToHex(commitment(c));
