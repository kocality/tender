// Gate S2, step 2: decrypt the S2 ciphertext with the live CKD key for its path (tasks/WS2.md WS2-T02).
//   node s2-decrypt.mjs [--ct <file>] (--tx <hash> --sender <account> | --ckd <file> | --sim) [--rpc <url>] [--out <file>]
// --ct defaults to ../evidence/spikes/s2-ct.json. --ckd: {big_y,big_c} or an s1-shaped file with a response field.
// --sim: CKD simulated from vector 0's msk (S = msk·H(pk‖app_id), Y = y·G1; identity C = S, generator/plain C = S + Y).
// Exit code: 0 PASS, 1 FAIL.
import { webcrypto, randomBytes } from "node:crypto"; if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const o = {};
for (let a = process.argv.slice(2), i = 0; i < a.length; i++) {
  const k = a[i].replace(/^--/, '');
  if (k === 'sim') o.sim = true; else o[k] = a[++i];
}
const here = path.dirname(fileURLToPath(import.meta.url));
const abs = f => f && path.resolve(process.cwd(), f);              // user paths are relative to the user's cwd
const ctFile = abs(o.ct) ?? path.join(here, '../evidence/spikes/s2-ct.json'), ckdFile = abs(o.ckd), out = abs(o.out);
process.chdir(here);                                               // ibe.mjs reads vec.json from cwd (P-15)
const vectorLines = [];
const log = console.log;
console.log = (...a) => { vectorLines.push(a[0]); log(...a); };
const ibe = await import('./ibe.mjs');                             // side effect: runs the 4 official vectors
console.log = log;
const vectorsOk = vectorLines.filter(v => v?.sigOk && v.keyOk && v.roundTrip && v.wrongKey === 'rejected').length;

const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const G1 = bls.G1.Point, G2 = bls.G2.Point, Fp12 = bls.fields.Fp12, Fr = bls.fields.Fr;
const te = new TextEncoder();
const dec = s => bs58.decode(s.split(':')[1]);
const appIdOf = (acct, p) => sha3_256(te.encode(`near-mpc v0.1.0 app_id derivation:${acct},${p}`));
const Hid = (pkB, appId) => bls.G1.hashToCurve(new Uint8Array([...pkB, ...appId]), { DST });
const keyFromCkd = (mode, Y, C) => mode === 'identity' ? C : C.subtract(Y);
function checkKey(S, pkB, appId) {
  if (S.equals(G1.ZERO)) return false;
  return Fp12.eql(bls.pairing(S, G2.BASE), bls.pairing(Hid(pkB, appId), G2.fromBytes(pkB)));
}
const RPC = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org', 'https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'];
async function rpc(method, params) {
  let last;
  for (const url of o.rpc ? [o.rpc] : RPC) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      if (j.error) { last = new Error(`${url}: ${JSON.stringify(j.error.cause ?? j.error)}`); continue; }
      return j.result;
    } catch (e) { last = new Error(`${url}: ${e.message}`); }
  }
  throw last;
}

const rec = JSON.parse(fs.readFileSync(ctFile));
const mode = rec.mode, pkB = dec(rec.mpk), appId = appIdOf(rec.caller, rec.path);
if (bytesToHex(appId) !== rec.app_id_hex) throw new Error('app_id in ct file does not match caller/path');
const ct = { U: hexToBytes(rec.ct.U_hex), V: hexToBytes(rec.ct.V_hex), W: hexToBytes(rec.ct.W_hex) };
const fail = [];
let response, txHash = null;

if (o.sim) {
  const v0 = JSON.parse(fs.readFileSync('vec.json')).vectors[0];
  if (bytesToHex(pkB) !== v0.pk) throw new Error('--sim needs a ct file made with s2-encrypt.mjs --sim (mpk = vector 0 pk)');
  const S = Hid(pkB, appId).multiply(BigInt('0x' + v0.msk));
  const Y = G1.BASE.multiply(Fr.create(BigInt('0x' + bytesToHex(randomBytes(32)))) || 1n);
  const C = mode === 'identity' ? S : S.add(Y);
  response = { big_y: 'bls12381g1:' + bs58.encode(Y.toBytes(true)), big_c: 'bls12381g1:' + bs58.encode(C.toBytes(true)) };
} else if (ckdFile) {
  const j = JSON.parse(fs.readFileSync(ckdFile));
  response = j.response ?? j;
  txHash = j.tx_hash ?? null;
} else if (o.tx && o.sender) {
  txHash = o.tx;
  const tx = await rpc('EXPERIMENTAL_tx_status', { tx_hash: o.tx, sender_account_id: o.sender, wait_until: 'FINAL' });
  const reqOut = tx.receipts_outcome.find(r => r.outcome.executor_id === 'v1.signer'
    && r.outcome.logs.some(l => l.startsWith('request_app_private_key:')));
  if (!reqOut) throw new Error(`no request_app_private_key receipt on v1.signer in tx ${o.tx}`);
  const l = reqOut.outcome.logs.find(x => x.startsWith('request_app_private_key:'));
  const caller = /predecessor=AccountId\("([^"]+)"\)/.exec(l)?.[1];
  if (caller !== rec.caller) fail.push(`caller mismatch: MPC predecessor ${caller}, ct file ${rec.caller}`);
  if (!l.includes(`derivation_path: "${rec.path}"`)) fail.push('path mismatch');
  for (const r of tx.receipts_outcome) {
    const sv = r.outcome.status?.SuccessValue;
    if (!sv) continue;
    try { const j = JSON.parse(Buffer.from(sv, 'base64').toString()); if (j?.big_y) { response = j; break; } } catch {}
  }
  // the ciphertext must predate the key request, otherwise the test proves nothing
  const txBlock = await rpc('block', { block_id: tx.transaction_outcome.block_hash });
  const txMs = Number(BigInt(txBlock.header.timestamp_nanosec) / 1_000_000n);
  if (!(Date.parse(rec.created_utc) < txMs)) fail.push(`ct created_utc ${rec.created_utc} is not before the key request tx`);
} else {
  console.error('need one of: --tx <hash> --sender <account> | --ckd <file> | --sim'); process.exit(1);
}
if (!response?.big_y || !response?.big_c) throw new Error('no {big_y, big_c} CKD response');

// (1) key from CKD output, (2) checkKey, (3) decrypt == msg, (4) wrong key rejected by the FO check
const S = keyFromCkd(mode, G1.fromBytes(dec(response.big_y)), G1.fromBytes(dec(response.big_c)));
const keyOk = checkKey(S, pkB, appId);
let plainOk = false;
try { plainOk = bytesToHex(ibe.decrypt(S, ct)) === rec.msg_hex; } catch (e) { fail.push(`decrypt: ${e.message}`); }
let wrong;
try { ibe.decrypt(S.add(G1.BASE), ct); wrong = 'decrypted?!'; } catch (e) { wrong = e.message; }
if (!keyOk) fail.push('checkKey false');
if (!plainOk) fail.push('plaintext differs');
if (wrong !== 'FO check failed') fail.push(`wrong key: ${wrong}`);
if (vectorsOk !== 4) fail.push(`vectors ${vectorsOk}/4`);

const result = fail.length ? 'FAIL' : 'PASS';
console.log(`mode ${mode} · path ${rec.path} · caller ${rec.caller}`);
console.log(`checkKey: ${keyOk} · plaintext equal: ${plainOk} · wrong key: ${wrong} · vectors ${vectorsOk}/4 → S2${o.sim ? ' (simulated)' : ''} ${result}${fail.length ? ' (' + fail.join('; ') + ')' : ''}`);
if (out) {
  const r = { gate: 'S2', path: rec.path, tx_hash: txHash, mode, response,
    checks: { checkKey: keyOk, plaintext_equal: plainOk, wrong_key: wrong, vectors: `${vectorsOk}/4` },
    result, date_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
  if (o.sim) r.simulated = true;
  if (fail.length) r.fail = fail;
  fs.writeFileSync(out, JSON.stringify(r, null, 1) + '\n');
  console.log(`wrote ${out}`);
}
process.exit(fail.length ? 1 : 0);
