import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import type { WeierstrassPoint } from '@noble/curves/abstract/weierstrass.js';
import type { Fp2 } from '@noble/curves/abstract/tower.js';
import bs58 from 'bs58';
import { CT_LEN } from './constants.js';

export type G1Point = WeierstrassPoint<bigint>;
export type G2Point = WeierstrassPoint<Fp2>;

const G1 = bls.G1.Point;
const G2 = bls.G2.Point;

function decodeTagged(s: string, prefix: string, len: number): Uint8Array {
  if (!s.startsWith(prefix)) throw new Error(`expected a ${prefix}<base58> string`);
  const b = bs58.decode(s.slice(prefix.length));
  if (b.length !== len) throw new Error(`${prefix} must decode to ${len} bytes, got ${b.length}`);
  return b;
}

/** `bls12381g1:<base58 of the 48-byte compressed point>` → point (subgroup-checked). */
export function parseG1(s: string): G1Point {
  const P = G1.fromBytes(decodeTagged(s, 'bls12381g1:', 48));
  P.assertValidity();
  return P;
}

/** `bls12381g2:<base58 of the 96-byte compressed point>` → point (subgroup-checked). */
export function parseG2(s: string): G2Point {
  const P = G2.fromBytes(decodeTagged(s, 'bls12381g2:', 96));
  P.assertValidity();
  return P;
}

export const g1ToString = (P: G1Point): string => 'bls12381g1:' + bs58.encode(P.toBytes(true));
export const g2ToString = (P: G2Point): string => 'bls12381g2:' + bs58.encode(P.toBytes(true));

/** Raw bytes of a `bls12381g2:` string or pass-through bytes. */
export function g2Bytes(mpk: Uint8Array | string): Uint8Array {
  return typeof mpk === 'string' ? decodeTagged(mpk, 'bls12381g2:', 96) : mpk;
}

/** Standard base64 with padding (btoa, no Buffer: runs in the browser too). */
export function bytesToB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ctToBase64(ct: Uint8Array): string {
  if (ct.length !== CT_LEN) throw new Error(`ciphertext must be ${CT_LEN} bytes`);
  return bytesToB64(ct);
}

export function ctFromBase64(b64: string): Uint8Array {
  let ct: Uint8Array;
  try {
    ct = b64ToBytes(b64);
  } catch {
    throw new Error(`ciphertext must be ${CT_LEN} bytes`);
  }
  if (ct.length !== CT_LEN) throw new Error(`ciphertext must be ${CT_LEN} bytes`);
  return ct;
}
