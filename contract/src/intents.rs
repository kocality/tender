//! NEP-245 receiver for `intents.near`: sale creation and bids arrive as `mt_on_transfer`.
//! It never panics: any failure returns the full amount (Intents refunds it) and emits a
//! `refund` event with the reason (C21).
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, env, near};

use crate::sale::{self, Bid, BidMsg, BidState, CreateCtx, CreateMsg, Payout, Sale, SaleState};
use crate::seal::hex_lower;
use crate::{BID_STORAGE_BYTES, CREATE_STORAGE_BYTES, Tender, TenderExt, events, storage_ok};

fn refund(reason: &str, sender: &AccountId, token: &str, amounts: &[U128], op: &str) -> Vec<U128> {
    let amount = amounts
        .iter()
        .map(|a| a.0.to_string())
        .collect::<Vec<_>>()
        .join(",");
    events::emit(
        "refund",
        json!({
            "reason": reason,
            "sender_id": sender,
            "token_id": token,
            "amount": amount,
            "op": op,
        }),
    );
    amounts.to_vec()
}

#[near]
impl Tender {
    /// Called by `intents.near` after a `Transfer` intent with `msg`, or after a direct
    /// `mt_transfer_call`. Returns the amount to refund (`[0]` keeps everything).
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        let token = token_ids.first().cloned().unwrap_or_default();
        if env::predecessor_account_id() != self.intents {
            return refund("not_from_intents", &sender_id, &token, &amounts, "");
        }
        if token_ids.len() != 1 || amounts.len() != 1 || previous_owner_ids != [sender_id.clone()] {
            return refund("bad_shape", &sender_id, &token, &amounts, "");
        }
        let amount = amounts[0].0;
        let parsed: Option<Value> = serde_json::from_str(&msg).ok();
        let op = parsed
            .as_ref()
            .and_then(|v| v.get("op"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(v) = parsed else {
            return refund("bad_msg", &sender_id, &token, &amounts, "");
        };
        match op.as_str() {
            "create" => self.do_create(&sender_id, &token, amount, v),
            "bid" => self.do_bid(&sender_id, &token, amount, msg.len(), v),
            "reveal" => self.do_self_reveal(&sender_id, &token, amount, msg.len(), v),
            _ => refund("bad_msg", &sender_id, &token, &amounts, &op),
        }
    }
}

impl Tender {
    /// C5, C6, C11, C20, C30, WD-01.
    fn do_create(&mut self, sender: &AccountId, token: &str, amount: u128, v: Value) -> Vec<U128> {
        let amounts = [U128(amount)];
        let Ok(m) = serde_json::from_value::<CreateMsg>(v) else {
            return refund("bad_msg", sender, token, &amounts, "create");
        };
        let now = env::block_timestamp();
        let ctx = CreateCtx {
            sender,
            token,
            amount,
            now_ns: now,
            sellers: &self.sellers,
            quote_tokens: &self.quote_tokens,
        };
        if let Err(reason) = sale::validate_create(&ctx, &m) {
            return refund(reason, sender, token, &amounts, "create");
        }
        if !storage_ok(CREATE_STORAGE_BYTES) {
            return refund("storage", sender, token, &amounts, "create");
        }
        let id = self.sales.len() as u64;
        let seed = env::random_seed_array();
        let path = format!("tender/{id}/{}", hex_lower(&seed[..16]));
        self.sales.push(Sale {
            seller: sender.clone(),
            token: token.to_string(),
            supply: amount,
            decimals: m.decimals,
            lot_exp: m.lot_exp,
            reserve: m.reserve.0,
            min_escrow: m.min_escrow.0,
            min_bidders: m.min_bidders,
            max_bids: m.max_bids,
            quote_token: m.quote_token,
            close_ns: m.close_ns.0,
            reveal_secs: m.reveal_secs.0,
            created_block: env::block_height(),
            created_ns: now,
            path: path.clone(),
            state: SaleState::Open,
            bids: 0,
            bidders: 0,
            escrow_total: 0,
            revealed: 0,
            key_requests: 0,
            in_flight: false,
            pending_log: None,
            key: None,
            reveal_deadline_ns: None,
            result: None,
            seller_payout: Payout::default(),
            payouts_done: 0,
        });
        events::emit(
            "create",
            json!({
                "sale": id.to_string(),
                "seller": sender,
                "token": token,
                "supply": amount.to_string(),
                "close_ns": m.close_ns,
                "path": path,
            }),
        );
        vec![U128(0)]
    }

    /// C7, C8, K9, WD-11.
    fn do_bid(
        &mut self,
        sender: &AccountId,
        token: &str,
        amount: u128,
        msg_len: usize,
        v: Value,
    ) -> Vec<U128> {
        let amounts = [U128(amount)];
        let Ok(m) = serde_json::from_value::<BidMsg>(v) else {
            return refund("bad_msg", sender, token, &amounts, "bid");
        };
        let sale_id = m.sale.0;
        let now = env::block_timestamp();
        let parsed = match self.sale(sale_id) {
            None => Err("no_sale"),
            Some(s) => sale::validate_bid(s, token, amount, msg_len, &m, now),
        };
        let p = match parsed {
            Ok(p) => p,
            Err(reason) => return refund(reason, sender, token, &amounts, "bid"),
        };
        if !storage_ok(BID_STORAGE_BYTES) {
            return refund("storage", sender, token, &amounts, "bid");
        }
        let new_bidder = self.bidder_seen.insert((sale_id, sender.clone()));
        let Some(s) = self.sale_mut(sale_id) else {
            return refund("no_sale", sender, token, &amounts, "bid");
        };
        let idx = s.bids;
        s.bids += 1;
        if new_bidder {
            s.bidders += 1;
        }
        // validate_bid checked escrow_total + amount ≤ 10^12.
        s.escrow_total += amount;
        self.bids.insert(
            (sale_id, idx),
            Bid {
                bidder: sender.clone(),
                escrow: amount,
                ct: p.ct,
                cm: p.cm,
                origin: p.origin.clone(),
                block: env::block_height(),
                ns: now,
                state: BidState::Sealed,
                p: None,
                q: None,
                salt: None,
                revealed_by: None,
                alloc: 0,
                spend: 0,
                penalty: 0,
                penalty_share: 0,
                paid: Payout::default(),
            },
        );
        events::emit(
            "bid",
            json!({
                "sale": sale_id.to_string(),
                "idx": idx,
                "bidder": sender,
                "escrow": amount.to_string(),
                "origin": p.origin,
            }),
        );
        vec![U128(0)]
    }

    /// Pays the next `max` unpaid payout items of a Finalized or Cancelled sale (WD-03).
    /// Not wired yet: payouts are recorded in state but not sent.
    pub(crate) fn pay_next(&mut self, _sale: u64, _max: u8) {}

    /// Gasless self-reveal (C17): not wired yet; refunds the transfer.
    fn do_self_reveal(
        &mut self,
        sender: &AccountId,
        token: &str,
        amount: u128,
        _msg_len: usize,
        _v: Value,
    ) -> Vec<U128> {
        refund(
            "reveal_unavailable",
            sender,
            token,
            &[U128(amount)],
            "reveal",
        )
    }
}
