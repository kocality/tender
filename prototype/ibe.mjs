import { webcrypto } from "node:crypto"; if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import fs from 'node:fs';
const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const G1 = bls.G1.Point, G2 = bls.G2.Point, Fp12 = bls.fields.Fp12, Fr = bls.fields.Fr;
const te = new TextEncoder();
const appIdOf = (acct, path) => sha3_256(te.encode(`near-mpc v0.1.0 app_id derivation:${acct},${path}`));
const Hid = (pkB, appId) => bls.G1.hashToCurve(new Uint8Array([...pkB, ...appId]), { DST });
const xor = (a, b) => a.map((x, i) => x ^ b[i]);
const gtHash = (gt, n) => sha256.create().update(te.encode('IBE-H2')).update(Fp12.toBytes(gt)).digest().slice(0, n);
const h3 = (sigma, msg) => { // tlock-style: hash to scalar with rejection
  for (let i = 1; i < 65535; i++) {
    const d = sha256.create().update(te.encode('IBE-H3')).update(sigma).update(msg).digest();
    const h = sha256.create().update(new Uint8Array([i & 255, i >> 8])).update(d).digest();
    h[0] >>= 1; const r = BigInt('0x' + bytesToHex(h));
    if (r < Fr.ORDER && r > 0n) return r;
  }
  throw new Error('h3');
};
const h4 = (sigma, n) => sha256.create().update(te.encode('IBE-H4')).update(sigma).digest().slice(0, n);
export function encrypt(pkB, appId, msg) { // msg <= 32 bytes
  const Q = Hid(pkB, appId), mpk = G2.fromBytes(pkB);
  const sigma = randomBytes(msg.length), r = h3(sigma, msg);
  const U = G2.BASE.multiply(r);
  const V = xor(sigma, gtHash(Fp12.pow(bls.pairing(Q, mpk), r), msg.length));
  const W = xor(msg, h4(sigma, msg.length));
  return { U: U.toBytes(true), V, W };
}
export function decrypt(S, ct) {
  const U = G2.fromBytes(ct.U);
  const sigma = xor(ct.V, gtHash(bls.pairing(S, U), ct.W.length));
  const msg = xor(ct.W, h4(sigma, ct.W.length));
  if (!G2.BASE.multiply(h3(sigma, msg)).equals(U)) throw new Error('FO check failed');
  return msg;
}
// test vectors
const v = JSON.parse(fs.readFileSync('vec.json'));
for (const t of v.vectors) {
  const pkB = hexToBytes(t.pk), appId = hexToBytes(t.app_id);
  const a = BigInt('0x' + t.a);
  const S = G1.fromBytes(hexToBytes(t.big_c)).subtract(G1.fromBytes(hexToBytes(t.big_y)).multiply(a));
  const sigOk = bytesToHex(S.toBytes(true)) === t.sig;
  const keyOk = Fp12.eql(bls.pairing(S, G2.BASE), bls.pairing(Hid(pkB, appId), G2.fromBytes(pkB)));
  const m = randomBytes(32); const ct = encrypt(pkB, appId, m);
  const rt = bytesToHex(decrypt(S, ct)) === bytesToHex(m);
  let wrong = 'n/a'; try { decrypt(S.add(G1.BASE), ct); wrong = 'decrypted?!'; } catch { wrong = 'rejected'; }
  console.log({ sigOk, keyOk, roundTrip: rt, wrongKey: wrong });
}
// generator-PV fallback math: C = S + Y (a=1) -> S = C - Y
