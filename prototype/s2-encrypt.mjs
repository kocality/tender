// Gate S2, step 1: seal a message to an identity whose key does not exist yet.
//   node s2-encrypt.mjs [--caller tenderseal.near] [--mode identity|generator|plain] [--sim] [--out <file>]
// Real: mainnet domain-2 key, path tender-spike/s2/<16 hex>, default --out ../evidence/spikes/s2-ct.json,
//       mode from --mode or the S1 evidence (identity PASS > generator PASS > plain PASS). Prints the H-S2 command last.
// --sim: vector 0 pk from vec.json instead of the MPC key, path tender-spike/s2/sim, --out required.
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
const resolveOut = f => path.resolve(process.cwd(), f);           // before chdir: user paths are relative to the user's cwd
const out = o.out ? resolveOut(o.out) : (o.sim ? null : path.join(here, '../evidence/spikes/s2-ct.json'));
if (!out) { console.error('--sim needs --out <file> (e.g. "$(node -p "require(\'os\').tmpdir()")/s2-sim-ct.json")'); process.exit(1); }
process.chdir(here);                                               // ibe.mjs reads vec.json from cwd (P-15)
const ibe = await import('./ibe.mjs');                             // side effect: 4 vector lines

const MAINNET_MPK = 'bls12381g2:24mhN4RnB2CbiUkAfukyh4s1CT6dUNd9Pc8kRnL4LvAP3tcxhUupbphmfbmwHSi66aFCiZkMgiH2KqXWJLD7JUeAFhoLS3WQbzWcpUzhERLqxyocwT9Xrd4WNvEuKavxmXdR';
const GEN1 = 'bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp';
const APP_PK = {
  identity: { AppPublicKeyPV: { pk1: 'bls12381g1:83VnBdpeT9ioHuUTBD2zcitXg7JqNiebUs5yxDaYaLgZYDLLk2gayHrJKNyRt4vBQB',
    pk2: 'bls12381g2:2995BcogDeU9PQxbssLWhG9J76ubezYVpjbceWnwcmRs9ypA2vYDikf8mpuzankQX6WMsDockieKarmDerS2xTPzR1dktiHiGkjvPpRYpDip6unu4WgtPqeCPtxqppMzuGwy' } },
  generator: { AppPublicKeyPV: { pk1: GEN1,
    pk2: 'bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK' } },
  plain: { AppPublicKey: GEN1 },
};
const te = new TextEncoder();
const appIdOf = (acct, p) => sha3_256(te.encode(`near-mpc v0.1.0 app_id derivation:${acct},${p}`));
const u64le = n => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

function s1Mode() {
  for (const m of ['identity', 'generator', 'plain']) {
    try { if (JSON.parse(fs.readFileSync(`../evidence/spikes/s1-${m}.json`)).result === 'PASS') return m; } catch {}
  }
  return null;
}

const caller = o.caller ?? 'tenderseal.near';
const mode = o.mode ?? (o.sim ? 'identity' : s1Mode());
if (!APP_PK[mode]) { console.error(`no mode: pass --mode identity|generator|plain or record a PASS in ../evidence/spikes/s1-<mode>.json first`); process.exit(1); }
const mpk = o.sim ? 'bls12381g2:' + bs58.encode(hexToBytes(JSON.parse(fs.readFileSync('vec.json')).vectors[0].pk)) : MAINNET_MPK;
const dpath = o.sim ? 'tender-spike/s2/sim' : 'tender-spike/s2/' + randomBytes(8).toString('hex');
const appId = appIdOf(caller, dpath);
const msg = new Uint8Array([...u64le(3_600_000), ...u64le(2_000_000), ...randomBytes(16)]);
const ct = ibe.encrypt(bs58.decode(mpk.split(':')[1]), appId, msg);
const ctBytes = new Uint8Array([...ct.U, ...ct.V, ...ct.W]);
if (ctBytes.length !== 160) throw new Error(`ciphertext ${ctBytes.length} B, want 160`);

const rec = {
  gate: 'S2', network: o.sim ? 'sim' : 'mainnet', caller, path: dpath, app_id_hex: bytesToHex(appId), mpk,
  msg_hex: bytesToHex(msg), ct: { U_hex: bytesToHex(ct.U), V_hex: bytesToHex(ct.V), W_hex: bytesToHex(ct.W) },
  ct_b64: Buffer.from(ctBytes).toString('base64'), created_utc: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), mode,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(rec, null, 1) + '\n');
console.log(`wrote ${out} (path ${dpath}, mode ${mode}, ct_b64 ${rec.ct_b64.length} chars)`);
const args = JSON.stringify({ request: { derivation_path: dpath, app_public_key: APP_PK[mode], domain_id: 2 } });
if (!o.sim) console.log(`H-S2: near contract call-function as-transaction v1.signer request_app_private_key json-args '${args}' prepaid-gas '50 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${caller} network-config mainnet sign-with-legacy-keychain send`);
