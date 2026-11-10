import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { type G1Point, g2Bytes, parseG1 } from './codec.js';
import type { AppPkMode } from './constants.js';
import { hashIdentity } from './ibe.js';

const G1 = bls.G1.Point;
const G2 = bls.G2.Point;
const Fp12 = bls.fields.Fp12;
const Fr = bls.fields.Fr;

export interface CkdResponse {
  big_y: string;
  big_c: string;
}

/** Sale key from the MPC response: identity → C; generator and plain (a = 1) → C − Y. */
export function keyFromCkd(r: CkdResponse, mode: AppPkMode): G1Point {
  const C = parseG1(r.big_c);
  if (mode === 'identity') return C;
  return C.subtract(parseG1(r.big_y));
}

/** C − a·Y for an arbitrary app secret `a` (the near/mpc test vectors). */
export function keyFromCkdScalar(r: CkdResponse, a: bigint): G1Point {
  const C = parseG1(r.big_c);
  const k = Fr.create(a);
  if (k === 0n) return C;
  return C.subtract(parseG1(r.big_y).multiply(k));
}

/**
 * e(S, G2) == e(H(pk || app_id), pk). False for the zero point (noble refuses to pair it),
 * so an identity-mode C that is zero, or a key for another app_id, never passes.
 */
export function checkKey(S: G1Point, mpk: Uint8Array | string, appId: Uint8Array): boolean {
  if (S.equals(G1.ZERO)) return false;
  const pkB = g2Bytes(mpk);
  return Fp12.eql(bls.pairing(S, G2.BASE), bls.pairing(hashIdentity(pkB, appId), G2.fromBytes(pkB)));
}
