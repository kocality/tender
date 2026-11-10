// Test and demo only. A simulated MPC (the public near/mpc test vectors; their msk is published) and a consistent
// fake sale world served by a fake JSON-RPC, so demo:local, seal:try, seal:bid and verify run without a network.
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { type BidState, clear, fromFixture } from '@tender/clearing';
import {
  type AppPkMode,
  type CkdResponse,
  type G1Point,
  appId,
  keyFromCkd,
  sealBid,
  simulateCkdKey,
  simulateCkdResponse,
} from '@tender/seal';
import bs58 from 'bs58';
import { type Network, TESTED_INTENTS_CODE_HASH } from './config.js';
import { demoSaleFixturePath, fixturePath } from './paths.js';
import type { BidView, ConfigView, KeyReqView, ResultView, SaleState, SaleView } from './views.js';

interface Vector {
  msk: string;
  pk: string;
}

const te = new TextEncoder();
const hashHex = (s: string, n: number) => bytesToHex(sha256(te.encode(s))).slice(0, n);

export interface SimMpc {
  mpk: string;
  mskHex: string;
  S: G1Point;
  response: CkdResponse;
}

/** CKD for app_id(contract, path) from vector `vectorIndex`'s msk, shaped as the MPC returns it in `mode`. */
export function simulateMpc({
  vectorIndex = 0,
  contract,
  path,
  mode,
  y,
}: {
  vectorIndex?: number;
  contract: string;
  path: string;
  mode: AppPkMode;
  y?: bigint;
}): SimMpc {
  const v = (JSON.parse(readFileSync(fixturePath('ckd_test_vectors.json'), 'utf8')) as { vectors: Vector[] }).vectors[vectorIndex];
  if (!v) throw new Error(`no test vector ${vectorIndex}`);
  const mpk = 'bls12381g2:' + bs58.encode(hexToBytes(v.pk));
  const id = appId(contract, path);
  return { mpk, mskHex: v.msk, S: simulateCkdKey(v.msk, mpk, id), response: simulateCkdResponse(v.msk, mpk, id, mode, y) };
}

/** The six demo bidders (M12): deterministic fake identities, lowercase as the contract expects. */
export const DEMO_BIDDERS: { label: string; origin: 'base' | 'arb' | 'sol' | 'near'; bidder: string }[] = [
  { label: 'base · EVM-1', origin: 'base', bidder: '0x' + hashHex('tender-demo-EVM-1', 40) },
  { label: 'sol · SOL-1', origin: 'sol', bidder: hashHex('tender-demo-SOL-1', 64) },
  { label: 'arb · EVM-2', origin: 'arb', bidder: '0x' + hashHex('tender-demo-EVM-2', 40) },
  { label: 'near · bidder.tenderseal.near', origin: 'near', bidder: 'bidder.tenderseal.near' },
  { label: 'sol · SOL-2', origin: 'sol', bidder: hashHex('tender-demo-SOL-2', 64) },
  { label: 'base · EVM-3', origin: 'base', bidder: '0x' + hashHex('tender-demo-EVM-3', 40) },
];

export interface WorldBid {
  bidder: string;
  origin: string | null;
  B: bigint;
  p: bigint;
  q: bigint;
  /** Revealed before finalize (Keyed/Finalized worlds). Default true. */
  revealed?: boolean;
}

export interface WorldOptions {
  mode?: AppPkMode;
  network?: Network;
  contract?: string;
  saleId?: bigint;
  state?: 'Open' | 'Keyed' | 'Finalized' | 'Cancelled';
  bids?: WorldBid[];
  sale?: { supply?: bigint; decimals?: number; lot_exp?: number; reserve?: bigint; token?: string };
  nowNs?: bigint;
  /** Hex seed for deterministic salts. */
  seed?: string;
}

export interface World {
  network: Network;
  contract: string;
  mpc: string;
  intents: string;
  mode: AppPkMode;
  mpk: string;
  S: G1Point;
  config: ConfigView;
  sale: SaleView;
  bids: BidView[];
  result: ResultView | null;
  keyLog: KeyReqView[];
  secrets: { idx: number; p: bigint; q: bigint; salt_hex: string }[];
  block: { height: bigint; timestamp_ns: bigint; hash: string };
  mpcVersion: string;
  mpcThreshold: number;
  mpcParticipants: number;
  /** state.Running.keyset.epoch_id and parameters.participants.next_id (mainnet 2026-11-11: 16 and 22). */
  mpcEpoch: number;
  mpcNextId: number;
  currentSalt: string;
  /** view_account(contract).code_hash. */
  codeHash: string;
  /** view_account(intents).code_hash. */
  intentsCodeHash: string;
  /** ft_metadata().decimals by token account (an account missing here does not exist). */
  tokenDecimals: Record<string, number>;
  /** Public keys on the contract account (view_access_key_list). */
  accessKeys: string[];
  /** Tender's Intents balances by token id (missing = 0). */
  balances: Record<string, bigint>;
  teeAccounts: number;
  allowedImages: number;
  /** contract_source_metadata; null = the view is missing. */
  sourceMetadata: object | null;
  /** Further sales of the same contract (verify --keys, #19). */
  more: { sale: SaleView; bids: BidView[]; result: ResultView | null }[];
}

export const SIM_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const NS = 1_000_000_000n;

/** demo-sale-1 inputs (bids in idx order) with the demo bidder identities. */
export function demoSaleInputs(): { sale: { supply: bigint; decimals: number; lot_exp: number; reserve: bigint }; bids: WorldBid[] } {
  const f = fromFixture(JSON.parse(readFileSync(demoSaleFixturePath(), 'utf8')));
  return {
    sale: { supply: f.sale.S, decimals: f.sale.decimals, lot_exp: f.sale.lot_exp, reserve: f.sale.reserve },
    bids: f.bids.map((b, i) => ({ bidder: DEMO_BIDDERS[i]?.bidder ?? `bidder${i}.near`, origin: DEMO_BIDDERS[i]?.origin ?? null, B: b.B, p: b.p!, q: b.q! })),
  };
}

/** A self-consistent sale world in one of four states, sealed with the simulated MPC's key. */
export function buildWorld(opts: WorldOptions = {}): World {
  const mode = opts.mode ?? 'identity';
  const network = opts.network ?? 'mainnet';
  const contract = opts.contract ?? 'v1.tenderseal.near';
  const saleId = opts.saleId ?? 1n;
  const state = opts.state ?? 'Open';
  const demo = demoSaleInputs();
  const bidsIn = opts.bids ?? demo.bids;
  const supply = opts.sale?.supply ?? demo.sale.supply;
  const decimals = opts.sale?.decimals ?? demo.sale.decimals;
  const lot_exp = opts.sale?.lot_exp ?? demo.sale.lot_exp;
  const reserve = opts.sale?.reserve ?? demo.sale.reserve;
  const token = opts.sale?.token ?? 'nep141:wrap.near';
  const now = opts.nowNs ?? 1_794_312_000n * NS; // 2026-11-10T12:00:00Z
  const path = `tender/${saleId}/${hashHex(`tender-sim-${saleId}`, 32)}`;
  const mpc = network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
  const sim = simulateMpc({ contract, path, mode, y: 7n });

  const open = state === 'Open';
  const closeNs = open ? now + 86_400n * NS : now - 2n * 86_400n * NS;
  const createdNs = closeNs - 3n * 86_400n * NS;
  const keyed = state === 'Keyed' || state === 'Finalized';
  const keyNs = closeNs + 60n * NS;
  const salts = bidsIn.map((_, i) => (opts.seed ? hexToBytes(hashHex(`${opts.seed}/${i}`, 32)) : undefined));

  const sealed = bidsIn.map((b, idx) =>
    sealBid({ mpk: sim.mpk, contract, path, sale: saleId, bidder: b.bidder, B: b.B, p: b.p, q: b.q, ...(salts[idx] ? { salt: salts[idx] } : {}) }),
  );
  const revealed = (b: WorldBid) => keyed && (b.revealed ?? true);
  const bids: BidView[] = bidsIn.map((b, idx) => ({
    idx,
    bidder: b.bidder,
    escrow: b.B.toString(),
    ct: sealed[idx]!.ct_b64,
    cm: sealed[idx]!.cm_hex,
    origin: b.origin,
    block: String(223_800_200 + idx),
    ns: String(createdNs + BigInt(idx + 1) * 60n * NS),
    state: revealed(b) ? 'Revealed' : 'Sealed',
    p: revealed(b) ? b.p.toString() : null,
    q: revealed(b) ? b.q.toString() : null,
    salt: revealed(b) ? sealed[idx]!.salt_hex : null,
    revealed_by: revealed(b) ? b.bidder : null,
    alloc: '0',
    spend: '0',
    penalty: '0',
    penalty_share: '0',
    paid: { usdc: '0', tokens: '0', ok: false, pending: false },
  }));

  const escrowTotal = bidsIn.reduce((a, b) => a + b.B, 0n);
  let result: ResultView | null = null;
  let sellerPayout = { usdc: '0', tokens: '0', ok: false, pending: false };
  let payoutsDone = 0;
  let pool = 0n;
  if (state === 'Finalized') {
    const r = clear(
      { S: supply, decimals, lot_exp, reserve },
      bids.map((b) => ({ idx: b.idx, B: BigInt(b.escrow), p: b.p === null ? null : BigInt(b.p), q: b.q === null ? null : BigInt(b.q), state: b.state as BidState })),
    );
    for (const b of bids) {
      const i = b.idx;
      b.state = r.final_state[i]!;
      b.alloc = r.alloc[i]!.toString();
      b.spend = r.spend[i]!.toString();
      b.penalty = r.penalty[i]!.toString();
      b.penalty_share = r.penalty_share[i]!.toString();
      b.paid = { usdc: r.refund[i]!.toString(), tokens: r.alloc[i]!.toString(), ok: true, pending: false };
    }
    pool = r.penalty.reduce((a, x) => a + x, 0n);
    result = {
      p_star: r.P_star === null ? null : r.P_star.toString(),
      sold: r.alloc.reduce((a, x) => a + x, 0n).toString(),
      seller_usdc: r.seller_usdc.toString(),
      seller_tokens_back: r.seller_tokens_back.toString(),
      token_dust: r.dust.toString(),
      penalty_pool: pool.toString(),
      block: '223900500',
      ns: String(keyNs + 86_400n * NS + 60n * NS),
      cancelled: false,
    };
    sellerPayout = { usdc: r.seller_usdc.toString(), tokens: r.seller_tokens_back.toString(), ok: true, pending: false };
    payoutsDone = bids.length + 1;
  } else if (state === 'Cancelled') {
    for (const b of bids) b.paid = { usdc: b.escrow, tokens: '0', ok: true, pending: false };
    result = {
      p_star: null,
      sold: '0',
      seller_usdc: '0',
      seller_tokens_back: supply.toString(),
      token_dust: '0',
      penalty_pool: '0',
      block: '223900100',
      ns: String(closeNs + 120n * NS),
      cancelled: true,
    };
    sellerPayout = { usdc: '0', tokens: supply.toString(), ok: true, pending: false };
    payoutsDone = bids.length + 1;
  }

  const keyLog: KeyReqView[] = keyed
    ? [{ i: '0', sale: saleId.toString(), block: '223900000', ns: String(keyNs - 3n * NS), outcome: 'Ok', resolved_block: '223900006' }]
    : [];
  const sale: SaleView = {
    id: saleId.toString(),
    seller: 'tenderseal.near',
    token,
    supply: supply.toString(),
    decimals,
    lot_exp,
    reserve: reserve.toString(),
    min_escrow: '5000000',
    min_bidders: 3,
    max_bids: 16,
    quote_token: SIM_USDC,
    close_ns: closeNs.toString(),
    reveal_secs: '86400',
    created_block: '223800100',
    created_ns: createdNs.toString(),
    path,
    state: state as SaleState,
    bids: bids.length,
    bidders: new Set(bidsIn.map((b) => b.bidder)).size,
    escrow_total: escrowTotal.toString(),
    revealed: bids.filter((b) => b.state === 'Revealed').length,
    key_requests: keyLog.length,
    in_flight: false,
    key: keyed ? { ...sim.response, block: '223900006', ns: keyNs.toString() } : null,
    reveal_deadline_ns: keyed ? String(keyNs + 86_400n * NS) : null,
    seller_payout: sellerPayout,
    payouts_done: payoutsDone,
    payouts_total: state === 'Finalized' || state === 'Cancelled' ? bids.length + 1 : 0,
  };
  const config: ConfigView = {
    version: '1.0.0',
    mpc,
    intents: 'intents.near',
    domain_id: '2',
    app_pk_mode: mode,
    mpc_public_key: sim.mpk,
    quote_tokens: [SIM_USDC],
    sellers: ['tenderseal.near'],
    init_block: '223800000',
    init_ns: String(createdNs - 3600n * NS),
    sales: (saleId + 1n).toString(),
    key_log_len: keyLog.length.toString(),
  };
  return {
    network,
    contract,
    mpc,
    intents: 'intents.near',
    mode,
    mpk: sim.mpk,
    S: keyFromCkd(sim.response, mode),
    config,
    sale,
    bids,
    result,
    keyLog,
    secrets: bidsIn.map((b, idx) => ({ idx, p: b.p, q: b.q, salt_hex: sealed[idx]!.salt_hex })),
    block: { height: 224_000_000n, timestamp_ns: now, hash: '11111111111111111111111111111111' },
    mpcVersion: '3.18.0',
    mpcThreshold: 11,
    mpcParticipants: 16,
    mpcEpoch: 16,
    mpcNextId: 22,
    currentSalt: '252812b3',
    codeHash: '11111111111111111111111111111111',
    intentsCodeHash: TESTED_INTENTS_CODE_HASH,
    tokenDecimals: { [token.replace(/^nep141:/, '')]: decimals, [SIM_USDC.replace(/^nep141:/, '')]: 6 },
    accessKeys: [],
    // What Tender holds in Intents: the escrow and supply of an unsettled sale; once everything is paid, only the
    // penalty pool, which is paid to nobody.
    balances: state === 'Open' || state === 'Keyed' ? { [SIM_USDC]: escrowTotal, [token]: supply } : pool > 0n ? { [SIM_USDC]: pool } : {},
    teeAccounts: 17,
    allowedImages: 1,
    sourceMetadata: null,
    more: [],
  };
}

function rpcError(cause: string, data: string) {
  return { error: { name: 'HANDLER_ERROR', cause: { name: cause, info: {} }, code: -32000, message: 'Server error', data } };
}

/**
 * A fetch() that answers NEAR JSON-RPC from `world` (read lazily, so tests may edit the world afterwards).
 * Unknown accounts answer UNKNOWN_ACCOUNT; unknown contract methods answer a contract panic.
 */
export function fakeRpc(world: World): typeof fetch {
  const viewResult = (v: unknown) => ({
    result: Array.from(te.encode(JSON.stringify(v))),
    logs: [],
    block_height: Number(world.block.height),
    block_hash: world.block.hash,
  });
  const answer = (body: { method: string; params: Record<string, unknown> }): object => {
    const p = body.params;
    if (body.method === 'block') {
      return { result: { header: { height: Number(world.block.height), timestamp_nanosec: world.block.timestamp_ns.toString(), hash: world.block.hash } } };
    }
    if (body.method !== 'query') return rpcError('METHOD_NOT_FOUND', body.method);
    const account = p.account_id as string;
    const known = [world.contract, world.mpc, world.intents, ...Object.keys(world.tokenDecimals)];
    if (!known.includes(account)) return rpcError('UNKNOWN_ACCOUNT', `account ${account} does not exist while viewing`);
    if (p.request_type === 'view_account') {
      const code_hash = account === world.contract ? world.codeHash : account === world.intents ? world.intentsCodeHash : '11111111111111111111111111111111';
      return { result: { amount: '0', locked: '0', code_hash, storage_usage: 0, block_height: Number(world.block.height) } };
    }
    if (p.request_type === 'view_access_key_list') {
      const keys = account === world.contract ? world.accessKeys.map((public_key) => ({ public_key, access_key: { nonce: 0, permission: 'FullAccess' } })) : [];
      return { result: { keys, block_height: Number(world.block.height) } };
    }
    if (p.request_type !== 'call_function') return rpcError('UNSUPPORTED', String(p.request_type));
    const method = p.method_name as string;
    const args = JSON.parse(Buffer.from(p.args_base64 as string, 'base64').toString('utf8') || '{}') as Record<string, unknown>;
    const all = [{ sale: world.sale, bids: world.bids, result: world.result }, ...world.more];
    const one = all.find((x) => x.sale.id === args.id);
    if (account === world.contract) {
      switch (method) {
        case 'get_config':
          return { result: viewResult(world.config) };
        case 'get_sale':
          return { result: viewResult(one?.sale ?? null) };
        case 'get_sales': {
          const from = Number(args.from ?? 0);
          const sales = all.map((x) => x.sale).sort((a, b) => Number(a.id) - Number(b.id));
          return { result: viewResult(sales.filter((x) => Number(x.id) >= from).slice(0, Number(args.limit ?? 50))) };
        }
        case 'get_bids': {
          const from = Number(args.from ?? 0);
          return { result: viewResult(one ? one.bids.slice(from, from + Number(args.limit ?? 64)) : []) };
        }
        case 'get_result':
          return { result: viewResult(one?.result ?? null) };
        case 'contract_source_metadata':
          if (world.sourceMetadata) return { result: viewResult(world.sourceMetadata) };
          break;
        case 'get_key_log': {
          const from = Number(args.from ?? 0);
          return { result: viewResult(world.keyLog.slice(from, from + Number(args.limit ?? 100))) };
        }
      }
    } else if (account === world.mpc) {
      switch (method) {
        case 'version':
          return { result: viewResult(world.mpcVersion) };
        case 'public_key':
          return { result: viewResult(world.mpk) };
        case 'get_tee_accounts':
          return { result: viewResult(Array.from({ length: world.teeAccounts }, (_, i) => ({ account_id: `node${i}.near` }))) };
        case 'allowed_docker_image_hashes':
          return { result: viewResult(Array.from({ length: world.allowedImages }, (_, i) => ({ image_hash: String(i).padStart(64, '0') }))) };
        case 'state':
          return {
            result: viewResult({
              Running: {
                keyset: { epoch_id: world.mpcEpoch },
                parameters: {
                  threshold: world.mpcThreshold,
                  participants: { next_id: world.mpcNextId, participants: Array.from({ length: world.mpcParticipants }, (_, i) => [`node${i}.near`, i, {}]) },
                },
              },
            }),
          };
      }
    } else if (account in world.tokenDecimals) {
      if (method === 'ft_metadata') return { result: viewResult({ spec: 'ft-1.0.0', name: account, symbol: 'T', decimals: world.tokenDecimals[account] }) };
    } else {
      switch (method) {
        case 'current_salt':
          return { result: viewResult(world.currentSalt) };
        case 'mt_batch_balance_of':
          return { result: viewResult((args.token_ids as string[]).map((t) => (world.balances[t] ?? 0n).toString())) };
      }
    }
    return rpcError('CONTRACT_EXECUTION_ERROR', `wasm execution failed: MethodResolveError(MethodNotFound) ${method}`);
  };
  return (async (_input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; params: Record<string, unknown>; id?: unknown };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 'tender', ...answer(body) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
