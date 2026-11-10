//! NEP-245 receiver for `intents.near`: sale creation, bids and gasless self-reveals arrive as
//! `mt_on_transfer`; payouts leave through `mt_batch_transfer` and come back to `on_paid`.
//! It never panics: any failure returns the full amount (Intents refunds it) and emits a
//! `refund` event with the reason (C21).
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, Gas, GasWeight, NearToken, PromiseError, env, near};

use crate::sale::{
    self, Bid, BidMsg, BidState, CreateCtx, CreateMsg, MAX_SELF_REVEAL_ITEMS, MAX_SELF_REVEAL_MSG,
    Payout, RevealMsg, Sale, SaleState,
};
use crate::seal::hex_lower;
use crate::{
    BID_STORAGE_BYTES, CREATE_STORAGE_BYTES, OPEN_STORAGE_BYTES, REVEAL_STORAGE_BYTES, Tender,
    TenderExt, events, storage_ok,
};

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
        // No valid msg is longer; checked before parsing so a long op is never echoed into the
        // refund event (whose log limit would make this method panic).
        if msg.len() > MAX_SELF_REVEAL_MSG {
            return refund("msg_too_long", &sender_id, &token, &amounts, "");
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
            "reveal" => self.do_self_reveal(&sender_id, &token, amount, v),
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
        // F6: also room for this sale's open, on top of what earlier sales keep back.
        if !storage_ok(CREATE_STORAGE_BYTES + OPEN_STORAGE_BYTES + self.reserved_bytes) {
            return refund("storage", sender, token, &amounts, "create");
        }
        self.reserved_bytes += OPEN_STORAGE_BYTES;
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
            pay_cursor: 0,
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
            // SC-01: no shill bid (or bidder count) from the seller's own account.
            Some(s) if &s.seller == sender => Err("seller_bid"),
            Some(s) => sale::validate_bid(s, token, amount, msg_len, &m, now),
        };
        let p = match parsed {
            Ok(p) => p,
            Err(reason) => return refund(reason, sender, token, &amounts, "bid"),
        };
        // F6: also room for this bid's reveal, on top of what open sales keep back.
        if !storage_ok(BID_STORAGE_BYTES + REVEAL_STORAGE_BYTES + self.reserved_bytes) {
            return refund("storage", sender, token, &amounts, "bid");
        }
        self.reserved_bytes += REVEAL_STORAGE_BYTES;
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

    /// Sends the next `max` payout items of a Finalized or Cancelled sale that are neither paid
    /// nor in flight (WD-03): items 0..bids are the bids, item `bids` is the seller. An item
    /// with nothing to pay is marked paid at once. `pending` is set before the promise so a
    /// second call in the same block cannot pay an item twice. The scan starts after the last
    /// item sent (wrapping), so items that keep failing cannot starve later ones (S-03).
    pub(crate) fn pay_next(&mut self, id: u64, max: u8) {
        let Some(s) = self.sale(id) else {
            return;
        };
        let (n, quote, token, seller, start) = (
            s.bids,
            s.quote_token.clone(),
            s.token.clone(),
            s.seller.clone(),
            s.pay_cursor,
        );
        let mut sent = 0u8;
        let mut zero = 0u16;
        let mut cursor = start;
        for k in 0..=n {
            if sent >= max {
                break;
            }
            let idx = (start + k) % (n + 1);
            let receiver = if idx < n {
                match self.bids.get(&(id, idx)) {
                    Some(b) => b.bidder.clone(),
                    None => continue,
                }
            } else {
                seller.clone()
            };
            let Some(p) = self.payout_mut(id, idx) else {
                continue;
            };
            if p.ok || p.pending {
                continue;
            }
            let (usdc, tokens) = (p.usdc, p.tokens);
            if usdc == 0 && tokens == 0 {
                p.ok = true;
                zero += 1;
                emit_payout(id, idx, true, 0, 0);
                continue;
            }
            p.pending = true;
            let mut ids = Vec::new();
            let mut amounts = Vec::new();
            if usdc > 0 {
                ids.push(quote.as_str());
                amounts.push(U128(usdc));
            }
            if tokens > 0 {
                ids.push(token.as_str());
                amounts.push(U128(tokens));
            }
            send_payout(&self.intents, id, idx, &receiver, &ids, &amounts);
            sent += 1;
            cursor = (idx + 1) % (n + 1);
        }
        let s = self.sale_mut(id).unwrap();
        s.pay_cursor = cursor;
        s.payouts_done += zero;
        if s.payouts_done > n {
            env::log_str("finalize: all payouts done");
        }
    }

    /// Gasless self-reveal (C17, K4, WD-13): a 1 micro-USDC transfer whose msg carries opened
    /// bids. Accepted from anyone; each item is tried on its own and an invalid one is logged,
    /// never panicked. The transfer always goes back in full.
    fn do_self_reveal(
        &mut self,
        sender: &AccountId,
        token: &str,
        amount: u128,
        v: Value,
    ) -> Vec<U128> {
        let amounts = [U128(amount)];
        let Ok(m) = serde_json::from_value::<RevealMsg>(v) else {
            return refund("bad_msg", sender, token, &amounts, "reveal");
        };
        let id = m.sale.0;
        let Some(s) = self.sale(id) else {
            return refund("no_sale", sender, token, &amounts, "reveal");
        };
        if token != s.quote_token {
            return refund("wrong_token", sender, token, &amounts, "reveal");
        }
        if m.items.is_empty() || m.items.len() > MAX_SELF_REVEAL_ITEMS {
            return refund("reveal_items", sender, token, &amounts, "reveal");
        }
        for item in &m.items {
            if let Err(e) = self.apply_reveal(id, item, sender) {
                env::log_str(&format!("self-reveal: {}: {e}", item.idx));
            }
        }
        amounts.to_vec()
    }
}

#[near]
impl Tender {
    /// Result of one payout transfer (K8): paid, or back to unpaid so the next `finalize`
    /// retries it. Never panics.
    #[private]
    pub fn on_paid(&mut self, sale: U64, idx: u16) {
        let id = sale.0;
        // The transfer returns nothing; only a failed promise means it did not happen.
        let ok = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        let Some(p) = self.payout_mut(id, idx) else {
            env::log_str("on_paid: unknown payout item");
            return;
        };
        if !p.pending {
            env::log_str("on_paid: stale callback");
            return;
        }
        p.pending = false;
        p.ok = ok;
        let (usdc, tokens) = (p.usdc, p.tokens);
        if ok && let Some(s) = self.sale_mut(id) {
            s.payouts_done += 1;
        }
        emit_payout(id, idx, ok, usdc, tokens);
    }
}

/// C14: per-payout gas. `on_paid` gets ≥ 4 × what it uses (2.04 Tgas measured, C-06): if it ran
/// out of gas its item would stay pending and never be retried. 8 payouts reserve 240 Tgas,
/// which still fits a 300 Tgas `finalize` with the first call's clearing (23.6 Tgas, 64 bids).
const PAYOUT_GAS: Gas = Gas::from_tgas(20);
pub const ON_PAID_GAS: Gas = Gas::from_tgas(10);

/// `intents.mt_batch_transfer` (exactly 1 yocto from this contract's balance), then
/// `on_paid(sale, idx)`.
fn send_payout(
    intents: &AccountId,
    sale: u64,
    idx: u16,
    receiver: &AccountId,
    token_ids: &[&str],
    amounts: &[U128],
) {
    let args = json!({
        "receiver_id": receiver,
        "token_ids": token_ids,
        "amounts": amounts,
        "memo": format!("tender:{sale}:{idx}"),
    });
    let p = env::promise_batch_create(intents);
    env::promise_batch_action_function_call_weight(
        p,
        "mt_batch_transfer",
        args.to_string().as_bytes(),
        NearToken::from_yoctonear(1),
        PAYOUT_GAS,
        GasWeight(0),
    );
    let then = env::promise_batch_then(p, &env::current_account_id());
    let cb = json!({ "sale": sale.to_string(), "idx": idx });
    env::promise_batch_action_function_call_weight(
        then,
        "on_paid",
        cb.to_string().as_bytes(),
        NearToken::from_yoctonear(0),
        ON_PAID_GAS,
        GasWeight(0),
    );
}

fn emit_payout(sale: u64, idx: u16, ok: bool, usdc: u128, tokens: u128) {
    events::emit(
        "payout",
        json!({
            "sale": sale.to_string(),
            "idx": idx,
            "ok": ok,
            "usdc": usdc.to_string(),
            "tokens": tokens.to_string(),
        }),
    );
}
