// pnpm seal:try --sale N — seal a test message to sale N's identity and show whether its key exists yet (V8).
// --try-key <file>: check a CKD response someone else obtained (M15: an EOA asking the MPC for the sale's path
// gets a real key, but for app_id(EOA, path), which does not open the contract's sale).
import './lib/node-version.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type CkdResponse, appId, checkKey, ctToBase64, decrypt, decryptBids, encrypt, keyFromCkd } from '@tender/seal';
import { COMMON_USAGE, type Io, UsageError, consoleIo, parseCli, runMain } from './lib/args.js';
import { resolveNetwork } from './lib/config.js';
import { utcFromNs } from './lib/format.js';
import { userPath } from './lib/paths.js';
import { Rpc } from './lib/rpc.js';
import { TenderViews } from './lib/views.js';

const USAGE = `usage: pnpm seal:try --sale N [--try-key <file> [--caller <account>]]\n${COMMON_USAGE}`;
const CANCELLED_NEVER = 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';

export interface SealTryDeps {
  fetchImpl?: typeof fetch;
}

function readTryKey(file: string): { response: CkdResponse; caller?: string; path?: string; tx_hash?: string } {
  const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const r = (j.response ?? j) as Partial<CkdResponse>;
  if (typeof r.big_y !== 'string' || typeof r.big_c !== 'string') throw new Error(`${file}: no {big_y, big_c} CKD response`);
  return {
    response: { big_y: r.big_y, big_c: r.big_c },
    ...(typeof j.caller === 'string' ? { caller: j.caller } : {}),
    ...(typeof j.path === 'string' ? { path: j.path } : {}),
    ...(typeof j.tx_hash === 'string' ? { tx_hash: j.tx_hash } : {}),
  };
}

export async function main(argv: string[], io: Io = consoleIo, deps: SealTryDeps = {}): Promise<number> {
  const v = parseCli(argv, { sale: { type: 'string' }, 'try-key': { type: 'string' }, caller: { type: 'string' } });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  if (!v.sale || !/^\d+$/.test(v.sale)) throw new UsageError('--sale N is required');
  const saleId = BigInt(v.sale);
  const net = resolveNetwork({ network: v.network, contract: v.contract, rpc: v.rpc, archivalRpc: v['archival-rpc'] });
  const rpc = new Rpc(net.rpc, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const views = new TenderViews(rpc, net.contract);
  const block = (await rpc.finalBlock()).height;
  const [config, sale] = await Promise.all([views.config(block), views.sale(saleId, block)]);
  if (!sale) {
    io.err(`sale ${saleId} not found on ${net.contract}`);
    return 1;
  }

  io.out(`sale ${saleId} · ${net.contract} · state ${sale.state} · closes ${utcFromNs(sale.close_ns)}`);
  const id = appId(net.contract, sale.path);
  io.out(`identity: app_id = sha3_256("near-mpc v0.1.0 app_id derivation:${net.contract},${sale.path}") = ${bytesToHex(id)}`);
  const msg = new TextEncoder().encode(`seal:try test message, sale ${saleId}`.padEnd(32, '.').slice(0, 32));
  const ct = encrypt(config.mpc_public_key, id, msg);
  io.out(`sealed a test message to this identity: ct ${ctToBase64(ct).slice(0, 16)}… (${ct.length} B)`);

  let code = 0;
  if (sale.key) {
    const S = keyFromCkd(sale.key, config.app_pk_mode);
    const keyOk = checkKey(S, config.mpc_public_key, id);
    let decOk = false;
    try {
      decOk = bytesToHex(decrypt(S, ct)) === bytesToHex(msg);
    } catch {
      decOk = false;
    }
    io.out(`key released at block ${sale.key.block} (${utcFromNs(sale.key.ns)}) · checkKey ${keyOk} · test message decrypts: ${decOk ? 'OK' : 'FAILED'}`);
    if (!keyOk || !decOk) code = 1;
  } else if (sale.key_requests === 0) {
    if (sale.state === 'Cancelled') io.out(CANCELLED_NEVER);
    io.out(`sealed: no key has been requested for sale ${saleId} (key_requests = 0)`);
  } else {
    const mine = (await views.keyLog(block)).filter((k) => k.sale === sale.id);
    const last = mine.at(-1)?.outcome ?? (sale.in_flight ? 'Pending' : 'Err');
    io.out(`sealed: ${sale.key_requests} key request(s) made, no key released yet (last outcome: ${last})`);
  }

  if (v['try-key']) {
    const file = userPath(v['try-key']);
    const t = readTryKey(file);
    const caller = t.caller ?? v.caller;
    if (!caller) throw new UsageError('--try-key with a bare {big_y, big_c} file needs --caller <account>');
    const path = t.path ?? sale.path;
    const S = keyFromCkd(t.response, config.app_pk_mode);
    const forCaller = checkKey(S, config.mpc_public_key, appId(caller, path));
    const forSale = checkKey(S, config.mpc_public_key, id);
    const bids = await views.bids(saleId, block);
    const dec = decryptBids({
      S,
      contract: net.contract,
      path: sale.path,
      sale: saleId,
      bids: bids.map((b) => ({ idx: b.idx, bidder: b.bidder, B: BigInt(b.escrow), ct: b.ct, cm: b.cm })),
    });
    io.out(`try-key: CKD response from ${v['try-key']} (tx ${t.tx_hash ?? 'n/a'}, caller ${caller}, path ${path})`);
    io.out(`  checkKey vs app_id(${caller}, path): ${forCaller}${forCaller ? '      (a real MPC key)' : ''}`);
    io.out(`  checkKey vs app_id(${net.contract}, path): ${forSale}`);
    io.out(`  bids decrypted with it: ${dec.filter((d) => d.ok).length}/${bids.length}`);
    if (forSale) io.out(`this key opens sale ${saleId}`);
    else if (forCaller) io.out(`wrong identity: this key was derived for ${caller}, not ${net.contract}`);
    else {
      io.out(`not a key for app_id(${caller}, path) or app_id(${net.contract}, path)`);
      code = 1;
    }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, USAGE);
