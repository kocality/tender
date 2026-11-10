//! Tender: sealed-bid token sales whose bids are opened by NEAR's MPC network (CKD).
//!
//! The contract holds escrow and sale tokens inside `intents.near`, accepts sales and bids
//! through `mt_on_transfer`, asks the MPC contract for the sale's key only when the sale's
//! public open conditions hold, checks revealed bids against their commitments, clears at one
//! uniform price and pays out with `mt_batch_transfer`. It has no owner, no admin method and no
//! upgrade method. Every cross-contract call uses the low-level `env::promise_*` API.
pub mod clearing;
pub mod events;
pub mod intents;
pub mod sale;
pub mod seal;

use near_sdk::json_types::{U64, U128};
use near_sdk::store::{LookupMap, LookupSet, Vector};
use near_sdk::{AccountId, PanicOnDefault, env, near, require};

use near_sdk::serde_json::json;
use sale::{
    AppPkMode, Bid, BidState, Key, KeyOutcome, KeyReq, MAX_REVEAL_ITEMS, NS_PER_SEC, Payout,
    RevealItem, Sale, SaleResult, SaleState,
};

pub const VERSION: &str = "1.0.0";
/// C26: every state-growing path keeps at least this much free balance after storage.
pub const STORAGE_RESERVE_YOCTO: u128 = 300_000_000_000_000_000_000_000;
/// Storage estimate for one new sale (C26): at least 1.25 × the measured bytes (311 in the
/// sandbox gas report).
pub const CREATE_STORAGE_BYTES: u64 = 800;
/// Storage estimate for one new bid incl. its bidder-seen entry (C26): 1.25 × the measured
/// worst case (580 B: 64-character bidder, 8-byte origin).
pub const BID_STORAGE_BYTES: u64 = 725;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Tender {
    mpc: AccountId,
    intents: AccountId,
    domain_id: u64,
    app_pk_mode: AppPkMode,
    mpc_public_key: String,
    quote_tokens: Vec<String>,
    sellers: Vec<AccountId>,
    init_block: u64,
    init_ns: u64,
    sales: Vector<Sale>,
    bids: LookupMap<(u64, u16), Bid>,
    key_log: Vector<KeyReq>,
    bidder_seen: LookupSet<(u64, AccountId)>,
}

/// C26: true when `extra_bytes` more storage still leaves STORAGE_RESERVE_YOCTO free.
pub fn storage_ok(extra_bytes: u64) -> bool {
    let need = (env::storage_usage().saturating_add(extra_bytes) as u128)
        .saturating_mul(env::storage_byte_cost().as_yoctonear());
    env::account_balance().as_yoctonear().saturating_sub(need) >= STORAGE_RESERVE_YOCTO
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub version: String,
    pub mpc: AccountId,
    pub intents: AccountId,
    pub domain_id: U64,
    pub app_pk_mode: String,
    pub mpc_public_key: String,
    pub quote_tokens: Vec<String>,
    pub sellers: Vec<AccountId>,
    pub init_block: U64,
    pub init_ns: U64,
    pub sales: U64,
    pub key_log_len: U64,
}

#[near(serializers = [json])]
pub struct KeyView {
    pub big_y: String,
    pub big_c: String,
    pub block: U64,
    pub ns: U64,
}

#[near(serializers = [json])]
pub struct PayoutView {
    pub usdc: U128,
    pub tokens: U128,
    pub ok: bool,
}

#[near(serializers = [json])]
pub struct SaleView {
    pub id: U64,
    pub seller: AccountId,
    pub token: String,
    pub supply: U128,
    pub decimals: u8,
    pub lot_exp: u8,
    pub reserve: U64,
    pub min_escrow: U128,
    pub min_bidders: u16,
    pub max_bids: u16,
    pub quote_token: String,
    pub close_ns: U64,
    pub reveal_secs: U64,
    pub created_block: U64,
    pub created_ns: U64,
    pub path: String,
    pub state: String,
    pub bids: u16,
    pub bidders: u16,
    pub escrow_total: U128,
    pub revealed: u16,
    pub key_requests: u32,
    pub in_flight: bool,
    pub key: Option<KeyView>,
    pub reveal_deadline_ns: Option<U64>,
    pub seller_payout: PayoutView,
    pub payouts_done: u16,
    pub payouts_total: u16,
}

#[near(serializers = [json])]
pub struct BidView {
    pub idx: u16,
    pub bidder: AccountId,
    pub escrow: U128,
    /// Standard base64 with padding (160 bytes).
    pub ct: String,
    /// 64 lowercase hex.
    pub cm: String,
    pub origin: Option<String>,
    pub block: U64,
    pub ns: U64,
    pub state: String,
    pub p: Option<U64>,
    pub q: Option<U64>,
    /// 32 lowercase hex once revealed.
    pub salt: Option<String>,
    pub revealed_by: Option<AccountId>,
    pub alloc: U128,
    pub spend: U128,
    pub penalty: U128,
    pub penalty_share: U128,
    pub paid: PayoutView,
}

#[near(serializers = [json])]
pub struct ResultView {
    pub p_star: Option<U64>,
    pub sold: U128,
    pub seller_usdc: U128,
    pub seller_tokens_back: U128,
    pub token_dust: U128,
    pub penalty_pool: U128,
    pub block: U64,
    pub ns: U64,
    pub cancelled: bool,
}

#[near(serializers = [json])]
pub struct KeyLogView {
    pub i: U64,
    pub sale: U64,
    pub block: U64,
    pub ns: U64,
    pub outcome: String,
    pub resolved_block: Option<U64>,
}

#[near]
impl Tender {
    /// C1-C3: called by the parent account in the same batch that creates and funds this
    /// keyless account (so not `#[private]`). Fixes the MPC contract, the app public key mode,
    /// the quote tokens and the sellers for the life of the contract.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mpc: AccountId,
        intents: AccountId,
        domain_id: u64,
        app_pk_mode: String,
        mpc_public_key: String,
        quote_tokens: Vec<String>,
        sellers: Vec<AccountId>,
    ) -> Self {
        require!(!env::state_exists(), "new: already initialised");
        let me = env::current_account_id();
        let parent = me.as_str().split_once('.').map(|(_, p)| p);
        require!(
            Some(env::predecessor_account_id().as_str()) == parent,
            "new: only the parent account can initialise"
        );
        let app_pk_mode = AppPkMode::parse(&app_pk_mode).unwrap_or_else(|| {
            env::panic_str("new: app_pk_mode must be identity, generator or plain")
        });
        require!(!quote_tokens.is_empty(), "new: quote_tokens is empty");
        require!(!sellers.is_empty(), "new: sellers is empty");
        require!(
            mpc_public_key.starts_with("bls12381g2:"),
            "new: mpc_public_key must be bls12381g2:"
        );
        Self {
            mpc,
            intents,
            domain_id,
            app_pk_mode,
            mpc_public_key,
            quote_tokens,
            sellers,
            init_block: env::block_height(),
            init_ns: env::block_timestamp(),
            sales: Vector::new(b"s"),
            bids: LookupMap::new(b"b"),
            key_log: Vector::new(b"k"),
            bidder_seen: LookupSet::new(b"u"),
        }
    }

    /// C13, K9, K10: after close, if the public open conditions hold (escrow ≥ min_escrow,
    /// distinct bidders ≥ min_bidders), writes the request to the key ledger and only then asks
    /// the MPC contract for the sale's key. Anyone can call it; not payable (the MPC's 1 yocto
    /// comes from the contract balance). The transaction's result is `on_key`'s.
    pub fn open(&mut self, sale: U64) {
        let id = sale.0;
        let now = env::block_timestamp();
        let s = self
            .sale(id)
            .unwrap_or_else(|| env::panic_str("open: sale not found"));
        require!(s.state == SaleState::Open, "open: sale is not open");
        require!(!s.in_flight, "open: request already in flight");
        require!(now >= s.close_ns, "open: before close");
        require!(
            s.escrow_total >= s.min_escrow,
            "open: escrow below min_escrow"
        );
        require!(
            s.bidders >= s.min_bidders,
            "open: fewer bidders than min_bidders"
        );
        let args = seal::ckd_args(&s.path, self.app_pk_mode, self.domain_id);

        // K10: ledger entry and request count first, the MPC promise after.
        let log_idx = self.key_log.len() as u64;
        self.key_log.push(KeyReq {
            sale: id,
            block: env::block_height(),
            ns: now,
            outcome: KeyOutcome::Pending,
            resolved_block: None,
        });
        let s = self.sale_mut(id).unwrap();
        s.key_requests += 1;
        s.in_flight = true;
        s.pending_log = Some(log_idx);
        events::emit(
            "open",
            json!({
                "sale": id.to_string(),
                "log_idx": log_idx.to_string(),
                "key_requests": s.key_requests,
                "escrow_total": s.escrow_total.to_string(),
                "bidders": s.bidders,
            }),
        );
        seal::request_key(&self.mpc, &args, id, log_idx);
    }

    /// C15: stores the key (state Keyed, reveal window starts) or records the failure so `open`
    /// can be retried. Never panics: a panic here would leave the request in flight forever.
    #[private]
    pub fn on_key(&mut self, sale: U64, log_idx: U64) {
        let (id, log_idx) = (sale.0, log_idx.0);
        let raw = env::promise_result_checked(0, 512).ok();
        let (block, now) = (env::block_height(), env::block_timestamp());
        let Some(s) = self.sale_mut(id) else {
            env::log_str("on_key: sale not found");
            return;
        };
        if s.pending_log != Some(log_idx) || s.state != SaleState::Open {
            env::log_str("on_key: stale callback");
            return;
        }
        let key = raw.as_deref().and_then(seal::parse_ckd);
        let outcome = match key {
            Some((big_y, big_c)) => {
                s.key = Some(Key {
                    big_y,
                    big_c,
                    block,
                    ns: now,
                });
                s.reveal_deadline_ns = Some(sale::reveal_deadline(now, s.reveal_secs));
                sale::transition(s, SaleState::Keyed);
                KeyOutcome::Ok
            }
            None => KeyOutcome::Err,
        };
        s.in_flight = false;
        s.pending_log = None;
        let deadline = s.reveal_deadline_ns;
        let key_requests = s.key_requests;
        if let Some(entry) = u32::try_from(log_idx)
            .ok()
            .and_then(|i| self.key_log.get_mut(i))
        {
            entry.outcome = outcome;
            entry.resolved_block = Some(block);
        }
        match outcome {
            KeyOutcome::Ok => events::emit(
                "key",
                json!({
                    "sale": id.to_string(),
                    "log_idx": log_idx.to_string(),
                    "block": block.to_string(),
                    "ns": now.to_string(),
                    "reveal_deadline_ns": deadline.map(|d| d.to_string()),
                }),
            ),
            _ => events::emit(
                "key_error",
                json!({
                    "sale": id.to_string(),
                    "log_idx": log_idx.to_string(),
                    "key_requests": key_requests,
                }),
            ),
        }
    }

    /// C19, K11: (a) after close, the open conditions fail and no key was ever requested, or
    /// (b) 24 h after close with no key and nothing in flight. Every bid gets its full escrow
    /// back and the seller its supply. Cancelled is terminal: nothing leads from it to a key
    /// request. Anyone can call it; not payable.
    pub fn cancel(&mut self, sale: U64) {
        let id = sale.0;
        let now = env::block_timestamp();
        let s = self
            .sale(id)
            .unwrap_or_else(|| env::panic_str("cancel: sale not found"));
        let conditions_fail = s.escrow_total < s.min_escrow || s.bidders < s.min_bidders;
        let a = now >= s.close_ns && conditions_fail && s.key_requests == 0;
        let b = now
            >= s.close_ns
                .saturating_add(sale::MIN_REVEAL_SECS * NS_PER_SEC);
        require!(
            s.state == SaleState::Open && !s.in_flight && s.key.is_none() && (a || b),
            "cancel: conditions not met"
        );
        let reason = if a { "conditions" } else { "no_key_24h" };
        for i in 0..s.bids {
            if let Some(bid) = self.bids.get_mut(&(id, i)) {
                bid.paid = Payout {
                    usdc: bid.escrow,
                    tokens: 0,
                    ok: false,
                    pending: false,
                };
            }
        }
        let s = self.sale_mut(id).unwrap();
        s.seller_payout = Payout {
            usdc: 0,
            tokens: s.supply,
            ok: false,
            pending: false,
        };
        s.result = Some(SaleResult {
            p_star: None,
            sold: 0,
            seller_usdc: 0,
            seller_tokens_back: s.supply,
            token_dust: 0,
            penalty_pool: 0,
            block: env::block_height(),
            ns: now,
            cancelled: true,
        });
        sale::transition(s, SaleState::Cancelled);
        events::emit(
            "cancel",
            json!({
                "sale": id.to_string(),
                "reason": reason,
                "key_requests": s.key_requests,
            }),
        );
        self.pay_next(id, 8);
    }

    /// C16: checks opened bids against their commitments and stores `p`, `q`, `salt` (WD-05).
    /// Anyone can call it; not payable. 1..=16 items; the first invalid item panics, which
    /// reverts the whole batch.
    pub fn reveal(&mut self, sale: U64, items: Vec<RevealItem>) {
        require!(
            (1..=MAX_REVEAL_ITEMS).contains(&items.len()),
            "reveal: 1 to 16 items"
        );
        let by = env::predecessor_account_id();
        for item in &items {
            if let Err(e) = self.apply_reveal(sale.0, item, &by) {
                env::panic_str(&format!("reveal: {e}"));
            }
        }
    }

    /// C18, WD-03, WD-04. On a Keyed sale, once the reveal deadline has passed or every bid is
    /// revealed, the first call clears it at one price, applies the penalty (to revealed
    /// bidders, never the seller) and records every payout. Every call on a Finalized or
    /// Cancelled sale then sends the next `max` unpaid payouts (1..=8, 0 means 8); failed ones
    /// are retried by the next call. Anyone can call it; not payable.
    pub fn finalize(&mut self, sale: U64, max: u8) {
        let id = sale.0;
        let s = self
            .sale(id)
            .unwrap_or_else(|| env::panic_str("finalize: sale not found"));
        match s.state {
            SaleState::Open => env::panic_str("finalize: sale has no key"),
            SaleState::Keyed => self.settle(id),
            SaleState::Finalized | SaleState::Cancelled => {}
        }
        let max = if max == 0 { 8 } else { max.min(8) };
        self.pay_next(id, max);
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            version: VERSION.to_string(),
            mpc: self.mpc.clone(),
            intents: self.intents.clone(),
            domain_id: U64(self.domain_id),
            app_pk_mode: self.app_pk_mode.as_str().to_string(),
            mpc_public_key: self.mpc_public_key.clone(),
            quote_tokens: self.quote_tokens.clone(),
            sellers: self.sellers.clone(),
            init_block: U64(self.init_block),
            init_ns: U64(self.init_ns),
            sales: U64(self.sales.len() as u64),
            key_log_len: U64(self.key_log.len() as u64),
        }
    }

    /// `null` for an unknown id.
    pub fn get_sale(&self, id: U64) -> Option<SaleView> {
        self.sale(id.0).map(|s| sale_view(id.0, s))
    }

    /// Sales `from..from+limit`; `limit` is capped at 50.
    pub fn get_sales(&self, from: U64, limit: u8) -> Vec<SaleView> {
        let end = from
            .0
            .saturating_add(u64::from(limit.min(50)))
            .min(self.sales.len() as u64);
        (from.0..end)
            .filter_map(|i| self.sale(i).map(|s| sale_view(i, s)))
            .collect()
    }

    /// Bids `from..from+limit` of sale `id`; `limit` is capped at 64. Unknown sale → `[]`.
    pub fn get_bids(&self, id: U64, from: u16, limit: u8) -> Vec<BidView> {
        let Some(s) = self.sale(id.0) else {
            return Vec::new();
        };
        let end = from.saturating_add(u16::from(limit.min(64))).min(s.bids);
        (from..end)
            .filter_map(|i| self.bids.get(&(id.0, i)).map(|b| bid_view(i, b)))
            .collect()
    }

    /// Clearing (or cancel) result; `null` before finalize/cancel or for an unknown id.
    pub fn get_result(&self, id: U64) -> Option<ResultView> {
        let r = self.sale(id.0)?.result.as_ref()?;
        Some(ResultView {
            p_star: r.p_star.map(U64),
            sold: U128(r.sold),
            seller_usdc: U128(r.seller_usdc),
            seller_tokens_back: U128(r.seller_tokens_back),
            token_dust: U128(r.token_dust),
            penalty_pool: U128(r.penalty_pool),
            block: U64(r.block),
            ns: U64(r.ns),
            cancelled: r.cancelled,
        })
    }

    pub fn get_key_log(&self, from: U64, limit: u8) -> Vec<KeyLogView> {
        let len = self.key_log.len() as u64;
        let end = from.0.saturating_add(limit.min(100) as u64).min(len);
        (from.0..end)
            .filter_map(|i| {
                self.key_log.get(i as u32).map(|k| KeyLogView {
                    i: U64(i),
                    sale: U64(k.sale),
                    block: U64(k.block),
                    ns: U64(k.ns),
                    outcome: k.outcome.as_str().to_string(),
                    resolved_block: k.resolved_block.map(U64),
                })
            })
            .collect()
    }
}

impl Tender {
    pub(crate) fn sale(&self, id: u64) -> Option<&Sale> {
        u32::try_from(id).ok().and_then(|i| self.sales.get(i))
    }

    pub(crate) fn sale_mut(&mut self, id: u64) -> Option<&mut Sale> {
        u32::try_from(id).ok().and_then(|i| self.sales.get_mut(i))
    }

    /// Payout item `idx` of sale `id`: bid `idx`, or the seller's item when `idx == bids`
    /// (WD-03).
    pub(crate) fn payout_mut(&mut self, id: u64, idx: u16) -> Option<&mut Payout> {
        let n = self.sale(id)?.bids;
        if idx < n {
            self.bids.get_mut(&(id, idx)).map(|b| &mut b.paid)
        } else if idx == n {
            self.sale_mut(id).map(|s| &mut s.seller_payout)
        } else {
            None
        }
    }

    /// C16 checks for one opened bid, shared by `reveal` (panics on Err) and the gasless
    /// self-reveal (logs Err). On success the bid is Revealed with `p`, `q`, `salt` and
    /// `revealed_by = by`.
    pub(crate) fn apply_reveal(
        &mut self,
        id: u64,
        item: &RevealItem,
        by: &AccountId,
    ) -> Result<(), String> {
        let now = env::block_timestamp();
        let idx = item.idx;
        let s = self.sale(id).ok_or("sale not found")?;
        if s.state != SaleState::Keyed {
            return Err("sale is not keyed".into());
        }
        if s.reveal_deadline_ns.is_none_or(|d| now >= d) {
            return Err("reveal window closed".into());
        }
        if idx >= s.bids {
            return Err(format!("bid {idx} not found"));
        }
        let bid = self
            .bids
            .get(&(id, idx))
            .ok_or_else(|| format!("bid {idx} not found"))?;
        if bid.state != BidState::Sealed {
            return Err(format!("bid {idx} is not sealed"));
        }
        let (p, q) = (item.p.0, item.q.0);
        if q == 0 || u128::from(q) > bid.escrow {
            return Err(format!("q out of range for bid {idx}"));
        }
        let salt = seal::hex_decode_lower::<16>(&item.salt)
            .ok_or_else(|| format!("salt must be 32 lowercase hex for bid {idx}"))?;
        if seal::commitment(id, bid.bidder.as_str(), bid.escrow, p, q, &salt) != bid.cm {
            return Err(format!("commitment mismatch for bid {idx}"));
        }
        let bid = self.bids.get_mut(&(id, idx)).unwrap();
        bid.p = Some(p);
        bid.q = Some(q);
        bid.salt = Some(salt);
        bid.revealed_by = Some(by.clone());
        bid.state = BidState::Revealed;
        self.sale_mut(id).unwrap().revealed += 1;
        events::emit(
            "reveal",
            json!({
                "sale": id.to_string(),
                "idx": idx,
                "p": p.to_string(),
                "q": q.to_string(),
                "revealed_by": by,
            }),
        );
        Ok(())
    }

    /// First `finalize` of a Keyed sale: clearing + penalty into state, then Finalized.
    fn settle(&mut self, id: u64) {
        let now = env::block_timestamp();
        let s = self.sale(id).unwrap();
        let deadline_passed = s.reveal_deadline_ns.is_some_and(|d| now >= d);
        require!(
            deadline_passed || s.revealed == s.bids,
            "finalize: reveal window still open"
        );
        let (supply, decimals, lot_exp, reserve) = (s.supply, s.decimals, s.lot_exp, s.reserve);
        let (n, escrow_total) = (s.bids, s.escrow_total);
        let input: Vec<clearing::ClearBid> = (0..n)
            .map(|i| {
                let b = self.bids.get(&(id, i)).expect("bid");
                let revealed = match (b.state, b.p, b.q) {
                    (BidState::Revealed, Some(p), Some(q)) => Some((p, q)),
                    _ => None,
                };
                clearing::ClearBid {
                    idx: i,
                    escrow: b.escrow,
                    revealed,
                }
            })
            .collect();
        let out = clearing::clear(supply, decimals, lot_exp, reserve, &input);

        // Conservation: a mismatch is a bug, so panic and revert rather than pay it out.
        let sum = |v: &[u128]| {
            v.iter()
                .try_fold(0u128, |a, &x| a.checked_add(x))
                .expect("finalize: overflow")
        };
        let sold = sum(&out.alloc);
        require!(
            sum(&out.refund).checked_add(out.seller_usdc) == Some(escrow_total)
                && sold.checked_add(out.seller_tokens_back) == Some(supply),
            "finalize: accounting mismatch"
        );

        for i in 0..n {
            let k = usize::from(i);
            let b = self.bids.get_mut(&(id, i)).expect("bid");
            b.alloc = out.alloc[k];
            b.spend = out.spend[k];
            b.penalty = out.penalty[k];
            b.penalty_share = out.penalty_share[k];
            b.state = out.final_state[k];
            b.paid = Payout {
                usdc: out.refund[k],
                tokens: out.alloc[k],
                ok: false,
                pending: false,
            };
            if b.state == BidState::Penalized {
                events::emit(
                    "penalize",
                    json!({
                        "sale": id.to_string(),
                        "idx": i,
                        "bidder": b.bidder,
                        "penalty": b.penalty.to_string(),
                        "refund": out.refund[k].to_string(),
                    }),
                );
            }
        }
        let s = self.sale_mut(id).unwrap();
        s.seller_payout = Payout {
            usdc: out.seller_usdc,
            tokens: out.seller_tokens_back,
            ok: false,
            pending: false,
        };
        s.result = Some(SaleResult {
            p_star: out.p_star,
            sold,
            seller_usdc: out.seller_usdc,
            seller_tokens_back: out.seller_tokens_back,
            token_dust: out.token_dust,
            penalty_pool: out.penalty_pool,
            block: env::block_height(),
            ns: now,
            cancelled: false,
        });
        sale::transition(s, SaleState::Finalized);
        events::emit(
            "finalize",
            json!({
                "sale": id.to_string(),
                "p_star": out.p_star.map(|p| p.to_string()),
                "sold": sold.to_string(),
                "seller_usdc": out.seller_usdc.to_string(),
                "penalty_pool": out.penalty_pool.to_string(),
            }),
        );
    }
}

fn payout_view(p: &Payout) -> PayoutView {
    PayoutView {
        usdc: U128(p.usdc),
        tokens: U128(p.tokens),
        ok: p.ok,
    }
}

fn bid_view(idx: u16, b: &Bid) -> BidView {
    BidView {
        idx,
        bidder: b.bidder.clone(),
        escrow: U128(b.escrow),
        ct: sale::encode_ct(&b.ct),
        cm: seal::hex_lower(&b.cm),
        origin: b.origin.clone(),
        block: U64(b.block),
        ns: U64(b.ns),
        state: b.state.as_str().to_string(),
        p: b.p.map(U64),
        q: b.q.map(U64),
        salt: b.salt.map(|s| seal::hex_lower(&s)),
        revealed_by: b.revealed_by.clone(),
        alloc: U128(b.alloc),
        spend: U128(b.spend),
        penalty: U128(b.penalty),
        penalty_share: U128(b.penalty_share),
        paid: payout_view(&b.paid),
    }
}

fn sale_view(id: u64, s: &Sale) -> SaleView {
    SaleView {
        id: U64(id),
        seller: s.seller.clone(),
        token: s.token.clone(),
        supply: U128(s.supply),
        decimals: s.decimals,
        lot_exp: s.lot_exp,
        reserve: U64(s.reserve),
        min_escrow: U128(s.min_escrow),
        min_bidders: s.min_bidders,
        max_bids: s.max_bids,
        quote_token: s.quote_token.clone(),
        close_ns: U64(s.close_ns),
        reveal_secs: U64(s.reveal_secs),
        created_block: U64(s.created_block),
        created_ns: U64(s.created_ns),
        path: s.path.clone(),
        state: s.state_str().to_string(),
        bids: s.bids,
        bidders: s.bidders,
        escrow_total: U128(s.escrow_total),
        revealed: s.revealed,
        key_requests: s.key_requests,
        in_flight: s.in_flight,
        key: s.key.as_ref().map(|k| KeyView {
            big_y: k.big_y.clone(),
            big_c: k.big_c.clone(),
            block: U64(k.block),
            ns: U64(k.ns),
        }),
        reveal_deadline_ns: s.reveal_deadline_ns.map(U64),
        seller_payout: payout_view(&s.seller_payout),
        payouts_done: s.payouts_done,
        payouts_total: s.bids.saturating_add(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sale::tests::{NOW, SELLER, USDC, ct_b64, ctx, transfer, with_sale};
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::{get_created_receipts, get_logs};
    use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

    const SALT: [u8; 16] = [0x11; 16];
    const SALT_HEX: &str = "11111111111111111111111111111111";
    const KEEPER: &str = "keeper.near";
    const ME: &str = crate::sale::tests::ME;
    /// Inside the reveal window of `key()`.
    const LATER: u64 = NOW + 3 * 3_600 * NS_PER_SEC;

    fn bidder(i: usize) -> String {
        format!("b{i}.near")
    }

    /// Sale 0 (demo parameters) with one sealed bid per (B, p, q) from `b<i>.near`.
    fn sale_with_sealed(bids: &[(u128, u64, u64)]) -> Tender {
        let mut t = with_sale(|_| {});
        for (i, &(b, p, q)) in bids.iter().enumerate() {
            let cm = seal::hex_lower(&seal::commitment(0, &bidder(i), b, p, q, &SALT));
            let msg = json!({ "op": "bid", "sale": "0", "ct": ct_b64(160), "cm": cm });
            let got = transfer(
                &mut t,
                &bidder(i),
                USDC,
                b,
                &msg.to_string(),
                NOW + NS_PER_SEC,
            );
            assert_eq!(got, vec![0]);
        }
        t
    }

    /// Stands in for open + on_key: sale 0 Keyed, key at NOW + 2 h.
    fn key(t: &mut Tender) {
        let key_ns = NOW + 2 * 3_600 * NS_PER_SEC;
        let s = t.sale_mut(0).unwrap();
        s.key = Some(Key {
            big_y: "y".into(),
            big_c: "c".into(),
            block: 100,
            ns: key_ns,
        });
        s.reveal_deadline_ns = Some(sale::reveal_deadline(key_ns, s.reveal_secs));
        sale::transition(s, SaleState::Keyed);
    }

    fn item(idx: u16, p: u64, q: u64, salt: &str) -> RevealItem {
        RevealItem {
            idx,
            p: U64(p),
            q: U64(q),
            salt: salt.into(),
        }
    }

    fn at(who: &str, now: u64) {
        testing_env!(ctx(who, now).build());
    }

    fn demo() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/clearing/demo-sale-1.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn n(v: &Value) -> u128 {
        v.as_str().unwrap().parse().unwrap()
    }

    #[test]
    #[should_panic(expected = "reveal: salt must be 32 lowercase hex for bid 0")]
    fn reveal_rejects_uppercase_salt() {
        let mut t = sale_with_sealed(&[(1_000_000, 3_500_000, 1_000_000)]);
        key(&mut t);
        at(KEEPER, LATER);
        t.reveal(
            U64(0),
            vec![item(0, 3_500_000, 1_000_000, &"AB".repeat(16))],
        );
    }

    #[test]
    #[should_panic(expected = "reveal: commitment mismatch for bid 0")]
    fn reveal_rejects_wrong_commitment() {
        let mut t = sale_with_sealed(&[(1_000_000, 3_500_000, 1_000_000)]);
        key(&mut t);
        at(KEEPER, LATER);
        t.reveal(U64(0), vec![item(0, 3_500_001, 1_000_000, SALT_HEX)]);
    }

    #[test]
    fn reveal_stores_opening() {
        let mut t = sale_with_sealed(&[(1_000_000, 3_500_000, 1_000_000)]);
        key(&mut t);
        at(KEEPER, LATER);
        t.reveal(U64(0), vec![item(0, 3_500_000, 1_000_000, SALT_HEX)]);
        let b = &t.get_bids(U64(0), 0, 64)[0];
        assert_eq!(b.state, "Revealed");
        assert_eq!((b.p.unwrap().0, b.q.unwrap().0), (3_500_000, 1_000_000));
        assert_eq!(b.salt.as_deref(), Some(SALT_HEX));
        assert_eq!(b.revealed_by.as_ref().unwrap().as_str(), KEEPER);
        assert_eq!(t.get_sale(U64(0)).unwrap().revealed, 1);
        assert!(
            get_logs()
                .iter()
                .any(|l| l.contains("\"event\":\"reveal\""))
        );
    }

    #[test]
    #[should_panic(expected = "finalize: reveal window still open")]
    fn finalize_waits_for_deadline_or_all_revealed() {
        let mut t = sale_with_sealed(&[
            (1_000_000, 3_500_000, 1_000_000),
            (1_000_000, 3_500_000, 1_000_000),
        ]);
        key(&mut t);
        at(KEEPER, LATER);
        t.reveal(U64(0), vec![item(0, 3_500_000, 1_000_000, SALT_HEX)]);
        t.finalize(U64(0), 8);
    }

    #[test]
    fn self_reveal_logs_bad_items_and_returns_amount() {
        let mut t = sale_with_sealed(&[
            (1_000_000, 3_500_000, 1_000_000),
            (1_000_000, 3_600_000, 1_000_000),
        ]);
        key(&mut t);
        let msg = json!({ "op": "reveal", "sale": "0", "items": [
            { "idx": 0, "p": "3500000", "q": "1000000", "salt": SALT_HEX },
            { "idx": 1, "p": "1", "q": "1000000", "salt": SALT_HEX },
        ]});
        let got = transfer(&mut t, "anyone.near", USDC, 1, &msg.to_string(), LATER);
        assert_eq!(got, vec![1]);
        let bids = t.get_bids(U64(0), 0, 64);
        assert_eq!(
            (bids[0].state.as_str(), bids[1].state.as_str()),
            ("Revealed", "Sealed")
        );
        assert_eq!(
            bids[0].revealed_by.as_ref().unwrap().as_str(),
            "anyone.near"
        );
        assert!(
            get_logs()
                .iter()
                .any(|l| l == "self-reveal: 1: commitment mismatch for bid 1")
        );
    }

    /// Demo sale #1 through the contract path: reveal, early finalize, payouts recorded and
    /// sent once, `get_result` and `get_bids` equal to `fixtures/clearing/demo-sale-1.json`.
    #[test]
    fn finalize_accounting_matches_fixture_demo() {
        let f = demo();
        let fb = f["bids"].as_array().unwrap();
        let bids: Vec<(u128, u64, u64)> = fb
            .iter()
            .map(|b| (n(&b["B"]), n(&b["p"]) as u64, n(&b["q"]) as u64))
            .collect();
        let mut t = sale_with_sealed(&bids);
        key(&mut t);
        at(KEEPER, LATER);
        let items = bids
            .iter()
            .enumerate()
            .map(|(i, &(_, p, q))| item(i as u16, p, q, SALT_HEX))
            .collect();
        t.reveal(U64(0), items);
        t.finalize(U64(0), 8);
        // 7 payout items (6 bids + seller), each a transfer and its callback.
        assert_eq!(get_created_receipts().len(), 14);

        let e = &f["expected"];
        let r = t.get_result(U64(0)).unwrap();
        assert_eq!(r.p_star.map(|p| p.0 as u128), Some(n(&e["P_star"])));
        assert_eq!(r.seller_usdc.0, n(&e["seller_usdc"]));
        assert_eq!(r.seller_tokens_back.0, n(&e["seller_tokens_back"]));
        assert_eq!(r.token_dust.0, n(&e["dust"]));
        assert!(!r.cancelled);
        let views = t.get_bids(U64(0), 0, 64);
        for (i, b) in views.iter().enumerate() {
            assert_eq!(b.alloc.0, n(&e["alloc"][i]), "alloc {i}");
            assert_eq!(b.spend.0, n(&e["spend"][i]), "spend {i}");
            assert_eq!(b.paid.usdc.0, n(&e["refund"][i]), "refund {i}");
            assert_eq!(b.paid.tokens.0, n(&e["alloc"][i]), "tokens {i}");
            assert_eq!(b.state, e["final_state"][i].as_str().unwrap());
        }
        let s = t.get_sale(U64(0)).unwrap();
        assert_eq!(s.state, "Finalized");
        assert_eq!(s.seller_payout.usdc.0, n(&e["seller_usdc"]));
        assert_eq!((s.payouts_done, s.payouts_total), (0, 7));

        // Everything is in flight: a second finalize sends nothing (no double payout).
        at(KEEPER, LATER);
        t.finalize(U64(0), 8);
        assert!(get_created_receipts().is_empty());

        // Bid 0 paid; bid 1 failed and goes back to unpaid; the next finalize retries only it.
        testing_env!(
            ctx(ME, LATER).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        t.on_paid(U64(0), 0);
        testing_env!(
            ctx(ME, LATER).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        t.on_paid(U64(0), 1);
        let bids = t.get_bids(U64(0), 0, 2);
        assert!(bids[0].paid.ok && !bids[1].paid.ok);
        assert_eq!(t.get_sale(U64(0)).unwrap().payouts_done, 1);
        at(KEEPER, LATER);
        t.finalize(U64(0), 8);
        assert_eq!(get_created_receipts().len(), 2);
    }

    #[test]
    fn views_cap_limits_and_unknown_ids() {
        let mut t = sale_with_sealed(&[(1_000_000, 1, 1)]);
        at(SELLER, NOW);
        assert!(t.get_sale(U64(9)).is_none());
        assert!(t.get_result(U64(0)).is_none());
        assert!(t.get_bids(U64(9), 0, 64).is_empty());
        assert_eq!(t.get_bids(U64(0), 0, 255).len(), 1);
        assert_eq!(t.get_sales(U64(0), 255).len(), 1);
        assert!(t.get_sales(U64(1), 50).is_empty());
        key(&mut t);
        assert_eq!(t.get_sale(U64(0)).unwrap().state, "Keyed");
    }
}
