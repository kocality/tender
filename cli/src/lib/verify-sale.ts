// verify --sale N: 27 checks recomputed from the contract's current state, all read at one pinned block (P-6).
// The mandatory checks need no archival RPC, NearBlocks or 1Click; those three only ever produce WARN.
import { bytesToHex } from '@noble/hashes/utils.js';
import { type BidState, type ClearResult, clear } from '@tender/clearing';
import { type DecryptedBid, type G1Point, appId, checkKey, decryptBids, keyFromCkd } from '@tender/seal';
import { type ResolvedNetwork, TESTED_INTENTS_CODE_HASH, TESTED_MPC_VERSION } from './config.js';
import { accountUrl, blockUrl, txUrl } from './explorer.js';
import { formatUsdc, priceUnit, utcFromNs } from './format.js';
import { fetchKeyReceipts } from './nearblocks.js';
import { fetchStatus } from './oneclick.js';
import type { Check, Status } from './report.js';
import type { Rpc } from './rpc.js';
import { type BidView, IntentsViews, MpcViews, type PaidView, type SaleView, type SourceMetadata, TenderViews } from './views.js';
import { FORBIDDEN_IMPORT_RE, codeHashB58, wasmImports } from './wasm.js';

export const CANCELLED_NEVER = 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';

/** One row of evidence/mainnet.json (written by the relayer's record script). */
export interface EvidenceRow {
  sale: string;
  step: string;
  tx_hash: string;
  signer_id?: string;
  network?: 'mainnet' | 'testnet';
  contract?: string;
  deposit_address?: string;
  outcome?: 'success' | 'failure';
  expected?: 'success' | 'failure';
}

export type RebuildResult = { kind: 'hash'; codeHash: string; rev: string } | { kind: 'unavailable'; reason: string };

export interface VerifyCtx {
  net: ResolvedNetwork;
  saleId: bigint;
  rpc: Rpc;
  archival: Rpc;
  /** The pinned block every view reads; its timestamp is "now". */
  block: { height: bigint; timestamp_ns: bigint };
  wasm: { path: string; bytes: Uint8Array<ArrayBuffer> | null };
  /** rows = null when the evidence file does not exist. */
  evidence: { path: string; rows: EvidenceRow[] | null };
  /** Domain-2 MPC key the repository pins for this network. */
  repoMpk: string;
  /** Set only with --rebuild. */
  rebuild?: (meta: SourceMetadata) => Promise<RebuildResult>;
  /** fetch for NearBlocks and 1Click (tests). */
  fetchImpl?: typeof fetch;
}

export class SaleNotFound extends Error {}

/** Evidence tag of a sale: rehearsal-contract rows are tagged R, the locked contract's rows by sale id. */
export function evidenceRows(rows: EvidenceRow[], net: ResolvedNetwork, saleId: bigint): EvidenceRow[] {
  const tag = /^rehearsal\./.test(net.contract) ? 'R' : saleId.toString();
  return rows.filter((r) => r.sale === tag && (r.network ?? 'mainnet') === net.network && (!r.contract || r.contract === net.contract));
}

const NS = 1_000_000_000n;
const MIN_REVEAL_SECS = 86_400n; // contract sale::MIN_REVEAL_SECS (also the cancel rule (b) delay after close)
const IN_FLIGHT_TIMEOUT_SECS = 3_600n; // contract IN_FLIGHT_TIMEOUT_SECS: an older request in flight is dead

const big = (s: string | null | undefined): bigint => BigInt(s ?? '0');
const sum = (xs: bigint[]): bigint => xs.reduce((a, x) => a + x, 0n);
const short = (s: string): string => (s.length > 24 ? `${s.slice(0, 16)}…${s.slice(-4)}` : s);
const settled = (s: SaleView) => s.state === 'Finalized' || s.state === 'Cancelled';

async function attempt<T>(f: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; err: string }> {
  try {
    return { ok: true, v: await f() };
  } catch (e) {
    return { ok: false, err: (e as Error).message.split('\n')[0]!.slice(0, 160) };
  }
}

/** Tender NEP-297 events in a tx's receipt logs. */
function tenderEvents(r: unknown): { event: string; data: Record<string, unknown>[] }[] {
  const ros = (r as { receipts_outcome?: { outcome?: { logs?: string[] } }[] } | null)?.receipts_outcome ?? [];
  const out: { event: string; data: Record<string, unknown>[] }[] = [];
  for (const line of ros.flatMap((ro) => ro.outcome?.logs ?? [])) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: string; event?: string; data?: Record<string, unknown>[] };
      if (e.standard === 'tender' && typeof e.event === 'string') out.push({ event: e.event, data: e.data ?? [] });
    } catch {
      // not ours
    }
  }
  return out;
}

/**
 * A tx can succeed at top level while Tender refused the op (it returns the amount and emits `refund`) or a payout
 * failed (`payout` with ok false): those count as failure (S-05).
 */
function txOutcome(r: unknown): 'success' | 'failure' | 'pending' {
  const st = (r as { status?: Record<string, unknown> } | null)?.status ?? {};
  if ('Failure' in st) return 'failure';
  if (!('SuccessValue' in st)) return 'pending';
  const ev = tenderEvents(r);
  if (ev.some((e) => e.event === 'refund' || (e.event === 'payout' && e.data.some((d) => d.ok === false)))) return 'failure';
  return 'success';
}

export async function runSaleChecks(ctx: VerifyCtx): Promise<Check[]> {
  const { net, saleId, rpc } = ctx;
  const at = ctx.block.height;
  const now = ctx.block.timestamp_ns;
  const views = new TenderViews(rpc, net.contract);

  // Mandatory state: any provider failure here propagates (verify.ts turns it into exit 2).
  const [config, sale] = await Promise.all([views.config(at), views.sale(saleId, at)]);
  if (!sale) throw new SaleNotFound(`sale ${saleId} not found on ${net.contract}`);
  const mpc = new MpcViews(rpc, config.mpc);
  const [bids, result, sales, keyLog, account, keys, mpcVersion, mpcState, liveMpk] = await Promise.all([
    views.bids(saleId, at),
    views.result(saleId, at),
    views.sales(at),
    views.keyLog(at),
    rpc.viewAccount(net.contract, at),
    rpc.viewAccessKeyList(net.contract, at),
    mpc.version(at),
    mpc.state(at),
    mpc.publicKey(Number(config.domain_id), at),
  ]);
  const [tee, images, meta] = await Promise.all([
    attempt(() => mpc.teeAccounts(at)),
    attempt(() => mpc.allowedImages(at)),
    attempt(() => views.sourceMetadata(at)),
  ]);

  const checks: Check[] = [];
  const add = (n: number, name: string, status: Status, detail: string, link?: string) =>
    checks.push({ n, name, status, detail, ...(link ? { link } : {}) });
  const acct = accountUrl(net.network, net.contract);
  const unit = priceUnit(sale);
  const finalized = sale.state === 'Finalized';

  // #1 mpc-key
  {
    const bad: string[] = [];
    if (config.mpc !== net.mpc) bad.push(`config.mpc ${config.mpc} ≠ ${net.mpc}`);
    if (config.domain_id !== '2') bad.push(`domain_id ${config.domain_id} ≠ 2`);
    if (config.mpc_public_key !== ctx.repoMpk) bad.push(`contract key ${short(config.mpc_public_key)} ≠ repo constant ${short(ctx.repoMpk)}`);
    if (liveMpk !== ctx.repoMpk) bad.push(`live ${config.mpc}.public_key ${short(liveMpk)} ≠ repo constant`);
    if (bad.length) add(1, 'mpc-key', 'FAIL', bad.join('; '));
    else add(1, 'mpc-key', 'PASS', `domain 2 key ${short(liveMpk)} = repo constant = live ${config.mpc} = contract config`);
  }

  // #2 mpc-network (TEE counts are information only). Resharing gives the current nodes new shares but cannot revoke
  // the old ones, so former share holders count toward the collusion threshold too (CRYPTO-04).
  {
    const parts = [`${config.mpc} ${mpcVersion} · threshold ${mpcState.threshold ?? '?'} of ${mpcState.participants ?? '?'} (live)`];
    parts.push(
      `key epoch ${mpcState.epochId ?? '?'}, participant ids issued ${mpcState.nextId ?? '?'} (next_id): resharing does not revoke old shares, so the threshold counts former share holders too`,
    );
    parts.push(tee.ok ? `TEE accounts ${tee.v}` : `TEE accounts unavailable (${tee.err})`);
    parts.push(images.ok ? `allowed images ${images.v}` : `allowed images unavailable (${images.err})`);
    let status: Status = 'PASS';
    if (mpcState.status !== 'Running') {
      status = 'WARN';
      parts.unshift(`MPC state is ${mpcState.status}, not Running`);
    }
    if (!tee.ok || !images.ok) status = 'WARN';
    add(2, 'mpc-network', status, parts.join(' · '));
  }

  // #3 code-hash
  const localHash = ctx.wasm.bytes ? codeHashB58(ctx.wasm.bytes) : null;
  if (!localHash) add(3, 'code-hash', 'WARN', `local wasm not found: ${ctx.wasm.path} (pass --wasm <file>)`, acct);
  else if (localHash === account.code_hash) add(3, 'code-hash', 'PASS', `${account.code_hash} = sha256(${ctx.wasm.path})`, acct);
  else add(3, 'code-hash', 'FAIL', `on chain ${account.code_hash} ≠ sha256(${ctx.wasm.path}) ${localHash}`, acct);

  // #4 no-access-keys
  if (keys.keys.length === 0) add(4, 'no-access-keys', 'PASS', `${net.contract} has no access keys: nobody can sign for it or redeploy it`, acct);
  else add(4, 'no-access-keys', 'FAIL', `${keys.keys.length} access key(s): ${keys.keys.map((k) => k.public_key).join(', ')}`, acct);

  // #5 wasm-imports
  if (!ctx.wasm.bytes) add(5, 'wasm-imports', 'WARN', `local wasm not found: ${ctx.wasm.path}`);
  else {
    const imports = wasmImports(ctx.wasm.bytes);
    const bad = imports.filter((i) => i.module === 'env' && FORBIDDEN_IMPORT_RE.test(i.name)).map((i) => i.name);
    if (bad.length) add(5, 'wasm-imports', 'FAIL', `forbidden host functions imported: ${bad.join(', ')}`);
    else add(5, 'wasm-imports', 'PASS', `${imports.length} imports, none can add a key, deploy code or delete the account`);
  }

  // #6 reproducible-build
  {
    const snap = meta.ok ? meta.v.build_info?.source_code_snapshot : undefined;
    const src = meta.ok ? (snap ? `source ${snap}` : 'contract_source_metadata has no source_code_snapshot') : `contract_source_metadata unavailable (${meta.err})`;
    if (!ctx.rebuild) add(6, 'reproducible-build', 'WARN', `rebuild not performed; run with --rebuild (Docker + cargo-near 0.23.0) · ${src}`);
    else if (!meta.ok || !snap) add(6, 'reproducible-build', 'WARN', `cannot rebuild: ${src}`);
    else {
      const r = await ctx.rebuild(meta.v);
      if (r.kind === 'unavailable') add(6, 'reproducible-build', 'WARN', `rebuild not performed: ${r.reason}`);
      else if (r.codeHash === account.code_hash) add(6, 'reproducible-build', 'PASS', `Docker rebuild of ${r.rev.slice(0, 12)} → ${r.codeHash} = on-chain code_hash`);
      else add(6, 'reproducible-build', 'FAIL', `Docker rebuild of ${r.rev.slice(0, 12)} → ${r.codeHash} ≠ on-chain ${account.code_hash}`);
    }
  }

  // #7 init-before-sale
  if (big(config.init_block) < big(sale.created_block) && big(config.init_ns) < big(sale.created_ns)) {
    add(7, 'init-before-sale', 'PASS', `init block ${config.init_block} (${utcFromNs(config.init_ns)}) < sale created block ${sale.created_block} (${utcFromNs(sale.created_ns)})`);
  } else {
    add(7, 'init-before-sale', 'FAIL', `init block ${config.init_block} / ns ${config.init_ns} not before sale created block ${sale.created_block} / ns ${sale.created_ns}`);
  }

  // #8 sale-identity (P-3: the app_id account is the contract, the MPC's caller)
  const id = appId(net.contract, sale.path);
  if (sale.id === saleId.toString() && new RegExp(`^tender/${saleId}/[0-9a-f]{32}$`).test(sale.path)) {
    add(8, 'sale-identity', 'PASS', `path ${sale.path} · app_id(${net.contract}, path) = ${bytesToHex(id)}`);
  } else {
    add(8, 'sale-identity', 'FAIL', `sale id ${sale.id}, path "${sale.path}" does not match tender/${saleId}/<32 hex>`);
  }

  // #9 bid-count
  {
    const bad: string[] = [];
    if (bids.length !== sale.bids) bad.push(`get_bids returned ${bids.length}, sale.bids = ${sale.bids}`);
    if (sale.bids > sale.max_bids) bad.push(`bids ${sale.bids} > max_bids ${sale.max_bids}`);
    if (bids.some((b, i) => b.idx !== i)) bad.push('bid idx not 0..n-1');
    const distinct = new Set(bids.map((b) => b.bidder)).size;
    if (distinct !== sale.bidders) bad.push(`distinct bidders ${distinct} ≠ sale.bidders ${sale.bidders}`);
    const escrow = sum(bids.map((b) => big(b.escrow)));
    if (escrow !== big(sale.escrow_total)) bad.push(`Σ escrow ${escrow} ≠ escrow_total ${sale.escrow_total}`);
    if (bad.length) add(9, 'bid-count', 'FAIL', bad.join('; '));
    else add(9, 'bid-count', 'PASS', `${sale.bids} bids (max ${sale.max_bids}) from ${sale.bidders} bidders · escrow ${formatUsdc(escrow)} USDC`);
  }

  // #10-#14 need the key (#10 also checks the other time rules: bids before close, request after close, deadline, cancel)
  const key = sale.key;
  const closeNs = big(sale.close_ns);
  const timing: string[] = [];
  const lateBids = bids.filter((b) => big(b.ns) >= closeNs).map((b) => `#${b.idx}`);
  if (lateBids.length) timing.push(`bid${lateBids.length === 1 ? '' : 's'} ${lateBids.join(', ')} stored at or after close`);
  const okReq = keyLog.find((k) => k.sale === sale.id && k.outcome === 'Ok');
  if (okReq && big(okReq.ns) < closeNs) timing.push(`key request #${okReq.i} at ${utcFromNs(okReq.ns)} before close`);
  if (key) {
    const want = big(key.ns) + (big(sale.reveal_secs) > MIN_REVEAL_SECS ? big(sale.reveal_secs) : MIN_REVEAL_SECS) * NS;
    if (sale.reveal_deadline_ns === null || big(sale.reveal_deadline_ns) !== want) timing.push(`reveal_deadline_ns ${sale.reveal_deadline_ns} ≠ key ns + max(reveal_secs, 86400) s = ${want}`);
  }
  const cancelAt = sale.state === 'Cancelled' && result ? big(result.ns) : null;
  const cancelMin = sale.key_requests === 0 ? closeNs : closeNs + MIN_REVEAL_SECS * NS; // rule (a) needs 0 requests, else (b)
  if (cancelAt !== null && cancelAt < cancelMin) timing.push(`cancelled at ${utcFromNs(cancelAt)} before ${sale.key_requests === 0 ? 'close' : 'close + 24 h'}`);
  const timingText = `bids before close${okReq ? ', key requested after close' : ''}${key ? ', reveal deadline = key + max(reveal_secs, 24 h)' : ''}`;
  let S: G1Point | null = null;
  let dec: DecryptedBid[] = [];
  const good = new Set<number>(); // decrypted and the commitment matches
  const revealable = new Set<number>(); // good and 1 ≤ q ≤ B: the contract's reveal rule
  if (!key) {
    if (timing.length) add(10, 'key-after-close', 'FAIL', `no key; ${timing.join('; ')}`);
    else if (cancelAt !== null) add(10, 'key-after-close', 'PASS', `no key; ${timingText}; cancelled at ${utcFromNs(cancelAt)} ≥ ${sale.key_requests === 0 ? 'close' : 'close + 24 h'}`);
    else add(10, 'key-after-close', 'n/a', `no key (state ${sale.state}, ${sale.key_requests} key request${sale.key_requests === 1 ? '' : 's'})`);
    for (const [n, name] of [
      [11, 'key-pairing'],
      [12, 'ciphertexts-decrypt'],
      [13, 'plaintext-matches-commitment'],
      [14, 'reveal-states'],
    ] as const) {
      add(n, name, 'n/a', `no key (state ${sale.state}, ${sale.key_requests} key request${sale.key_requests === 1 ? '' : 's'})`);
    }
  } else {
    const keyLink = blockUrl(net.network, key.block);
    // #10
    if (!(big(key.ns) >= closeNs && big(key.block) > big(sale.created_block))) {
      timing.unshift(`key ns ${key.ns} / block ${key.block} vs close_ns ${sale.close_ns} / created block ${sale.created_block}`);
    }
    if (!timing.length) {
      add(10, 'key-after-close', 'PASS', `key at ${utcFromNs(key.ns)} (block ${key.block}) ≥ close ${utcFromNs(sale.close_ns)} · ${timingText}`, keyLink);
    } else {
      add(10, 'key-after-close', 'FAIL', timing.join('; '), keyLink);
    }
    // #11
    let keyErr = '';
    try {
      S = keyFromCkd(key, config.app_pk_mode);
    } catch (e) {
      keyErr = (e as Error).message;
    }
    const keyOk = S !== null && checkKey(S, config.mpc_public_key, id);
    const plain = config.app_pk_mode === 'plain' ? ' (off-chain pairing; no on-chain PV in plain mode)' : '';
    if (keyOk) add(11, 'key-pairing', 'PASS', `checkKey true: e(S, G2) = e(H(pk ‖ app_id), mpk), mode ${config.app_pk_mode}${plain}`, keyLink);
    else add(11, 'key-pairing', 'FAIL', keyErr ? `key does not parse: ${keyErr}` : `checkKey false for app_id(${net.contract}, ${sale.path}), mode ${config.app_pk_mode}`, keyLink);

    // #12
    dec = S
      ? decryptBids({ S, contract: net.contract, path: sale.path, sale: saleId, bids: bids.map((b) => ({ idx: b.idx, bidder: b.bidder, B: big(b.escrow), ct: b.ct, cm: b.cm })) })
      : bids.map((b) => ({ idx: b.idx, ok: false, reason: 'no valid key' }));
    const okN = dec.filter((d) => d.ok).length;
    const failed = dec.filter((d) => !d.ok);
    // A Revealed bid whose ciphertext does not open was revealed from its opening (p, q, salt) alone. The protocol
    // allows that, so it is a WARN, not a FAIL: the bidder may have sealed garbage and revealed after seeing the key.
    const revealedUndecryptable = failed.filter((d) => bids[d.idx]!.state === 'Revealed').map((d) => `#${d.idx}`);
    const failText = failed.map((d) => `#${d.idx} ${d.reason}`).join(', ');
    if (revealedUndecryptable.length) {
      add(12, 'ciphertexts-decrypt', 'WARN', `${okN}/${bids.length} decrypt; Revealed but not decryptable: ${revealedUndecryptable.join(', ')} (revealed from the opening alone, possibly after the key) · ${failText}`);
    } else {
      add(12, 'ciphertexts-decrypt', 'PASS', `${okN}/${bids.length} decrypt${failed.length ? ` · cannot decrypt: ${failText}` : ''}`);
    }

    // #13
    const opened = dec.filter((d) => d.ok);
    for (const d of opened) if (d.cmOk) good.add(d.idx);
    for (const d of opened) if (d.revealable) revealable.add(d.idx);
    const mism = opened.filter((d) => !d.cmOk).map((d) => `#${d.idx}`);
    const differs = opened.filter((d) => {
      const b = bids[d.idx]!;
      return d.cmOk && b.state === 'Revealed' && (big(b.p) !== d.p || big(b.q) !== d.q || (b.salt !== null && b.salt !== d.salt_hex));
    });
    const mismText = mism.length ? ` · commitment mismatch (e.g. a copied ct + cm): ${mism.join(', ')}` : '';
    if (differs.length) add(13, 'plaintext-matches-commitment', 'FAIL', `revealed p/q/salt differ from the decrypted plaintext: ${differs.map((d) => `#${d.idx}`).join(', ')}`);
    else add(13, 'plaintext-matches-commitment', 'PASS', `${good.size}/${opened.length} match${mismText}`);

    // #14 "revealable" = decrypts, matches its commitment and 1 ≤ q ≤ B, the contract's reveal rule (q = 0 or q > B
    // can never be revealed, so Penalized is correct for it)
    const bad: string[] = [];
    const warn: string[] = [];
    const sealedGood: number[] = [];
    const outOfRange: string[] = [];
    for (const b of bids) {
      const r = revealable.has(b.idx);
      if (r && b.state === 'Penalized') bad.push(`#${b.idx} decrypts and matches its commitment but is Penalized`);
      if (r && b.state === 'Sealed') sealedGood.push(b.idx);
      if (good.has(b.idx) && !r) outOfRange.push(`#${b.idx}`);
      if (!good.has(b.idx) && b.state === 'Revealed') {
        const by = b.revealed_by === b.bidder ? 'by its own bidder' : `by ${b.revealed_by}`;
        warn.push(`#${b.idx} Revealed ${by}, but its ciphertext does not open to the revealed bid (could reveal after the key)`);
      }
    }
    const windowOpen = !finalized && sale.reveal_deadline_ns !== null && now < big(sale.reveal_deadline_ns);
    if (sealedGood.length && !windowOpen) bad.push(`${sealedGood.map((i) => `#${i}`).join(', ')} decrypt and match but were never revealed`);
    if (sealedGood.length && windowOpen) warn.unshift(`reveal window open until ${utcFromNs(sale.reveal_deadline_ns!)}: ${sealedGood.length} decryptable bid(s) still Sealed`);
    const counts = (['Revealed', 'Penalized', 'Sealed'] as const).map((s) => `${bids.filter((b) => b.state === s).length} ${s}`).join(', ');
    const oor = outOfRange.length ? ` · q outside 1..B, not revealable: ${outOfRange.join(', ')}` : '';
    if (bad.length) add(14, 'reveal-states', 'FAIL', bad.join('; '));
    else if (warn.length) add(14, 'reveal-states', 'WARN', `${warn.join('; ')} · ${counts}${oor}`);
    else add(14, 'reveal-states', 'PASS', `${counts}; every revealable bid (decrypts, matches its commitment, 1 ≤ q ≤ B) is Revealed${oor}`);
  }

  // #15-#18 recompute the clearing (Finalized only)
  let rc: ClearResult | null = null;
  const finalizeRow = ctx.evidence.rows ? evidenceRows(ctx.evidence.rows, net, saleId).find((r) => r.step === 'finalize') : undefined;
  const finLink = finalizeRow ? txUrl(net.network, finalizeRow.tx_hash) : undefined;
  const scale = 10n ** BigInt(sale.decimals + sale.lot_exp);
  if (!finalized || !result) {
    for (const [n, name] of [
      [15, 'clearing-price'],
      [16, 'allocations'],
    ] as const) {
      add(n, name, 'n/a', `state ${sale.state}: no clearing`);
    }
  } else {
    rc = clear(
      { S: big(sale.supply), decimals: sale.decimals, lot_exp: sale.lot_exp, reserve: big(sale.reserve) },
      bids.map((b) =>
        b.state === 'Revealed'
          ? { idx: b.idx, B: big(b.escrow), p: big(b.p), q: big(b.q), state: 'Revealed' as BidState }
          : { idx: b.idx, B: big(b.escrow), p: null, q: null, state: 'Sealed' as BidState },
      ),
    );
    const chainP = result.p_star === null ? null : big(result.p_star);
    const pText = (p: bigint | null) => (p === null ? 'nothing cleared' : `P* = ${formatUsdc(p)} ${unit}`);
    if (chainP === rc.P_star) add(15, 'clearing-price', 'PASS', `${pText(chainP)} (recomputed = get_result)`, finLink);
    else add(15, 'clearing-price', 'FAIL', `get_result ${pText(chainP)}, recomputed ${pText(rc.P_star)}`, finLink);

    // #16
    const diffs: string[] = [];
    const cmp = (what: string, chain: string | bigint | null, want: string | bigint | null) => {
      if (String(chain) !== String(want)) diffs.push(`${what} chain ${chain} ≠ ${want}`);
    };
    for (const b of bids) {
      const i = b.idx;
      cmp(`#${i} alloc`, b.alloc, rc.alloc[i]!);
      cmp(`#${i} spend`, b.spend, rc.spend[i]!);
      cmp(`#${i} penalty`, b.penalty, rc.penalty[i]!);
      cmp(`#${i} penalty_share`, b.penalty_share, rc.penalty_share[i]!);
      cmp(`#${i} state`, b.state, rc.final_state[i]!);
      cmp(`#${i} paid.tokens`, b.paid.tokens, rc.alloc[i]!);
      cmp(`#${i} paid.usdc`, b.paid.usdc, rc.refund[i]!);
    }
    cmp('sold', result.sold, sum(rc.alloc));
    cmp('seller_usdc', result.seller_usdc, rc.seller_usdc);
    cmp('seller_tokens_back', result.seller_tokens_back, rc.seller_tokens_back);
    cmp('token_dust', result.token_dust, rc.dust);
    cmp('penalty_pool', result.penalty_pool, sum(rc.penalty));
    cmp('seller_payout.usdc', sale.seller_payout.usdc, rc.seller_usdc);
    cmp('seller_payout.tokens', sale.seller_payout.tokens, rc.seller_tokens_back);
    if (diffs.length) add(16, 'allocations', 'FAIL', `${diffs.length} difference(s): ${diffs.slice(0, 6).join('; ')}${diffs.length > 6 ? '; …' : ''}`);
    else {
      const winners = rc.alloc.filter((a) => a > 0n).length;
      add(16, 'allocations', 'PASS', `${bids.length} bids: alloc, spend, refund, penalty and penalty share = recomputed (${winners} winner${winners === 1 ? '' : 's'}) · seller ${formatUsdc(rc.seller_usdc)} USDC`);
    }
  }

  // #17 conservation (chain values only)
  if (!settled(sale) || !result) add(17, 'conservation', 'n/a', `state ${sale.state}: nothing paid out yet`);
  else {
    const bad: string[] = [];
    const B = sum(bids.map((b) => big(b.escrow)));
    // The penalty pool is paid to nobody: it stays in the contract's Intents account (CRYPTO-01).
    const pool = sum(bids.map((b) => big(b.penalty)));
    const usdcOut = sum(bids.map((b) => big(b.paid.usdc))) + big(sale.seller_payout.usdc);
    const tokOut = sum(bids.map((b) => big(b.paid.tokens))) + big(sale.seller_payout.tokens);
    if (usdcOut + pool !== B) bad.push(`USDC: Σ refunds + seller ${usdcOut} + penalty pool ${pool} ≠ Σ escrow ${B}`);
    if (tokOut !== big(sale.supply)) bad.push(`tokens: Σ allocations + seller ${tokOut} ≠ supply ${sale.supply}`);
    if (big(result.sold) + big(result.seller_tokens_back) !== big(sale.supply)) bad.push(`sold + seller_tokens_back ≠ supply`);
    const spend = sum(bids.map((b) => big(b.spend)));
    if (big(result.seller_usdc) !== spend) bad.push(`seller_usdc ${result.seller_usdc} ≠ Σ spend ${spend} (the penalty pool never goes to the seller)`);
    const shared = sum(bids.map((b) => big(b.penalty_share)));
    if (shared !== 0n) bad.push(`Σ penalty share ${shared} ≠ 0 (the pool must go to nobody)`);
    if (big(result.penalty_pool) !== pool) bad.push(`penalty_pool ${result.penalty_pool} ≠ Σ penalty ${pool}`);
    // The contract refunds a bid from the seller account (SC-01); a sub-account of the seller can still bid (SC-03).
    for (const b of bids) if (b.bidder === sale.seller) bad.push(`bid #${b.idx} comes from the seller account ${sale.seller} (the contract refunds those as seller_bid)`);
    const subs = bids.filter((b) => b.bidder.endsWith(`.${sale.seller}`)).map((b) => `#${b.idx} ${b.bidder}`);
    const subText = subs.length ? ` · bids from sub-accounts of the seller ${sale.seller} (only it can create them): ${subs.join(', ')}` : '';
    if (bad.length) add(17, 'conservation', 'FAIL', bad.join('; '));
    else add(17, 'conservation', 'PASS', `USDC in ${formatUsdc(B)} = refunds + seller ${formatUsdc(big(sale.seller_payout.usdc))} + penalty pool ${formatUsdc(pool)}; tokens in = out; the pool is kept by the contract (paid to nobody), 0 to the seller${subText}`);
  }

  // #18 uniform-price
  if (!finalized || !result) add(18, 'uniform-price', 'n/a', `state ${sale.state}: no clearing`);
  else {
    const P = result.p_star === null ? null : big(result.p_star);
    const bad: string[] = [];
    if (P !== null && P < big(sale.reserve)) bad.push(`P* ${P} below reserve ${sale.reserve}`);
    for (const b of bids) {
      const alloc = big(b.alloc);
      const spend = big(b.spend);
      if (b.state !== 'Revealed' || P === null || big(b.p) < P) {
        if (alloc !== 0n || spend !== 0n) bad.push(`#${b.idx} gets ${alloc} tokens / pays ${spend} without a winning revealed price`);
        continue;
      }
      const p = big(b.p);
      const q = big(b.q);
      if (p === P && alloc === 0n && spend === 0n) continue; // a marginal bid can get nothing when the supply runs out
      const full = spend === q && alloc === (q * scale) / P;
      const marginal = p === P && spend === (alloc * P + scale - 1n) / scale && spend <= q;
      if (!full && !marginal) bad.push(`#${b.idx} p ${p} q ${q}: alloc ${alloc} spend ${spend} is neither full at P* nor marginal at P*`);
    }
    if (bad.length) add(18, 'uniform-price', 'FAIL', bad.join('; '));
    else add(18, 'uniform-price', 'PASS', P === null ? 'nothing cleared: no winner, no spend' : `every winner pays one price ${formatUsdc(P)} ${unit} ≤ its bid; full winners pay q, marginal ones ceil(alloc·P*/scale); losers get 0`);
  }

  // #19 escrow-balance: Tender's Intents balances vs what it still owes plus the penalty pools it keeps, over every
  // sale of the contract. A payout in flight (pending: sent, on_paid not run yet) may already have left: not owed.
  {
    const owed = new Map<string, bigint>();
    const owe = (t: string, v: bigint) => owed.set(t, (owed.get(t) ?? 0n) + v);
    let kept = 0n;
    let inFlight = 0;
    const due = (p: PaidView) => {
      if (p.ok) return false;
      if (p.pending) inFlight++;
      return !p.pending;
    };
    await Promise.all(
      sales.map(async (s) => {
        owe(s.quote_token, 0n);
        owe(s.token, 0n);
        if (!settled(s)) {
          owe(s.quote_token, big(s.escrow_total));
          owe(s.token, big(s.supply));
          return;
        }
        if (s.state === 'Finalized') {
          const r = s.id === sale.id ? result : await views.result(BigInt(s.id), at);
          const pool = big(r?.penalty_pool);
          owe(s.quote_token, pool);
          kept += pool;
        }
        if (due(s.seller_payout)) {
          owe(s.quote_token, big(s.seller_payout.usdc));
          owe(s.token, big(s.seller_payout.tokens));
        }
        if (s.payouts_done === s.payouts_total) return;
        const bs: BidView[] = s.id === sale.id ? bids : await views.bids(BigInt(s.id), at);
        for (const b of bs) {
          if (!due(b.paid)) continue;
          owe(s.quote_token, big(b.paid.usdc));
          owe(s.token, big(b.paid.tokens));
        }
      }),
    );
    const tokens = [...owed.keys()];
    const have = await new IntentsViews(rpc, config.intents).mtBatchBalanceOf(net.contract, tokens, at);
    const parts: string[] = [];
    const deficits: string[] = [];
    tokens.forEach((t, i) => {
      const h = have[i]!;
      const o = owed.get(t)!;
      const surplus = h > o ? ` (surplus ${h - o}: unsolicited transfers)` : '';
      parts.push(`${t} ${h} ≥ owed ${o}${surplus}`);
      if (h < o) deficits.push(`${t} holds ${h} < owed ${o}`);
    });
    const notes = `${kept > 0n ? ` · owed includes ${formatUsdc(kept)} USDC of penalty pools kept by the contract` : ''}${inFlight ? ` · ${inFlight} payout(s) in flight, not counted` : ''}`;
    if (deficits.length) add(19, 'escrow-balance', 'FAIL', `deficit: ${deficits.join('; ')}${notes}`, acct);
    else add(19, 'escrow-balance', 'PASS', `${sales.length} sale(s): ${parts.join(' · ')}${notes}`, acct);
  }

  // #20 payouts
  if (!settled(sale)) add(20, 'payouts', 'n/a', `state ${sale.state}: no payouts yet`);
  else {
    const items = [...bids.map((b) => ({ name: `#${b.idx}`, p: b.paid })), { name: 'seller', p: sale.seller_payout }];
    const unpaid = items.filter((x) => !x.p.ok && !x.p.pending).map((x) => x.name);
    const sent = items.filter((x) => !x.p.ok && x.p.pending).map((x) => x.name);
    if (unpaid.length || (!sent.length && sale.payouts_done !== sale.payouts_total)) {
      add(20, 'payouts', 'FAIL', `payouts pending ${sale.payouts_done}/${sale.payouts_total}: call finalize again (unpaid: ${unpaid.join(', ') || 'none listed'})`);
    } else if (sent.length) add(20, 'payouts', 'WARN', `${sale.payouts_done}/${sale.payouts_total} payouts ok; in flight (sent, callback not run yet): ${sent.join(', ')}; run again in a minute`);
    else add(20, 'payouts', 'PASS', `${sale.payouts_done}/${sale.payouts_total} payouts ok (bids + seller)`);
  }

  // #21 key-ledger
  {
    const mine = keyLog.filter((k) => k.sale === sale.id);
    const ok = mine.filter((k) => k.outcome === 'Ok');
    const bad: string[] = [];
    if (keyLog.length !== Number(config.key_log_len)) bad.push(`key log has ${keyLog.length} entries, key_log_len ${config.key_log_len}`);
    if (keyLog.some((k, i) => k.i !== String(i))) bad.push('key log index not 0..n-1');
    if (mine.length !== sale.key_requests) bad.push(`${mine.length} ledger entries for this sale ≠ key_requests ${sale.key_requests}`);
    if (ok.length > 1) bad.push(`${ok.length} Ok entries`);
    if (key && ok.length === 0) bad.push('a key is stored but no Ok entry exists');
    if (!key && ok.length > 0) bad.push('an Ok entry exists but no key is stored');
    if (key && ok.length === 1 && (ok[0]!.resolved_block !== key.block || big(key.ns) < big(ok[0]!.ns))) {
      bad.push(`Ok entry #${ok[0]!.i} (block ${ok[0]!.block}, resolved ${ok[0]!.resolved_block}) does not match the key at block ${key.block}`);
    }
    const pending = mine.filter((k) => k.outcome === 'Pending');
    if (pending.length !== (sale.in_flight ? 1 : 0)) bad.push(`${pending.length} Pending entries, in_flight ${sale.in_flight}`);
    const dead = pending.filter((k) => now >= big(k.ns) + IN_FLIGHT_TIMEOUT_SECS * NS);
    if (sale.in_flight && dead.length) {
      bad.push(`request #${dead[0]!.i} in flight since ${utcFromNs(dead[0]!.ns)} (≥ 1 h) is dead (its on_key failed): call open again, or cancel after close + 24 h`);
    }
    const seq = mine.map((k) => k.outcome).join(', ') || 'none';
    if (bad.length) add(21, 'key-ledger', 'FAIL', bad.join('; '));
    else add(21, 'key-ledger', 'PASS', `${mine.length} request${mine.length === 1 ? '' : 's'} for this sale (${seq}) = key_requests; ${keyLog.length} in the contract's key log`);
  }

  // #22 nearblocks-receipts (independent indexer, WARN only)
  {
    const nb = await fetchKeyReceipts({
      base: net.nearblocks,
      account: net.contract,
      mpc: config.mpc,
      ...(net.nearblocksApiKey ? { apiKey: net.nearblocksApiKey } : {}),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    if (!nb.ok) add(22, 'nearblocks-receipts', 'WARN', `${nb.warn} (the key ledger in contract state is the record)`);
    else if (nb.truncated) add(22, 'nearblocks-receipts', 'WARN', `NearBlocks shows ≥ ${nb.count} request receipts (more pages), key log ${keyLog.length}`);
    else if (nb.count !== keyLog.length) add(22, 'nearblocks-receipts', 'WARN', `NearBlocks shows ${nb.count} request receipts, key log ${keyLog.length} (indexing lag? run again in 10 min)`);
    else add(22, 'nearblocks-receipts', 'PASS', `NearBlocks: ${nb.count} ${net.contract} → ${config.mpc}.request_app_private_key receipts = key log ${keyLog.length}`);
  }

  // #23 cancelled-sealed
  if (sale.state !== 'Cancelled') add(23, 'cancelled-sealed', 'n/a', `state ${sale.state}`);
  else if (sale.key_requests === 0) add(23, 'cancelled-sealed', 'PASS', CANCELLED_NEVER);
  else add(23, 'cancelled-sealed', 'WARN', `cancelled after ${sale.key_requests} requests: may be decryptable`);

  // #24, #25 evidence file (WARN only)
  const rows = ctx.evidence.rows ? evidenceRows(ctx.evidence.rows, net, saleId) : null;
  const noRows = rows === null ? `no evidence file (${ctx.evidence.path})` : `no rows for this sale in ${ctx.evidence.path}`;
  const deposits = rows?.filter((r) => r.deposit_address) ?? [];
  if (net.network !== 'mainnet') add(24, 'oneclick-status', 'n/a', `1Click runs on mainnet only`);
  else if (!deposits.length) add(24, 'oneclick-status', 'n/a', rows === null ? noRows : 'no 1Click deposits recorded for this sale');
  else {
    const st = await Promise.all(deposits.map((r) => fetchStatus(r.deposit_address!, ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {})));
    const notOk = st.map((s, i) => ('status' in s && s.status === 'SUCCESS' ? null : `${short(deposits[i]!.deposit_address!)}: ${'status' in s ? s.status : s.warn}`)).filter(Boolean);
    if (notOk.length) add(24, 'oneclick-status', 'WARN', `${deposits.length - notOk.length}/${deposits.length} SUCCESS; ${notOk.join('; ')}`);
    else add(24, 'oneclick-status', 'PASS', `${deposits.length}/${deposits.length} 1Click deposits SUCCESS`);
  }
  if (!rows?.length) add(25, 'archival-tx', 'n/a', noRows);
  else {
    const res = await Promise.all(
      rows.map(async (r) => {
        const sender = r.signer_id ?? net.contract;
        let got = await attempt(() => rpc.txStatus(r.tx_hash, sender));
        if (!got.ok) got = await attempt(() => ctx.archival.txStatus(r.tx_hash, sender));
        if (!got.ok) return `${r.step} ${short(r.tx_hash)}: ${got.err}`;
        const want = r.expected ?? 'success';
        const o = txOutcome(got.v);
        return o === want ? null : `${r.step} ${short(r.tx_hash)}: ${o}, expected ${want}`;
      }),
    );
    const bad = res.filter(Boolean);
    if (bad.length) add(25, 'archival-tx', 'WARN', `${rows.length - bad.length}/${rows.length} found with the recorded outcome; ${bad.join('; ')}`);
    else add(25, 'archival-tx', 'PASS', `${rows.length}/${rows.length} recorded transactions found with the recorded outcome`);
  }

  // #26 upstream-code: intents.near and the MPC still run the code the tests ran against (WARN only, X12-10)
  {
    const intents = await attempt(() => rpc.viewAccount(config.intents, at));
    const drift: string[] = [];
    if (!intents.ok) drift.push(`${config.intents} code_hash unavailable (${intents.err})`);
    else if (intents.v.code_hash !== TESTED_INTENTS_CODE_HASH) drift.push(`${config.intents} code_hash ${intents.v.code_hash} ≠ tested ${TESTED_INTENTS_CODE_HASH} (upgraded since the tests ran)`);
    if (mpcVersion !== TESTED_MPC_VERSION) drift.push(`${config.mpc} ${mpcVersion} ≠ tested ${TESTED_MPC_VERSION}`);
    if (drift.length) add(26, 'upstream-code', 'WARN', drift.join('; '));
    else add(26, 'upstream-code', 'PASS', `${config.intents} code_hash ${TESTED_INTENTS_CODE_HASH} = the tested intents 0.4.5 wasm · ${config.mpc} ${mpcVersion} = tested version`);
  }

  // #27 token-decimals: the seller declares the sale's decimals at create and the contract cannot read ft_metadata
  // (X12-03); the quote token is USDC with 6 decimals
  {
    const ftDecimals = async (token: string): Promise<number> => {
      if (!token.startsWith('nep141:')) throw new Error(`${token} is not a nep141 token`);
      return (await rpc.view<{ decimals: number }>(token.slice('nep141:'.length), 'ft_metadata', {}, at)).decimals;
    };
    const [sd, qd] = await Promise.all([attempt(() => ftDecimals(sale.token)), attempt(() => ftDecimals(sale.quote_token))]);
    const tok = sale.token.replace(/^nep141:/, '');
    const quote = short(sale.quote_token.replace(/^nep141:/, ''));
    const bad: string[] = [];
    const notes: string[] = [];
    if (!sd.ok) notes.push(`${tok} ft_metadata unavailable (${sd.err}); sale decimals ${sale.decimals} unchecked`);
    else if (sd.v !== sale.decimals) bad.push(`${tok} ft_metadata ${sd.v} decimals ≠ sale decimals ${sale.decimals} (prices and amounts are scaled wrong)`);
    else notes.push(`${tok} ${sd.v} decimals = sale decimals ${sale.decimals}`);
    if (!qd.ok) notes.push(`quote token ${quote} ft_metadata unavailable (${qd.err})`);
    else if (qd.v !== 6) bad.push(`quote token ${quote} ft_metadata ${qd.v} decimals ≠ 6`);
    else notes.push('quote token 6 decimals');
    if (bad.length) add(27, 'token-decimals', 'FAIL', bad.join('; '));
    else if (!sd.ok || !qd.ok) add(27, 'token-decimals', 'WARN', notes.join(' · '));
    else add(27, 'token-decimals', 'PASS', `ft_metadata: ${notes.join(' · ')}`);
  }

  return checks.sort((a, b) => a.n - b.n);
}
