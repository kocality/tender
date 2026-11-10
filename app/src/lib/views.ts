import { viewCall } from '@tender/intents';
import { config } from '../config';

// Contract views (C23). ASSUMES the WS1-T09 JSON shapes (tasks/WS1.md WS1-T09): u64/u128 are strings, small counters may be
// numbers. Only this file parses them; if the contract output differs, change the parse functions here and nothing else.
// Unknown fields are ignored; missing optional fields become null/0.

export type SaleState = 'Open' | 'Opening' | 'Keyed' | 'Finalized' | 'Cancelled';
export type BidState = 'Sealed' | 'Revealed' | 'Penalized';
export type KeyOutcome = 'Pending' | 'Ok' | 'Err';
export type AppPkMode = 'identity' | 'generator' | 'plain';

export interface Config {
  version: string;
  mpc: string;
  intents: string;
  domainId: bigint;
  appPkMode: AppPkMode;
  mpcPublicKey: string;
  quoteTokens: string[];
  sellers: string[];
  initBlock: bigint;
  initNs: bigint;
  sales: bigint;
  keyLogLen: bigint;
}

export interface Payout {
  usdc: bigint;
  tokens: bigint;
  ok: boolean;
}

export interface KeyInfo {
  bigY: string;
  bigC: string;
  block: bigint;
  ns: bigint;
}

export interface Sale {
  id: string;
  seller: string;
  token: string;
  supply: bigint;
  decimals: number;
  lotExp: number;
  reserve: bigint;
  minEscrow: bigint;
  minBidders: number;
  maxBids: number;
  quoteToken: string;
  closeNs: bigint;
  revealSecs: bigint;
  createdBlock: bigint;
  createdNs: bigint;
  path: string;
  state: SaleState;
  bids: number;
  bidders: number;
  escrowTotal: bigint;
  revealed: number;
  keyRequests: number;
  inFlight: boolean;
  key: KeyInfo | null;
  revealDeadlineNs: bigint | null;
  sellerPayout: Payout | null;
  payoutsDone: number;
  payoutsTotal: number;
}

export interface Bid {
  idx: number;
  bidder: string;
  escrow: bigint;
  ct: string; // base64, 160 bytes
  cm: string; // 64 hex
  origin: string | null; // self-declared
  block: bigint;
  ns: bigint;
  state: BidState;
  p: bigint | null;
  q: bigint | null;
  salt: string | null;
  revealedBy: string | null;
  alloc: bigint;
  spend: bigint;
  penalty: bigint;
  penaltyShare: bigint;
  paid: Payout | null;
}

export interface SaleResult {
  pStar: bigint | null;
  sold: bigint;
  sellerUsdc: bigint;
  sellerTokensBack: bigint;
  tokenDust: bigint;
  penaltyPool: bigint;
  block: bigint;
  ns: bigint;
  cancelled: boolean;
}

export interface KeyReq {
  i: bigint;
  sale: string;
  block: bigint;
  ns: bigint;
  outcome: KeyOutcome;
  resolvedBlock: bigint | null;
}

type Json = Record<string, unknown>;

function obj(v: unknown, what: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what}: expected an object`);
  return v as Json;
}

function big(v: unknown, fallback = 0n): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return fallback;
}

function bigOrNull(v: unknown): bigint | null {
  return v === null || v === undefined ? null : big(v);
}

function num(v: unknown): number {
  return Number(big(v));
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function payout(v: unknown): Payout | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Json;
  return { usdc: big(o.usdc), tokens: big(o.tokens), ok: o.ok === true };
}

const SALE_STATES: SaleState[] = ['Open', 'Opening', 'Keyed', 'Finalized', 'Cancelled'];
const BID_STATES: BidState[] = ['Sealed', 'Revealed', 'Penalized'];
const KEY_OUTCOMES: KeyOutcome[] = ['Pending', 'Ok', 'Err'];

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`${what}: unexpected value ${JSON.stringify(v)}`);
}

export function parseConfig(raw: unknown): Config {
  const o = obj(raw, 'get_config');
  return {
    version: str(o.version),
    mpc: str(o.mpc),
    intents: str(o.intents),
    domainId: big(o.domain_id),
    appPkMode: oneOf(o.app_pk_mode, ['identity', 'generator', 'plain'], 'app_pk_mode'),
    mpcPublicKey: str(o.mpc_public_key),
    quoteTokens: strList(o.quote_tokens),
    sellers: strList(o.sellers),
    initBlock: big(o.init_block),
    initNs: big(o.init_ns),
    sales: big(o.sales),
    keyLogLen: big(o.key_log_len),
  };
}

export function parseSale(raw: unknown): Sale {
  const o = obj(raw, 'sale');
  const key = o.key === null || o.key === undefined ? null : obj(o.key, 'sale.key');
  return {
    id: String(big(o.id)),
    seller: str(o.seller),
    token: str(o.token),
    supply: big(o.supply),
    decimals: num(o.decimals),
    lotExp: num(o.lot_exp),
    reserve: big(o.reserve),
    minEscrow: big(o.min_escrow),
    minBidders: num(o.min_bidders),
    maxBids: num(o.max_bids),
    quoteToken: str(o.quote_token),
    closeNs: big(o.close_ns),
    revealSecs: big(o.reveal_secs),
    createdBlock: big(o.created_block),
    createdNs: big(o.created_ns),
    path: str(o.path),
    state: oneOf(o.state, SALE_STATES, 'sale.state'),
    bids: num(o.bids),
    bidders: num(o.bidders),
    escrowTotal: big(o.escrow_total),
    revealed: num(o.revealed),
    keyRequests: num(o.key_requests),
    inFlight: o.in_flight === true,
    key: key && { bigY: str(key.big_y), bigC: str(key.big_c), block: big(key.block), ns: big(key.ns) },
    revealDeadlineNs: bigOrNull(o.reveal_deadline_ns),
    sellerPayout: payout(o.seller_payout),
    payoutsDone: num(o.payouts_done),
    payoutsTotal: num(o.payouts_total),
  };
}

export function parseBid(raw: unknown): Bid {
  const o = obj(raw, 'bid');
  return {
    idx: num(o.idx),
    bidder: str(o.bidder),
    escrow: big(o.escrow),
    ct: str(o.ct),
    cm: str(o.cm),
    origin: strOrNull(o.origin),
    block: big(o.block),
    ns: big(o.ns),
    state: oneOf(o.state, BID_STATES, 'bid.state'),
    p: bigOrNull(o.p),
    q: bigOrNull(o.q),
    salt: strOrNull(o.salt),
    revealedBy: strOrNull(o.revealed_by),
    alloc: big(o.alloc),
    spend: big(o.spend),
    penalty: big(o.penalty),
    penaltyShare: big(o.penalty_share),
    paid: payout(o.paid),
  };
}

export function parseResult(raw: unknown): SaleResult | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw, 'get_result');
  return {
    pStar: bigOrNull(o.p_star),
    sold: big(o.sold),
    sellerUsdc: big(o.seller_usdc),
    sellerTokensBack: big(o.seller_tokens_back),
    tokenDust: big(o.token_dust),
    penaltyPool: big(o.penalty_pool),
    block: big(o.block),
    ns: big(o.ns),
    cancelled: o.cancelled === true,
  };
}

export function parseKeyReq(raw: unknown): KeyReq {
  const o = obj(raw, 'key log entry');
  return {
    i: big(o.i),
    sale: String(big(o.sale)),
    block: big(o.block),
    ns: big(o.ns),
    outcome: oneOf(o.outcome, KEY_OUTCOMES, 'key log outcome'),
    resolvedBlock: bigOrNull(o.resolved_block),
  };
}

function view<T>(method: string, args: unknown): Promise<T> {
  return viewCall<T>(config.rpcUrls, config.tenderContractId, method, args);
}

const SALES_PAGE = 50;
const BIDS_PAGE = 64;
const KEY_LOG_PAGE = 100;
const MAX_PAGES = 100; // guard against a view that ignores `from`

export async function getConfig(): Promise<Config> {
  return parseConfig(await view<unknown>('get_config', {}));
}

/** `null` when the sale does not exist (not created yet). */
export async function getSale(id: string): Promise<Sale | null> {
  const raw = await view<unknown>('get_sale', { id });
  return raw === null ? null : parseSale(raw);
}

export async function getSales(from: number, limit = SALES_PAGE): Promise<Sale[]> {
  const raw = await view<unknown[]>('get_sales', { from: String(from), limit: Math.min(limit, SALES_PAGE) });
  return raw.map(parseSale);
}

/** Pages of 64 until a short page (the contract silently trims `limit`). */
export async function getAllBids(id: string): Promise<Bid[]> {
  const out: Bid[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await view<unknown[]>('get_bids', { id, from: String(out.length), limit: BIDS_PAGE });
    out.push(...raw.map(parseBid));
    if (raw.length < BIDS_PAGE) break;
  }
  return out;
}

export async function getResult(id: string): Promise<SaleResult | null> {
  return parseResult(await view<unknown>('get_result', { id }));
}

/** Pages of 100 until a short page. */
export async function getKeyLog(): Promise<KeyReq[]> {
  const out: KeyReq[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await view<unknown[]>('get_key_log', { from: String(out.length), limit: KEY_LOG_PAGE });
    out.push(...raw.map(parseKeyReq));
    if (raw.length < KEY_LOG_PAGE) break;
  }
  return out;
}

/** Every sale, in pages of 50 starting from id 0. */
export async function getAllSales(): Promise<Sale[]> {
  const out: Sale[] = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await getSales(out.length);
    out.push(...page);
    if (page.length < SALES_PAGE) break;
  }
  return out;
}

/** MPC contract version string, shown on the key ledger page. */
export async function getMpcVersion(): Promise<string> {
  return viewCall<string>(config.rpcUrls, config.mpcContractId, 'version', {});
}
