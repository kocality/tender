// Test and demo only: an MPC-free CKD key from a known master secret (the public near/mpc test vectors).
// Mainnet keys come from v1.signer; nothing here touches the network.
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { type G1Point, g1ToString, g2Bytes } from './codec.js';
import type { AppPkMode } from './constants.js';
import type { CkdResponse } from './ckd.js';
import { hashIdentity } from './ibe.js';

const G1 = bls.G1.Point;
const Fr = bls.fields.Fr;

function scalar(hex: string): bigint {
  const k = Fr.create(BigInt('0x' + hex));
  if (k === 0n) throw new Error('scalar must be non-zero');
  return k;
}

/** S = msk · H(pk || app_id). Test and demo only. */
export function simulateCkdKey(mskHex: string, mpk: Uint8Array | string, appId: Uint8Array): G1Point {
  return hashIdentity(g2Bytes(mpk), appId).multiply(scalar(mskHex));
}

/**
 * A CKD response as the MPC would return it for `mode`: Y = y·G1; identity C = S, generator and plain C = S + Y.
 * `y` defaults to a random scalar. Test and demo only.
 */
export function simulateCkdResponse(
  mskHex: string,
  mpk: Uint8Array | string,
  appId: Uint8Array,
  mode: AppPkMode,
  y?: bigint,
): CkdResponse {
  const S = simulateCkdKey(mskHex, mpk, appId);
  const yk = y === undefined ? scalar(bytesToHex(randomBytes(32))) : Fr.create(y);
  if (yk === 0n) throw new Error('y must be non-zero');
  const Y = G1.BASE.multiply(yk);
  const C = mode === 'identity' ? S : S.add(Y);
  return { big_y: g1ToString(Y), big_c: g1ToString(C) };
}
