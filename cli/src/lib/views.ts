// Typed contract, MPC and Intents views. Shapes mirror the contract's view JSON (numbers > u32 are decimal strings).
// Every method takes an optional block height so one verify run reads one block (P-6).
import type { Rpc } from './rpc.js';

export type AppPkMode = 'identity' | 'generator' | 'plain';
export interface ConfigView {
  version: string;
  mpc: string;
  intents: string;
  domain_id: string;
  app_pk_mode: AppPkMode;
  mpc_public_key: string;
  quote_tokens: string[];
  sellers: string[];
  init_block: string;
  init_ns: string;
  sales: string;
  key_log_len: string;
}
export type SaleState = 'Open' | 'Opening' | 'Keyed' | 'Finalized' | 'Cancelled'; // "Opening" = Open ∧ in_flight (WD-14)
export interface KeyView {
  big_y: string;
  big_c: string;
  block: string;
  ns: string;
}
export interface PaidView {
  usdc: string;
  tokens: string;
  ok: boolean;
}
export interface SaleView {
  id: string;
  seller: string;
  token: string;
  supply: string;
  decimals: number;
  lot_exp: number;
  reserve: string;
  min_escrow: string;
  min_bidders: number;
  max_bids: number;
  quote_token: string;
  close_ns: string;
  reveal_secs: string;
  created_block: string;
  created_ns: string;
  path: string;
  state: SaleState;
  bids: number;
  bidders: number;
  escrow_total: string;
  revealed: number;
  key_requests: number;
  in_flight: boolean;
  key: KeyView | null;
  reveal_deadline_ns: string | null;
  seller_payout: PaidView;
  payouts_done: number;
  payouts_total: number;
}
export interface BidView {
  idx: number;
  bidder: string;
  escrow: string;
  ct: string;
  cm: string;
  origin: string | null;
  block: string;
  ns: string;
  state: 'Sealed' | 'Revealed' | 'Penalized';
  p: string | null;
  q: string | null;
  salt: string | null;
  revealed_by: string | null;
  alloc: string;
  spend: string;
  penalty: string;
  penalty_share: string;
  paid: PaidView;
}
export interface ResultView {
  p_star: string | null;
  sold: string;
  seller_usdc: string;
  seller_tokens_back: string;
  token_dust: string;
  penalty_pool: string;
  block: string;
  ns: string;
  cancelled: boolean;
}
export interface KeyReqView {
  i: string;
  sale: string;
  block: string;
  ns: string;
  outcome: 'Pending' | 'Ok' | 'Err';
  resolved_block: string | null;
}

const SALES_PAGE = 50;
const BIDS_PAGE = 64;
const KEYLOG_PAGE = 100;

export class TenderViews {
  constructor(
    readonly rpc: Rpc,
    readonly contract: string,
  ) {}

  config(block?: bigint): Promise<ConfigView> {
    return this.rpc.view(this.contract, 'get_config', {}, block);
  }

  sale(id: bigint | number, block?: bigint): Promise<SaleView | null> {
    return this.rpc.view(this.contract, 'get_sale', { id: String(id) }, block);
  }

  /** All sales, page by page until an empty page (P-21). */
  async sales(block?: bigint): Promise<SaleView[]> {
    const out: SaleView[] = [];
    for (let from = 0n; ; from += BigInt(SALES_PAGE)) {
      const page = await this.rpc.view<SaleView[]>(this.contract, 'get_sales', { from: String(from), limit: SALES_PAGE }, block);
      if (page.length === 0) return out;
      out.push(...page);
    }
  }

  async bids(id: bigint | number, block?: bigint): Promise<BidView[]> {
    const out: BidView[] = [];
    for (let from = 0; ; from += BIDS_PAGE) {
      const page = await this.rpc.view<BidView[]>(this.contract, 'get_bids', { id: String(id), from, limit: BIDS_PAGE }, block);
      if (page.length === 0) return out;
      out.push(...page);
    }
  }

  result(id: bigint | number, block?: bigint): Promise<ResultView | null> {
    return this.rpc.view(this.contract, 'get_result', { id: String(id) }, block);
  }

  async keyLog(block?: bigint): Promise<KeyReqView[]> {
    const out: KeyReqView[] = [];
    for (let from = 0n; ; from += BigInt(KEYLOG_PAGE)) {
      const page = await this.rpc.view<KeyReqView[]>(this.contract, 'get_key_log', { from: String(from), limit: KEYLOG_PAGE }, block);
      if (page.length === 0) return out;
      out.push(...page);
    }
  }
}

export interface MpcState {
  status: 'Running' | string;
  threshold: number | null;
  participants: number | null;
}

export class MpcViews {
  constructor(
    readonly rpc: Rpc,
    readonly mpc: string,
  ) {}

  version(block?: bigint): Promise<string> {
    return this.rpc.view(this.mpc, 'version', {}, block);
  }

  async state(block?: bigint): Promise<MpcState> {
    const s = await this.rpc.view<Record<string, unknown>>(this.mpc, 'state', {}, block);
    const status = Object.keys(s)[0] ?? 'unknown';
    const params = (s[status] as { parameters?: { threshold?: number; participants?: { participants?: unknown[] } } } | undefined)
      ?.parameters;
    return {
      status,
      threshold: params?.threshold ?? null,
      participants: params?.participants?.participants?.length ?? null,
    };
  }

  publicKey(domain: number, block?: bigint): Promise<string> {
    return this.rpc.view(this.mpc, 'public_key', { domain_id: domain }, block);
  }
}

export class IntentsViews {
  constructor(
    readonly rpc: Rpc,
    readonly intents: string,
  ) {}

  async mtBatchBalanceOf(account: string, tokenIds: string[], block?: bigint): Promise<bigint[]> {
    const r = await this.rpc.view<string[]>(this.intents, 'mt_batch_balance_of', { account_id: account, token_ids: tokenIds }, block);
    return r.map((x) => BigInt(x));
  }
}
