// Boneh-Franklin IBE with the tlock-style Fujisaki-Okamoto transform, ported line by line from prototype/ibe.mjs.
// Master key: the MPC domain-2 G2 key. Identity: H(pk || app_id) in G1 with NEAR's DST. Key: S = msk · H(...).
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { type G1Point, type G2Point, g2Bytes, parseG1 } from './codec.js';
import { DST } from './constants.js';

const G2 = bls.G2.Point;
const Fp12 = bls.fields.Fp12;
const Fr = bls.fields.Fr;
const te = new TextEncoder();

type Gt = ReturnType<typeof bls.pairing>;

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((x, i) => x ^ b[i]!);

const gtHash = (gt: Gt, n: number): Uint8Array =>
  sha256.create().update(te.encode('IBE-H2')).update(Fp12.toBytes(gt)).digest().slice(0, n);

/** Hash (sigma, msg) to a non-zero scalar, rejection sampling as in tlock. */
function h3(sigma: Uint8Array, msg: Uint8Array): bigint {
  for (let i = 1; i < 65535; i++) {
    const d = sha256.create().update(te.encode('IBE-H3')).update(sigma).update(msg).digest();
    const h = sha256.create().update(new Uint8Array([i & 255, i >> 8])).update(d).digest();
    h[0] = h[0]! >> 1;
    const r = BigInt('0x' + bytesToHex(h));
    if (r < Fr.ORDER && r > 0n) return r;
  }
  throw new Error('h3');
}

const h4 = (sigma: Uint8Array, n: number): Uint8Array =>
  sha256.create().update(te.encode('IBE-H4')).update(sigma).digest().slice(0, n);

/** Identity point H(pk_compressed(96 B) || app_id) in G1. */
export function hashIdentity(mpk: Uint8Array, appId: Uint8Array): G1Point {
  const msg = new Uint8Array(mpk.length + appId.length);
  msg.set(mpk, 0);
  msg.set(appId, mpk.length);
  return bls.G1.hashToCurve(msg, { DST }) as G1Point;
}

/**
 * Encrypt 1..32 bytes to the identity (mpk, appId). Output U(96) || V(n) || W(n); a 32-byte message gives 160 bytes.
 * `opts.sigma` is for golden tests only: a fixed sigma makes the ciphertext deterministic and must never be used for real bids.
 */
export function encrypt(
  mpk: Uint8Array | string,
  appId: Uint8Array,
  msg: Uint8Array,
  opts?: { sigma?: Uint8Array },
): Uint8Array {
  if (msg.length < 1 || msg.length > 32) throw new Error('message must be 1..32 bytes');
  const pkB = g2Bytes(mpk);
  const Q = hashIdentity(pkB, appId);
  const P = G2.fromBytes(pkB);
  const sigma = opts?.sigma ?? randomBytes(msg.length);
  if (sigma.length !== msg.length) throw new Error('sigma must have the message length');
  const r = h3(sigma, msg);
  const U = G2.BASE.multiply(r);
  const V = xor(sigma, gtHash(Fp12.pow(bls.pairing(Q, P), r), msg.length));
  const W = xor(msg, h4(sigma, msg.length));
  const out = new Uint8Array(96 + 2 * msg.length);
  out.set(U.toBytes(true), 0);
  out.set(V, 96);
  out.set(W, 96 + msg.length);
  return out;
}

/** Decrypt with the CKD key S. Throws `invalid U point` or `FO check failed` (wrong key or tampered ciphertext). */
export function decrypt(S: G1Point | string, ct: Uint8Array): Uint8Array {
  const key = typeof S === 'string' ? parseG1(S) : S;
  if (ct.length < 98 || (ct.length - 96) % 2 !== 0) throw new Error('invalid ciphertext length');
  const n = (ct.length - 96) / 2;
  let U: G2Point;
  try {
    U = G2.fromBytes(ct.subarray(0, 96));
    U.assertValidity();
  } catch {
    throw new Error('invalid U point');
  }
  if (U.is0()) throw new Error('invalid U point');
  const V = ct.subarray(96, 96 + n);
  const W = ct.subarray(96 + n);
  const sigma = xor(V, gtHash(bls.pairing(key, U), n));
  const msg = xor(W, h4(sigma, n));
  if (!G2.BASE.multiply(h3(sigma, msg)).equals(U)) throw new Error('FO check failed');
  return msg;
}
