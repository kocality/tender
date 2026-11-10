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
    AppPkMode, Bid, Key, KeyOutcome, KeyReq, NS_PER_SEC, Payout, Sale, SaleResult, SaleState,
};

pub const VERSION: &str = "1.0.0";
/// C26: every state-growing path keeps at least this much free balance after storage.
pub const STORAGE_RESERVE_YOCTO: u128 = 300_000_000_000_000_000_000_000;
/// Storage estimate for one new sale (C26; checked against the measured value in WS1-T11).
pub const CREATE_STORAGE_BYTES: u64 = 800;
/// Storage estimate for one new bid incl. its bidder-seen entry (C26).
pub const BID_STORAGE_BYTES: u64 = 600;

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

    pub fn get_sale(&self, id: U64) -> Option<SaleView> {
        self.sale(id.0).map(|s| sale_view(id.0, s))
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
        seller_payout: PayoutView {
            usdc: U128(s.seller_payout.usdc),
            tokens: U128(s.seller_payout.tokens),
            ok: s.seller_payout.ok,
        },
        payouts_done: s.payouts_done,
        payouts_total: s.bids.saturating_add(1),
    }
}
