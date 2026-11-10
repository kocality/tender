// pnpm verify --sale N | --keys — re-read the contract's state for free and recompute everything: the MPC key,
// the code, the access keys, every bid's decryption and commitment, the clearing, the payouts and the key ledger.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MPC_DOMAIN2_PK } from '@tender/seal';
import { COMMON_USAGE, type Io, UsageError, consoleIo, parseCli, runMain } from './lib/args.js';
import { resolveNetwork } from './lib/config.js';
import { utcFromNs } from './lib/format.js';
import { repoRoot, userPath } from './lib/paths.js';
import { rebuildFromMetadata } from './lib/rebuild.js';
import { exitCode, printChecks } from './lib/report.js';
import { Rpc, RpcError } from './lib/rpc.js';
import { runKeys } from './lib/verify-keys.js';
import { type EvidenceRow, SaleNotFound, runSaleChecks } from './lib/verify-sale.js';

const USAGE = `usage: pnpm verify --sale N [--rebuild] [--wasm <file>] [--evidence <file>]
       pnpm verify --keys
${COMMON_USAGE}`;

export interface VerifyDeps {
  /** JSON-RPC fetch (tests). */
  fetchImpl?: typeof fetch;
  /** NearBlocks and 1Click fetch (tests). */
  httpFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Domain-2 key to expect instead of the repository constant (tests with the simulated MPC). */
  repoMpk?: string;
}

function readWasm(path: string): Uint8Array<ArrayBuffer> | null {
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

function readEvidence(path: string): EvidenceRow[] | null {
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(j)) throw new Error(`${path}: expected a JSON array of rows`);
  return j as EvidenceRow[];
}

export async function main(argv: string[], io: Io = consoleIo, deps: VerifyDeps = {}): Promise<number> {
  const v = parseCli(argv, {
    sale: { type: 'string' },
    keys: { type: 'boolean' },
    rebuild: { type: 'boolean' },
    wasm: { type: 'string' },
    evidence: { type: 'string' },
  });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }
  if (v.keys === Boolean(v.sale)) throw new UsageError('give exactly one of --sale N or --keys');
  if (v.sale !== undefined && !/^\d+$/.test(v.sale)) throw new UsageError('--sale N must be a sale id');
  const net = resolveNetwork({ network: v.network, contract: v.contract, rpc: v.rpc, archivalRpc: v['archival-rpc'] });
  const opts = { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const rpc = new Rpc(net.rpc, opts);
  const archival = new Rpc(net.archival, opts);
  const repoMpk = deps.repoMpk ?? MPC_DOMAIN2_PK[net.network];

  try {
    const head = await rpc.finalBlock();
    const block = { height: head.height, timestamp_ns: head.timestamp_ns };
    const what = v.keys ? 'keys' : `sale ${v.sale}`;
    io.out(`Tender verify · ${what} · ${net.contract} · ${net.network} · block ${head.height} (${utcFromNs(head.timestamp_ns)})`);
    io.out(`rpc ${rpc.lastProvider} · archival ${net.archival[0]}`);

    if (v.keys) {
      const r = await runKeys({ net, rpc, block, repoMpk, ...(deps.httpFetch ? { fetchImpl: deps.httpFetch } : {}) });
      for (const l of r.lines) io.out(l);
      return r.exitCode;
    }

    const root = repoRoot();
    // Paths inside the repository print relative to its root.
    const show = (p: string) => {
      const r = relative(root, p);
      return r.startsWith('..') || isAbsolute(r) ? p : r;
    };
    const wasmPath = v.wasm ? userPath(v.wasm) : join(root, 'contract/res/tender.wasm');
    const evidencePath = v.evidence ? userPath(v.evidence) : join(root, 'evidence/mainnet.json');
    const checks = await runSaleChecks({
      net,
      saleId: BigInt(v.sale!),
      rpc,
      archival,
      block,
      wasm: { path: show(wasmPath), bytes: readWasm(wasmPath) },
      evidence: { path: show(evidencePath), rows: readEvidence(evidencePath) },
      repoMpk,
      ...(v.rebuild ? { rebuild: (meta) => rebuildFromMetadata(meta, { repo: root, log: io.err }) } : {}),
      ...(deps.httpFetch ? { fetchImpl: deps.httpFetch } : {}),
    });
    printChecks(checks, io.out);
    return exitCode(checks);
  } catch (e) {
    if (e instanceof SaleNotFound) {
      io.err(e.message);
      return 1;
    }
    // No provider gave an answer at all (network down, rate limited): not a verdict on the contract.
    if (e instanceof RpcError && e.cause_name === undefined) {
      io.err(`ERROR: could not read state from any RPC provider; try --rpc <url> (${e.message})`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runMain(main, USAGE);
