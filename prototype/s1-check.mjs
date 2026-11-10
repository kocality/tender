// Gate S1: check a live CKD response from the NEAR MPC network (tasks/WS2.md WS2-T01).
//   node s1-check.mjs <file.json>          file: {pk, path, acct, pk2?, big_y, big_c, mode?}
//   node s1-check.mjs --tx <hash> --sender <account> --mode identity|generator|plain|pv --path <derivation_path>
//                     [--network mainnet|testnet] [--rpc <url>] [--out <file>]
// Exit code: 0 PASS, 1 FAIL.
import { webcrypto } from "node:crypto"; if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import fs from 'node:fs';

const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';
const G1 = bls.G1.Point, G2 = bls.G2.Point, Fp12 = bls.fields.Fp12;
const te = new TextEncoder();
const NET = {
  mainnet: { mpc: 'v1.signer', rpc: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
    archival: ['https://archival-rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.near.org'],
    mpk: 'bls12381g2:24mhN4RnB2CbiUkAfukyh4s1CT6dUNd9Pc8kRnL4LvAP3tcxhUupbphmfbmwHSi66aFCiZkMgiH2KqXWJLD7JUeAFhoLS3WQbzWcpUzhERLqxyocwT9Xrd4WNvEuKavxmXdR' },
  testnet: { mpc: 'v1.signer-prod.testnet', rpc: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
    archival: ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'],
    mpk: 'bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj' },
};
// app_public_key JSON the request must carry for each mode (tasks/WS2.md §1.1)
const GEN1 = 'bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp';
const APP_PK = {
  identity: { AppPublicKeyPV: { pk1: 'bls12381g1:83VnBdpeT9ioHuUTBD2zcitXg7JqNiebUs5yxDaYaLgZYDLLk2gayHrJKNyRt4vBQB',
    pk2: 'bls12381g2:2995BcogDeU9PQxbssLWhG9J76ubezYVpjbceWnwcmRs9ypA2vYDikf8mpuzankQX6WMsDockieKarmDerS2xTPzR1dktiHiGkjvPpRYpDip6unu4WgtPqeCPtxqppMzuGwy' } },
  generator: { AppPublicKeyPV: { pk1: GEN1,
    pk2: 'bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK' } },
  plain: { AppPublicKey: GEN1 },
};

const dec = s => bs58.decode(s.split(':')[1]);
const appIdOf = (acct, path) => sha3_256(te.encode(`near-mpc v0.1.0 app_id derivation:${acct},${path}`));
const Hid = (pkB, appId) => bls.G1.hashToCurve(new Uint8Array([...pkB, ...appId]), { DST });

// S from the CKD output: identity S = C; generator / plain (a = 1) S = C - Y
const keyFromCkd = (mode, Y, C) => mode === 'identity' ? C : C.subtract(Y);
// e(S,G2) == e(H(pk||app_id), pk); false (no throw) for the zero point (noble refuses pairings with it)
function checkKey(S, pkB, appId) {
  if (S.equals(G1.ZERO)) return false;
  return Fp12.eql(bls.pairing(S, G2.BASE), bls.pairing(Hid(pkB, appId), G2.fromBytes(pkB)));
}
// general PV equation e(C,G2) == e(Y,pk2)·e(H,pk); the e(Y,pk2) term is dropped when pk2 is the zero point
function checkPv(Y, C, pk2, pkB, appId) {
  const lhs = bls.pairing(C, G2.BASE), h = bls.pairing(Hid(pkB, appId), G2.fromBytes(pkB));
  return Fp12.eql(lhs, pk2.equals(G2.ZERO) ? h : Fp12.mul(bls.pairing(Y, pk2), h));
}
// returns {pairing, wrong_app_id} for mode identity|generator|plain (S equation) or pv (PV equation)
function runChecks({ mode, pk, pk2, acct, path, big_y, big_c }) {
  const pkB = dec(pk), Y = G1.fromBytes(dec(big_y)), C = G1.fromBytes(dec(big_c));
  const one = a => mode === 'pv'
    ? checkPv(Y, C, G2.fromBytes(dec(pk2)), pkB, appIdOf(a, path))
    : checkKey(keyFromCkd(mode, Y, C), pkB, appIdOf(a, path));
  return { pairing: one(acct), wrong_app_id: one('mallory.near') };
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i]; else o._.push(argv[i]);
  }
  return o;
}

async function rpc(urls, method, params) {
  let last;
  for (const url of urls) {
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

async function txMode(o) {
  const network = o.network ?? 'mainnet', net = NET[network];
  if (!net) throw new Error(`unknown --network ${network}`);
  if (!o.tx || !o.sender || !o.mode || !o.path) throw new Error('need --tx, --sender, --mode, --path');
  if (!['identity', 'generator', 'plain', 'pv'].includes(o.mode)) throw new Error(`unknown --mode ${o.mode}`);
  const urls = o.rpc ? [o.rpc] : [...net.rpc, ...net.archival];
  const tx = await rpc(urls, 'EXPERIMENTAL_tx_status', { tx_hash: o.tx, sender_account_id: o.sender, wait_until: 'FINAL' });
  const fail = [];

  // request receipt: executed by the MPC contract, log starts with "request_app_private_key:"
  const reqOut = tx.receipts_outcome.find(r => r.outcome.executor_id === net.mpc
    && r.outcome.logs.some(l => l.startsWith('request_app_private_key:')));
  if (!reqOut) throw new Error(`no request_app_private_key receipt on ${net.mpc} in tx ${o.tx}`);
  const log = reqOut.outcome.logs.find(l => l.startsWith('request_app_private_key:'));
  const caller = /predecessor=AccountId\("([^"]+)"\)/.exec(log)?.[1];
  if (!caller) throw new Error(`cannot read predecessor from log: ${log.slice(0, 120)}`);
  if (!log.includes(`derivation_path: "${o.path}"`)) fail.push('path mismatch');
  // request args from the FunctionCall action of the same receipt
  const reqReceipt = tx.receipts.find(r => r.receipt_id === reqOut.id);
  const fc = reqReceipt?.receipt?.Action?.actions?.find(a => a.FunctionCall?.method_name === 'request_app_private_key')?.FunctionCall;
  if (!fc) throw new Error('request receipt has no request_app_private_key FunctionCall');
  const request = JSON.parse(Buffer.from(fc.args, 'base64').toString()).request;
  if (o.mode !== 'pv' && JSON.stringify(request.app_public_key) !== JSON.stringify(APP_PK[o.mode])) fail.push('mode mismatch');
  if (request.domain_id !== 2) fail.push(`domain_id ${request.domain_id} != 2`);

  // response receipt: a SuccessValue that decodes to JSON with big_y
  let response, respOut;
  for (const r of tx.receipts_outcome) {
    const sv = r.outcome.status?.SuccessValue;
    if (!sv) continue;
    try { const j = JSON.parse(Buffer.from(sv, 'base64').toString()); if (j?.big_y) { response = j; respOut = r; break; } } catch {}
  }
  const errors = tx.receipts_outcome.filter(r => r.outcome.status?.Failure).map(r => JSON.stringify(r.outcome.status.Failure));
  if (!response) fail.push(`no CKD response${errors.length ? ': ' + errors.join('; ') : ''}`);

  const height = async h => Number((await rpc(urls, 'block', { block_id: h })).header.height);
  const blocks = { tx: await height(tx.transaction_outcome.block_hash), request: await height(reqOut.block_hash),
    response: respOut ? await height(respOut.block_hash) : null };
  const latency = respOut ? blocks.response - blocks.request : null;
  const respBlock = respOut ? await rpc(urls, 'block', { block_id: respOut.block_hash }) : null;
  let mpcVersion = null;
  try {
    const v = await rpc(urls, 'query', { request_type: 'call_function', finality: 'final', account_id: net.mpc, method_name: 'version', args_base64: '' });
    mpcVersion = JSON.parse(new TextDecoder().decode(Uint8Array.from(v.result)));
  } catch {}

  const pk2 = o.mode === 'pv' ? request.app_public_key.AppPublicKeyPV?.pk2 : undefined;
  const check = response && !fail.includes('path mismatch')
    ? runChecks({ mode: o.mode, pk: net.mpk, pk2, acct: caller, path: o.path, ...response })
    : { pairing: false, wrong_app_id: null };
  if (response && !check.pairing) fail.push('pairing check false');
  if (check.wrong_app_id) fail.push('wrong app_id accepted');
  if (latency !== null && latency >= 30) fail.push(`latency ${latency} blocks >= 30`);

  const out = {
    gate: network === 'testnet' ? 'S1-testnet' : 'S1', mode: o.mode, network, mpc: net.mpc, mpc_version: mpcVersion,
    caller, path: o.path, app_id_hex: bytesToHex(appIdOf(caller, o.path)),
    request: { derivation_path: request.derivation_path, app_public_key: request.app_public_key, domain_id: request.domain_id },
    response: response ?? null, tx_hash: o.tx, blocks, latency_blocks: latency, check,
    result: fail.length ? 'FAIL' : 'PASS',
    date_utc: respBlock ? new Date(Number(BigInt(respBlock.header.timestamp_nanosec) / 1_000_000n)).toISOString().replace(/\.\d+Z$/, 'Z') : null,
  };
  if (fail.length) out.fail = fail;
  console.log(`caller (MPC predecessor, app_id account): ${caller}; signer: ${o.sender}`);
  console.log(`blocks: tx ${blocks.tx}, request ${blocks.request}, response ${blocks.response}; latency_blocks: ${latency}`);
  console.log(o.mode === 'pv' ? `PV equation e(C,G2) = e(Y,pk2)·e(H(pk‖app_id),pk): ${check.pairing}`
    : `S (${o.mode}) e(S,G2) = e(H(pk‖app_id),pk): ${check.pairing}`);
  console.log(`wrong app_id (mallory.near): ${check.wrong_app_id}`);
  if (o.out) { fs.writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n'); console.log(`wrote ${o.out}`); }
  console.log(fail.length ? `FAIL ${fail.join('; ')}` : 'PASS');
  return !fail.length;
}

function fileMode(file) {
  const L = JSON.parse(fs.readFileSync(file));
  let ok = true;
  if (L.pk2) {
    const c = runChecks({ ...L, mode: 'pv' });
    console.log(`PV equation e(C,G2) = e(Y,pk2)·e(H(pk‖app_id),pk): ${c.pairing}`);
    console.log(`wrong app_id (mallory.near): ${c.wrong_app_id}`);
    ok &&= c.pairing && !c.wrong_app_id;
  }
  if (L.mode) {
    const c = runChecks(L);
    console.log(`S (${L.mode}) e(S,G2) = e(H(pk‖app_id),pk): ${c.pairing}`);
    console.log(`wrong app_id (mallory.near): ${c.wrong_app_id}`);
    ok &&= c.pairing && !c.wrong_app_id;
  }
  if (!L.pk2 && !L.mode) throw new Error('file needs pk2 or mode');
  return ok;
}

const o = args(process.argv.slice(2));
try {
  const ok = o.tx ? await txMode(o) : o._[0] ? fileMode(o._[0]) : (() => { throw new Error('usage: see header of s1-check.mjs'); })();
  process.exit(ok ? 0 : 1);
} catch (e) { console.error(`FAIL ${e.message}`); process.exit(1); }
