// verify --keys: the contract's key ledger. Every CKD key the contract ever asked the MPC for is a ledger entry
// written before the call; a sale with 0 requests had its key never requested (a query, not a promise: the
// ciphertexts stay on chain and the MPC threshold colluding could still derive the key).
import { type G1Point, decryptBids, keyFromCkd } from '@tender/seal';
import type { ResolvedNetwork } from './config.js';
import { utcFromNs } from './format.js';
import { fetchKeyReceipts } from './nearblocks.js';
import type { Rpc } from './rpc.js';
import { MpcViews, type SaleView, TenderViews } from './views.js';

export interface KeysCtx {
  net: ResolvedNetwork;
  rpc: Rpc;
  block: { height: bigint; timestamp_ns: bigint };
  /** Domain-2 MPC key the repository pins for this network. */
  repoMpk: string;
  /** fetch for NearBlocks (tests). */
  fetchImpl?: typeof fetch;
}

const NEVER = 'never requested (sealed unless the MPC threshold colludes)';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Ledger consistency for one sale (same rules as verify --sale #21). */
function ledgerProblems(s: SaleView, entries: { i: string; outcome: string; ns: string; resolved_block: string | null }[]): string[] {
  const bad: string[] = [];
  const ok = entries.filter((k) => k.outcome === 'Ok');
  if (entries.length !== s.key_requests) bad.push(`sale ${s.id}: ${entries.length} ledger entries ≠ key_requests ${s.key_requests}`);
  if (ok.length > 1) bad.push(`sale ${s.id}: ${ok.length} Ok entries`);
  if (s.key && ok.length === 0) bad.push(`sale ${s.id}: a key is stored but no Ok entry exists`);
  if (!s.key && ok.length > 0) bad.push(`sale ${s.id}: an Ok entry exists but no key is stored`);
  if (s.key && ok.length === 1 && (ok[0]!.resolved_block !== s.key.block || BigInt(s.key.ns) < BigInt(ok[0]!.ns))) {
    bad.push(`sale ${s.id}: Ok entry #${ok[0]!.i} does not match the key at block ${s.key.block}`);
  }
  const pending = entries.filter((k) => k.outcome === 'Pending').length;
  if (pending !== (s.in_flight ? 1 : 0)) bad.push(`sale ${s.id}: ${pending} Pending entries, in_flight ${s.in_flight}`);
  return bad;
}

export async function runKeys(ctx: KeysCtx): Promise<{ lines: string[]; exitCode: number }> {
  const { net, rpc } = ctx;
  const at = ctx.block.height;
  const views = new TenderViews(rpc, net.contract);
  const config = await views.config(at);
  const mpc = new MpcViews(rpc, config.mpc);
  const [sales, keyLog, version, state, liveMpk] = await Promise.all([
    views.sales(at),
    views.keyLog(at),
    mpc.version(at),
    mpc.state(at),
    mpc.publicKey(Number(config.domain_id), at),
  ]);

  const lines: string[] = [];
  let exitCode = 0;
  const keyOk = config.mpc_public_key === ctx.repoMpk && liveMpk === ctx.repoMpk && config.domain_id === '2';
  if (!keyOk) exitCode = 1;
  lines.push(
    `${config.mpc} ${version} · threshold ${state.threshold ?? '?'} of ${state.participants ?? '?'} (live) · ` +
      (keyOk ? 'domain 2 key = repo constant' : `domain ${config.domain_id} key MISMATCH: contract ${config.mpc_public_key} · live ${liveMpk} · repo ${ctx.repoMpk}`),
  );

  lines.push(`key log (contract state): ${plural(keyLog.length, 'request')}`);
  for (const k of keyLog) {
    lines.push(`  ${`sale ${k.sale}`.padEnd(8)} ${utcFromNs(k.ns)}   ${k.outcome.toLowerCase().padEnd(7)} block ${k.block}`);
  }

  const results = new Map(
    await Promise.all(sales.filter((s) => s.state === 'Cancelled').map(async (s) => [s.id, await views.result(BigInt(s.id), at)] as const)),
  );
  for (const s of sales) {
    if (s.state === 'Cancelled' && s.key_requests > 0) lines.push(`  ${`sale ${s.id}`.padEnd(8)} cancelled after ${s.key_requests} requests: may be decryptable`);
    if (s.key_requests !== 0) continue;
    if (s.state === 'Cancelled') {
      const r = results.get(s.id);
      const when = r ? ` ${utcFromNs(r.ns)}` : '';
      lines.push(`  ${`sale ${s.id}`.padEnd(8)} 0 requests · Cancelled${when} · ${NEVER} · open() unreachable (terminal state)`);
    } else {
      lines.push(`  ${`sale ${s.id}`.padEnd(8)} 0 requests · ${s.state} · closes ${utcFromNs(s.close_ns)}`);
    }
  }

  // Ledger consistency, contract-wide.
  const bad: string[] = [];
  if (keyLog.length !== Number(config.key_log_len)) bad.push(`key log has ${keyLog.length} entries, key_log_len ${config.key_log_len}`);
  if (keyLog.some((k, i) => k.i !== String(i))) bad.push('key log index not 0..n-1');
  const ids = new Set(sales.map((s) => s.id));
  for (const k of keyLog) if (!ids.has(k.sale)) bad.push(`key log entry #${k.i} names unknown sale ${k.sale}`);
  for (const s of sales) bad.push(...ledgerProblems(s, keyLog.filter((k) => k.sale === s.id)));
  for (const b of bad) lines.push(`ledger mismatch: ${b}`);
  if (bad.length) exitCode = 1;

  // Independent indexer (WARN only).
  const nb = await fetchKeyReceipts({
    base: net.nearblocks,
    account: net.contract,
    mpc: config.mpc,
    ...(net.nearblocksApiKey ? { apiKey: net.nearblocksApiKey } : {}),
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  const nbHead = `NearBlocks: receipts ${net.contract} → ${config.mpc}.request_app_private_key`;
  if (!nb.ok) lines.push(`${nbHead} unavailable (WARN: ${nb.warn})`);
  else if (nb.truncated) lines.push(`${nbHead} ≥ ${nb.count} (WARN: more pages than one request reads)`);
  else if (nb.count !== keyLog.length) lines.push(`${nbHead} = ${nb.count} (WARN: key log has ${keyLog.length}; indexing lag? run again in 10 min)`);
  else lines.push(`${nbHead} = ${nb.count} (match)`);

  // Every released key, tried on every bid of every sale whose key was never requested: expect 0.
  const released: G1Point[] = [];
  for (const s of sales) {
    if (!s.key) continue;
    try {
      released.push(keyFromCkd(s.key, config.app_pk_mode));
    } catch {
      // An unparsable stored key opens nothing; verify --sale reports it (#11).
    }
  }
  for (const s of sales.filter((x) => x.state === 'Cancelled' && x.key_requests === 0)) {
    const bids = await views.bids(BigInt(s.id), at);
    const input = bids.map((b) => ({ idx: b.idx, bidder: b.bidder, B: BigInt(b.escrow), ct: b.ct, cm: b.cm }));
    const opened = new Set<number>();
    for (const S of released) {
      for (const d of decryptBids({ S, contract: net.contract, path: s.path, sale: BigInt(s.id), bids: input })) if (d.ok) opened.add(d.idx);
    }
    const head = `sale ${s.id}: ${plural(bids.length, 'sealed bid')}`;
    if (!released.length) lines.push(`${head} · no key released by this contract yet, nothing to try`);
    else lines.push(`${head} · tried every released key: ${opened.size} decrypt`);
    if (opened.size) exitCode = 1;
  }
  return { lines, exitCode };
}
