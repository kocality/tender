import type { BidView, ConfigView, SaleView } from "../../scripts/lib/views.js";

// Fixtures in the exact shape of the contract views (v1.0.0).

export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export const configView = (over: Partial<ConfigView> = {}): ConfigView => ({
  version: "1.0.0", mpc: "v1.signer", intents: "intents.near", domain_id: "2", app_pk_mode: "identity", mpc_public_key: "bls12381g2:x",
  quote_tokens: [USDC], sellers: ["tenderseal.near"], init_block: "1", init_ns: "1", sales: "0", key_log_len: "0", ...over,
});

export const saleView = (over: Partial<SaleView> = {}): SaleView => ({
  id: "2", seller: "tenderseal.near", token: "nep141:jambo-1679.meme-cooking.near", supply: "22450000000000000000000", decimals: 18, lot_exp: 3,
  reserve: "3000000", min_escrow: "5000000", min_bidders: 3, max_bids: 16, quote_token: USDC, close_ns: "1794916800000000000", reveal_secs: "86400",
  created_block: "1", created_ns: "1", path: "tender/2/00112233445566778899aabbccddeeff", state: "Open", bids: 0, bidders: 0, escrow_total: "0",
  revealed: 0, key_requests: 0, in_flight: false, key: null, reveal_deadline_ns: null, seller_payout: { usdc: "0", tokens: "0", ok: false },
  payouts_done: 0, payouts_total: 1, ...over,
});

export const bidView = (over: Partial<BidView> = {}): BidView => ({
  idx: 0, bidder: "bidder.tenderseal.near", escrow: "3000000", ct: Buffer.alloc(160, 1).toString("base64"), cm: "a".repeat(64), origin: "base",
  block: "1", ns: "1", state: "Sealed", p: null, q: null, salt: null, revealed_by: null, alloc: "0", spend: "0", penalty: "0", penalty_share: "0",
  paid: { usdc: "0", tokens: "0", ok: false }, ...over,
});
