// pnpm demo:local — the whole sale lifecycle offline in a few seconds, no wallet, no network:
// seal 6 bids → no key exists → simulated MPC releases the key → decrypt → commitments → uniform clearing.
// The MPC is simulated with the public near/mpc test vectors; mainnet uses v1.signer.
import './lib/node-version.js';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type ClearResult, clear, fromFixture } from '@tender/clearing';
import { type AppPkMode, appId, checkKey, decryptBids, keyFromCkd, sealBid } from '@tender/seal';
import { type Io, UsageError, consoleIo, parseCli, runMain } from './lib/args.js';
import { DEMO_APP_PK_MODE } from './lib/config.js';
import { formatTokens, formatUsdc, priceUnit, stringifyJson } from './lib/format.js';
import { demoSaleFixturePath, repoRoot } from './lib/paths.js';
import { DEMO_BIDDERS, simulateMpc } from './lib/sim.js';

const USAGE = 'usage: pnpm demo:local [--mode identity|generator|plain] [--seed <hex>]';
const MODES: AppPkMode[] = ['identity', 'generator', 'plain'];
const te = new TextEncoder();

export interface DemoResult {
  exitCode: number;
  lastLine: string;
  elapsedMs: number;
}

export function runDemo({ mode = DEMO_APP_PK_MODE, seed }: { mode?: AppPkMode; seed?: string } = {}, io: Io = consoleIo): DemoResult {
  const t0 = performance.now();
  if (!MODES.includes(mode)) throw new UsageError(`unknown --mode "${mode}"`);
  if (seed !== undefined && !/^[0-9a-fA-F]+$/.test(seed)) throw new UsageError('--seed must be hex');
  const lines: string[] = [];
  const out = (l: string) => {
    lines.push(l);
    io.out(l);
  };

  out('simulated MPC: test key from near/mpc vectors (msk is public in that file; mainnet uses v1.signer)');
  const fixtureFile = demoSaleFixturePath();
  const { sale, bids, expected } = fromFixture(JSON.parse(readFileSync(fixtureFile, 'utf8')));
  const contract = 'v1.tenderseal.near';
  const path = 'tender/1/' + bytesToHex(sha256(te.encode('tender-demo-local'))).slice(0, 32);
  const id = appId(contract, path);
  const mpc = simulateMpc({ vectorIndex: 0, contract, path, mode });
  const token = 'nep141:wrap.near';
  const unit = priceUnit({ token, lot_exp: sale.lot_exp });
  out(`sale 1 · ${contract} · demo-sale-1 (${fixtureFile.slice(repoRoot().length + 1)}) · supply ${formatTokens(sale.S, sale.decimals)} NEAR · reserve ${formatUsdc(sale.reserve)} ${unit} · mode ${mode}`);
  out(`identity: app_id = sha3_256("near-mpc v0.1.0 app_id derivation:${contract},${path}") = ${bytesToHex(id)}`);

  // 1. seal
  const sealed = bids.map((b, i) => {
    const who = DEMO_BIDDERS[i] ?? { label: `bidder ${i}`, origin: 'near' as const, bidder: `bidder${i}.near` };
    const salt = seed === undefined ? undefined : hexToBytes(bytesToHex(sha256(te.encode(`${seed}/${i}`))).slice(0, 32));
    const s = sealBid({ mpk: mpc.mpk, contract, path, sale: 1n, bidder: who.bidder, B: b.B, p: b.p!, q: b.q!, ...(salt ? { salt } : {}) });
    return { ...b, ...who, ...s };
  });
  out('');
  out('ciphertext wall (what everyone sees on chain before close)');
  out(`${'idx'.padEnd(4)}${'origin'.padEnd(32)}${'escrow USDC'.padStart(12)}  ${'ct (160 B)'.padEnd(20)}  cm`);
  for (const s of sealed) {
    out(`${String(s.idx).padEnd(4)}${s.label.padEnd(32)}${formatUsdc(s.B).padStart(12)}  ${s.ct_b64.slice(0, 16)}…  ${s.cm_hex.slice(0, 12)}…`);
  }

  // 2. close: no key yet
  out('');
  out('close · key_requests = 0 · no key exists yet: decrypt impossible');

  // 3. open: the (simulated) MPC derives the key for app_id(contract, path)
  const S = keyFromCkd(mpc.response, mode);
  const keyOk = checkKey(S, mpc.mpk, id);
  out(`open · key released (simulated) · checkKey ${keyOk}`);

  // 4. decrypt + commitments
  const dec = decryptBids({
    S,
    contract,
    path,
    sale: 1n,
    bids: sealed.map((s) => ({ idx: s.idx, bidder: s.bidder, B: s.B, ct: s.ct_b64, cm: s.cm_hex })),
  });
  const nOk = dec.filter((d) => d.ok).length;
  const nCm = dec.filter((d) => d.cmOk).length;
  const plainOk = dec.every((d, i) => d.ok && d.p === sealed[i]!.p && d.q === sealed[i]!.q);
  out(`decrypt · ${nOk}/${bids.length} bids decrypted · commitments ${nCm}/${bids.length}`);

  // 5. clearing on the decrypted bids
  const got = clear(
    sale,
    dec.map((d, i) => ({ idx: d.idx, B: sealed[i]!.B, p: d.p ?? null, q: d.q ?? null, state: d.ok && d.cmOk ? 'Revealed' : 'Sealed' })),
  );
  const diffs = (Object.keys(expected) as (keyof ClearResult)[]).filter((k) => stringifyJson(got[k]) !== stringifyJson(expected[k]));
  out('');
  out(`${'idx'.padEnd(4)}${'origin'.padEnd(32)}${`p ${unit}`.padStart(16)}${'q USDC'.padStart(10)}${'alloc NEAR'.padStart(30)}${'spend'.padStart(12)}${'refund'.padStart(12)}`);
  for (const s of sealed) {
    const i = s.idx;
    out(
      `${String(i).padEnd(4)}${s.label.padEnd(32)}${formatUsdc(dec[i]?.p ?? 0n).padStart(16)}${formatUsdc(dec[i]?.q ?? 0n).padStart(10)}` +
        `${formatTokens(got.alloc[i]!, sale.decimals).padStart(30)}${formatUsdc(got.spend[i]!).padStart(12)}${formatUsdc(got.refund[i]!).padStart(12)}`,
    );
  }
  out(`seller: ${formatUsdc(got.seller_usdc)} USDC · tokens back ${formatTokens(got.seller_tokens_back, sale.decimals)} NEAR`);

  let exitCode = 0;
  if (!keyOk || !plainOk || nOk !== bids.length || nCm !== bids.length) exitCode = 1;
  if (diffs.length > 0) {
    exitCode = 1;
    out('clearing differs from the fixture:');
    for (const k of diffs) out(`  ${k}: got ${stringifyJson(got[k])} expected ${stringifyJson(expected[k])}`);
  }
  const pStar = got.P_star === null ? 'none' : formatUsdc(got.P_star);
  out(`P* = ${pStar} ${unit} · ${nOk}/${bids.length} bids decrypted · commitments ${nCm}/${bids.length}`);
  const elapsedMs = performance.now() - t0;
  io.err(`done in ${(elapsedMs / 1000).toFixed(1)} s`);
  return { exitCode, lastLine: lines.at(-1)!, elapsedMs };
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  const v = parseCli(argv, { mode: { type: 'string' }, seed: { type: 'string' } }, false);
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  return runDemo({ mode: (v.mode ?? DEMO_APP_PK_MODE) as AppPkMode, ...(v.seed ? { seed: v.seed } : {}) }, io).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, USAGE);
