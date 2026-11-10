// Golden IBE ciphertexts for packages/seal (fixtures/seal/ibe-golden.json).
//   node seal-golden.mjs <out.json>      e.g. node seal-golden.mjs ../fixtures/seal/ibe-golden.json
// h3, h4, gtHash, Hid and xor are verbatim copies of ibe.mjs; encryptWith() is ibe.mjs encrypt() with a fixed sigma.
// The copy is proven by decrypting the vector-0 case with ibe.mjs's own decrypt().
import { webcrypto } from "node:crypto"; if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outArg = process.argv[2];
if (!outArg) { console.error('usage: node seal-golden.mjs <out.json>'); process.exit(1); }
const out = path.resolve(process.cwd(), outArg);                   // before chdir: user path is relative to the user's cwd
process.chdir(path.dirname(fileURLToPath(import.meta.url)));       // ibe.mjs reads vec.json from cwd (P-15)
const ibe = await import('./ibe.mjs');                             // side effect: 4 vector lines

// --- verbatim from ibe.mjs ---
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
// --- end verbatim ---

function encryptWith(pkB, appId, msg, sigma) { // ibe.mjs encrypt() with sigma passed in
  const Q = Hid(pkB, appId), mpk = G2.fromBytes(pkB);
  const r = h3(sigma, msg);
  const U = G2.BASE.multiply(r);
  const V = xor(sigma, gtHash(Fp12.pow(bls.pairing(Q, mpk), r), msg.length));
  const W = xor(msg, h4(sigma, msg.length));
  return { U: U.toBytes(true), V, W };
}

const MAINNET_MPK = 'bls12381g2:24mhN4RnB2CbiUkAfukyh4s1CT6dUNd9Pc8kRnL4LvAP3tcxhUupbphmfbmwHSi66aFCiZkMgiH2KqXWJLD7JUeAFhoLS3WQbzWcpUzhERLqxyocwT9Xrd4WNvEuKavxmXdR';
const cm = JSON.parse(fs.readFileSync('../fixtures/seal/commitment.json'));
const v0 = JSON.parse(fs.readFileSync('vec.json')).vectors[0];

function record(name, mpkStr, account, p, appId, msg, sigma, extra = {}) {
  const ct = encryptWith(bs58.decode(mpkStr.split(':')[1]), appId, msg, sigma);
  const bytes = new Uint8Array([...ct.U, ...ct.V, ...ct.W]);
  if (bytes.length !== 160) throw new Error(`${name}: ciphertext ${bytes.length} B`);
  return {
    rec: { name, mpk: mpkStr, account, path: p, app_id_hex: bytesToHex(appId), msg_hex: bytesToHex(msg),
      sigma_hex: bytesToHex(sigma), U_hex: bytesToHex(ct.U), V_hex: bytesToHex(ct.V), W_hex: bytesToHex(ct.W),
      ct_b64: Buffer.from(bytes).toString('base64'), ...extra },
    ct,
  };
}

const p1 = 'tender/1/00112233445566778899aabbccddeeff';
const a1 = appIdOf('v1.tenderseal.near', p1);
if (bytesToHex(a1) !== 'c5db6e292be1b0b76a58ab571e4fb28b013b798f63b142cc29954d90b667c8f1') throw new Error('mainnet-v1 app_id mismatch');
const c1 = record('mainnet-v1', MAINNET_MPK, 'v1.tenderseal.near', p1, a1,
  hexToBytes(cm.cases[0].plaintext_hex), sha256(te.encode('tender-golden-sigma-1')));

const msg2 = hexToBytes(cm.cases[2].plaintext_hex);
const c2 = record('vector0-decrypt', 'bls12381g2:' + bs58.encode(hexToBytes(v0.pk)), null, null, hexToBytes(v0.app_id),
  msg2, sha256(te.encode('tender-golden-sigma-2')), { S_hex: v0.sig });
const S = G1.fromBytes(hexToBytes(v0.sig));
const ok = bytesToHex(ibe.decrypt(S, c2.ct)) === bytesToHex(msg2);
console.log(`vector0 case decrypts with ibe.mjs: ${ok}`);
if (!ok) process.exit(1);

const doc = { _doc: 'Golden BF-IBE ciphertexts from prototype/seal-golden.mjs (verbatim ibe.mjs helpers, fixed sigma). ct = U(96) || V(32) || W(32), base64 std with padding.', cases: [c1.rec, c2.rec] };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
console.log(`wrote ${out} (${doc.cases.length} cases)`);
