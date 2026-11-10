import { view, type Network } from "./rpc.js";

// Contract views (contract/src/lib.rs, v1.0.0). u64 / u128 arrive as decimal strings, u8 / u16 / u32 as JSON numbers.
// Arguments: `from` is a string in get_sales and get_key_log but a JSON number in get_bids; `limit` is always a number.

export interface ConfigView {
  version: string;
  mpc: string;
  intents: string;
  domain_id: string; // a string although new() takes a number
  app_pk_mode: string;
  mpc_public_key: string;
  quote_tokens: string[];
  sellers: string[];
  init_block: string;
  init_ns: string;
  sales: string; // number of sales = the id the next sale gets
  key_log_len: string;
}

export interface KeyView {
  big_y: string;
  big_c: string;
  block: string;
  ns: string;
}

export interface PayoutView {
  usdc: string;
  tokens: string;
  ok: boolean;
}

export type SaleStateName = "Open" | "Opening" | "Keyed" | "Finalized" | "Cancelled";

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
  state: SaleStateName; // Opening = Open with a key request in flight
  bids: number;
  bidders: number;
  escrow_total: string;
  revealed: number;
  key_requests: number;
  in_flight: boolean;
  key: KeyView | null;
  reveal_deadline_ns: string | null;
  seller_payout: PayoutView;
  payouts_done: number;
  payouts_total: number; // bids + 1 (the seller)
}

export type BidState = "Sealed" | "Revealed" | "Penalized";

export interface BidView {
  idx: number;
  bidder: string;
  escrow: string;
  ct: string; // base64 standard, padded, 160 bytes
  cm: string; // 64 lowercase hex
  origin: string | null;
  block: string;
  ns: string;
  state: BidState;
  p: string | null;
  q: string | null;
  salt: string | null;
  revealed_by: string | null;
  alloc: string;
  spend: string;
  penalty: string;
  penalty_share: string;
  paid: PayoutView; // usdc = refund, tokens = alloc
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

export interface KeyLogView {
  i: string;
  sale: string;
  block: string;
  ns: string;
  outcome: "Pending" | "Ok" | "Err";
  resolved_block: string | null;
}

export const BIDS_PAGE = 64;
const KEY_LOG_PAGE = 100;

export function getConfig(network: Network, contract: string, rpc?: string): Promise<ConfigView> {
  return view<ConfigView>(network, contract, "get_config", {}, { rpc });
}

/** `null` when the sale id does not exist. */
export function getSale(network: Network, contract: string, id: string, rpc?: string): Promise<SaleView | null> {
  return view<SaleView | null>(network, contract, "get_sale", { id }, { rpc });
}

/** `null` until the sale is finalized or cancelled. */
export function getResult(network: Network, contract: string, id: string, rpc?: string): Promise<ResultView | null> {
  return view<ResultView | null>(network, contract, "get_result", { id }, { rpc });
}

/** All bids of a sale in index order, paged until a short page. */
export async function getBids(network: Network, contract: string, id: string, rpc?: string): Promise<BidView[]> {
  const out: BidView[] = [];
  for (let from = 0; ; from += BIDS_PAGE) {
    const page = (await view<BidView[]>(network, contract, "get_bids", { id, from, limit: BIDS_PAGE }, { rpc })) ?? [];
    out.push(...page);
    if (page.length < BIDS_PAGE) return out;
  }
}

/** Chain time (ns) of the sale's pending key request, read from the key ledger newest page first; `null` when none is pending. */
export async function pendingRequestNs(network: Network, contract: string, sale: string, rpc?: string): Promise<bigint | null> {
  const len = Number((await getConfig(network, contract, rpc)).key_log_len);
  for (let end = len; end > 0; end -= KEY_LOG_PAGE) {
    const from = Math.max(0, end - KEY_LOG_PAGE);
    const page = (await view<KeyLogView[]>(network, contract, "get_key_log", { from: String(from), limit: end - from }, { rpc })) ?? [];
    const hit = page.filter((k) => k.sale === sale && k.outcome === "Pending").at(-1);
    if (hit) return BigInt(hit.ns);
  }
  return null;
}
