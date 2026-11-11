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

/// D4: a `dup_bid` / `bid_seq` refund that also names the refused bid's `cm`, the sender's
/// stored bid count `have` and, for a duplicate, the stored copy's `idx` (null otherwise), so a
/// client holding only the tx can tell what happened to its bid.
fn refund_bid(
    reason: &str,
    sender: &AccountId,
    token: &str,
    amounts: &[U128],
    cm: &str,
    have: u16,
    idx: Option<u16>,
) -> Vec<U128> {
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
            "op": "bid",
            "cm": cm,
            "have": have,
            "idx": idx,
        }),
    );
    amounts.to_vec()
}

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
        // D-01/D-02, before any state change: the same commitment from the same sender is one
        // bid, and a bid that carries `seq` must match the sender's stored count. Only a sender
        // who already bid in this sale is scanned (at most max_bids - 1 reads). Per sender, so
        // nobody can block someone else's bid.
        let (mine, dup) = if self.bidder_seen.contains(&(sale_id, sender.clone())) {
            self.bids_of(sale_id, sender, &p.cm)
        } else {
            (0, None)
        };
        let cm_hex = hex_lower(&p.cm);
        if let Some(i) = dup {
            return refund_bid("dup_bid", sender, token, &amounts, &cm_hex, mine, Some(i));
        }
        if m.seq.is_some_and(|n| n != mine) {
            return refund_bid("bid_seq", sender, token, &amounts, &cm_hex, mine, None);
        }
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
                "cm": cm_hex,
                "nth": mine,
            }),
        );
        vec![U128(0)]
    }

    /// D-01/D-02: how many bids `sender` has in sale `id`, and the index of the first one whose
    /// commitment is `cm`.
    fn bids_of(&self, id: u64, sender: &AccountId, cm: &[u8; 32]) -> (u16, Option<u16>) {
        let n = self.sale(id).map_or(0, |s| s.bids);
        let (mut mine, mut dup) = (0u16, None);
        for i in 0..n {
            if let Some(b) = self.bids.get(&(id, i))
                && &b.bidder == sender
            {
                mine += 1;
                if dup.is_none() && &b.cm == cm {
                    dup = Some(i);
                }
            }
        }
        (mine, dup)
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

#[cfg(test)]
mod tests {
    //! D-01/D-02 (DOUBLE-PLAN D1 + D4): one sender's copy of a stored commitment, or a bid
    //! whose `seq` is not the sender's stored count, is refunded in full and changes nothing.
    use crate::Tender;
    use crate::sale::tests::{NOW, USDC, ct_b64, ctx, transfer, with_sale};
    use crate::sale::{self, Key, NS_PER_SEC, RevealItem, SaleState};
    use crate::seal;
    use near_sdk::json_types::U64;
    use near_sdk::serde_json::{self, Value, json};
    use near_sdk::test_utils::get_logs;
    use near_sdk::testing_env;

    const SALT: [u8; 16] = [0x11; 16];
    const SALT_HEX: &str = "11111111111111111111111111111111";
    const LATER: u64 = NOW + 3 * 3_600 * NS_PER_SEC;

    fn cm(bidder: &str, b: u128, p: u64, salt: u8) -> String {
        seal::hex_lower(&seal::commitment(0, bidder, b, p, 1_000_000, &[salt; 16]))
    }

    fn msg(cm: &str, seq: Option<u16>) -> String {
        let mut m = json!({ "op": "bid", "sale": "0", "ct": ct_b64(160), "cm": cm });
        if let Some(n) = seq {
            m["seq"] = json!(n);
        }
        m.to_string()
    }

    fn send(t: &mut Tender, who: &str, b: u128, m: &str, k: u64) -> Vec<u128> {
        transfer(t, who, USDC, b, m, NOW + k * NS_PER_SEC)
    }

    fn last(event: &str) -> Option<Value> {
        get_logs().iter().rev().find_map(|l| {
            let v: Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:")?).ok()?;
            (v["event"] == event).then(|| v["data"][0].clone())
        })
    }

    fn reason() -> Option<String> {
        last("refund").map(|e| e["reason"].as_str().unwrap_or("").to_string())
    }

    fn counts(t: &Tender) -> (u16, u16, u128) {
        let s = t.get_sale(U64(0)).unwrap();
        (s.bids, s.bidders, s.escrow_total.0)
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

    fn at(who: &str, now: u64) {
        testing_env!(ctx(who, now).build());
    }

    fn sealed_bid(bidder: &str, b: u128, p: u64, q: u64) -> String {
        let cm = seal::hex_lower(&seal::commitment(0, bidder, b, p, q, &SALT));
        json!({ "op": "bid", "sale": "0", "ct": ct_b64(160), "cm": cm }).to_string()
    }

    fn one_bidder_sale() -> Tender {
        with_sale(|m| {
            m["min_bidders"] = json!(1);
            m["min_escrow"] = json!("1000000");
        })
    }

    /// d1 (X12-03 / R2): the same sealed bid sent twice (two signatures, two Intents nonces).
    /// Before D1 both copies were stored, anyone could reveal the twin with the public opening
    /// and the bidder bought and paid twice. Now the second copy is refunded `dup_bid` and the
    /// bidder wins and pays once.
    #[test]
    fn d1_same_sealed_bid_twice_is_stored_once() {
        let mut t = one_bidder_sale();
        let m = sealed_bid("alice.near", 5_000_000, 3_500_000, 2_000_000);
        assert_eq!(send(&mut t, "alice.near", 5_000_000, &m, 1), vec![0]);
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &m, 2),
            vec![5_000_000]
        );
        assert_eq!(reason().as_deref(), Some("dup_bid"));
        assert_eq!(counts(&t), (1, 1, 5_000_000));

        key(&mut t);
        at("alice.near", LATER);
        let item = RevealItem {
            idx: 0,
            p: U64(3_500_000),
            q: U64(2_000_000),
            salt: SALT_HEX.into(),
        };
        t.reveal(U64(0), vec![item]);
        at("keeper.near", LATER);
        t.finalize(U64(0), 8);
        let b = t.get_bids(U64(0), 0, 64);
        assert_eq!(b.len(), 1);
        assert!(b[0].alloc.0 > 0);
        assert_eq!(t.get_result(U64(0)).unwrap().sold.0, b[0].alloc.0);
    }

    /// d1b: before D1 the unrevealed twin of a revealed bid was Penalized (10% kept). Now there
    /// is no twin: nothing is Penalized and the penalty pool stays 0.
    #[test]
    fn d1b_no_unrevealed_twin_to_penalize() {
        let mut t = one_bidder_sale();
        let m = sealed_bid("alice.near", 5_000_000, 3_500_000, 2_000_000);
        send(&mut t, "alice.near", 5_000_000, &m, 1);
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &m, 2),
            vec![5_000_000]
        );
        key(&mut t);
        at("alice.near", LATER);
        let item = RevealItem {
            idx: 0,
            p: U64(3_500_000),
            q: U64(2_000_000),
            salt: SALT_HEX.into(),
        };
        t.reveal(U64(0), vec![item]);
        let deadline = t.get_sale(U64(0)).unwrap().reveal_deadline_ns.unwrap().0;
        at("keeper.near", deadline);
        t.finalize(U64(0), 8);
        let b = t.get_bids(U64(0), 0, 64);
        assert!(
            b.iter().all(|x| x.state != "Penalized"),
            "no twin penalized"
        );
        assert_eq!(t.get_result(U64(0)).unwrap().penalty_pool.0, 0);
    }

    /// The same (sender, cm) twice, with or without seq: refunded `dup_bid`, nothing stored.
    #[test]
    fn i1_same_sender_same_cm_is_refunded() {
        let mut t = with_sale(|_| {});
        let c = cm("alice.near", 5_000_000, 3_500_000, 1);
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&c, None), 1),
            vec![0]
        );
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&c, None), 2),
            vec![5_000_000]
        );
        assert_eq!(reason().as_deref(), Some("dup_bid"));
        assert_eq!(counts(&t), (1, 1, 5_000_000));
    }

    /// Two different commitments prepared from one view of the sale carry the same seq: the
    /// second is refunded `bid_seq`.
    #[test]
    fn i2_same_seq_different_cm_is_refunded() {
        let mut t = with_sale(|_| {});
        let a = cm("alice.near", 5_000_000, 3_500_000, 1);
        let b = cm("alice.near", 5_000_000, 3_600_000, 2);
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&a, Some(0)), 1),
            vec![0]
        );
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&b, Some(0)), 2),
            vec![5_000_000]
        );
        assert_eq!(reason().as_deref(), Some("bid_seq"));
        assert_eq!(counts(&t), (1, 1, 5_000_000));
    }

    /// A deliberate second bid with seq = the stored count is stored; a seq from the future is
    /// refunded too, so a gap cannot hide a race.
    #[test]
    fn i3_next_seq_is_a_second_real_bid() {
        let mut t = with_sale(|_| {});
        let a = cm("alice.near", 5_000_000, 3_500_000, 1);
        let b = cm("alice.near", 5_000_000, 3_600_000, 2);
        let c = cm("alice.near", 5_000_000, 3_700_000, 3);
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&a, Some(0)), 1),
            vec![0]
        );
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&c, Some(2)), 2),
            vec![5_000_000]
        );
        assert_eq!(reason().as_deref(), Some("bid_seq"));
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&b, Some(1)), 3),
            vec![0]
        );
        assert_eq!(counts(&t), (2, 1, 10_000_000));
    }

    /// Per sender: another account's copy of a cm, and its own bids, never block a bid; a bid
    /// refused for another reason does not use up a seq.
    #[test]
    fn i4_other_senders_do_not_block() {
        let mut t = with_sale(|_| {});
        let a = cm("alice.near", 5_000_000, 3_500_000, 1);
        let m9 = cm("mallory.near", 2_000_000, 1, 9);
        assert_eq!(
            send(&mut t, "mallory.near", 5_000_000, &msg(&a, Some(0)), 1),
            vec![0]
        );
        assert_eq!(
            send(&mut t, "mallory.near", 2_000_000, &msg(&m9, Some(1)), 2),
            vec![0]
        );
        assert_eq!(send(&mut t, "alice.near", 1, &msg(&a, Some(0)), 3), vec![1]);
        assert_eq!(reason().as_deref(), Some("escrow_below_min"));
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&a, Some(0)), 4),
            vec![0]
        );
        assert_eq!(counts(&t), (3, 2, 12_000_000));
    }

    /// A refused duplicate leaves no trace: no bidder count, escrow or reserved bytes.
    #[test]
    fn i5_refund_changes_no_state() {
        let mut t = with_sale(|_| {});
        let a = cm("alice.near", 5_000_000, 3_500_000, 1);
        send(&mut t, "alice.near", 5_000_000, &msg(&a, Some(0)), 1);
        let reserved = t.reserved_bytes;
        let other = cm("alice.near", 5_000_000, 1, 7);
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&a, Some(0)), 2),
            vec![5_000_000]
        );
        assert_eq!(
            send(&mut t, "alice.near", 5_000_000, &msg(&other, Some(0)), 3),
            vec![5_000_000]
        );
        assert_eq!(t.reserved_bytes, reserved);
        assert_eq!(counts(&t), (1, 1, 5_000_000));
    }

    /// A copy of a stored cm is `dup_bid` whatever its seq says.
    #[test]
    fn i6_dup_wins_over_seq() {
        let mut t = with_sale(|_| {});
        let a = cm("alice.near", 2_000_000, 1, 1);
        assert_eq!(
            send(&mut t, "alice.near", 2_000_000, &msg(&a, Some(0)), 1),
            vec![0]
        );
        for seq in [Some(0), Some(1), Some(5), None] {
            assert_eq!(
                send(&mut t, "alice.near", 2_000_000, &msg(&a, seq), 2),
                vec![2_000_000]
            );
            assert_eq!(reason().as_deref(), Some("dup_bid"), "seq {seq:?}");
        }
        assert_eq!(counts(&t).0, 1);
    }

    /// D4: the bid event names cm and the sender's nth bid; the two new refunds name cm,
    /// `have` and (dup_bid only) the stored copy's idx.
    #[test]
    fn i7_outcome_events_name_cm_and_count() {
        let mut t = with_sale(|_| {});
        let a = cm("alice.near", 2_000_000, 1, 1);
        let b = cm("alice.near", 2_000_000, 2, 2);
        let bob = cm("bob.near", 2_000_000, 1, 9);
        assert_eq!(
            send(&mut t, "bob.near", 2_000_000, &msg(&bob, None), 1),
            vec![0]
        );
        assert_eq!(
            send(&mut t, "alice.near", 2_000_000, &msg(&a, Some(0)), 1),
            vec![0]
        );
        let e = last("bid").unwrap();
        assert_eq!(
            (e["cm"].as_str(), e["nth"].as_u64(), e["idx"].as_u64()),
            (Some(a.as_str()), Some(0), Some(1))
        );
        send(&mut t, "alice.near", 2_000_000, &msg(&a, Some(0)), 2);
        let e = last("refund").unwrap();
        assert_eq!(
            (
                e["reason"].as_str(),
                e["op"].as_str(),
                e["cm"].as_str(),
                e["have"].as_u64(),
                e["idx"].as_u64()
            ),
            (
                Some("dup_bid"),
                Some("bid"),
                Some(a.as_str()),
                Some(1),
                Some(1)
            )
        );
        assert_eq!(e["amount"], "2000000");
        send(&mut t, "alice.near", 2_000_000, &msg(&b, Some(0)), 2);
        let e = last("refund").unwrap();
        assert_eq!(
            (e["reason"].as_str(), e["cm"].as_str(), e["have"].as_u64()),
            (Some("bid_seq"), Some(b.as_str()), Some(1))
        );
        assert!(e["idx"].is_null());
        assert_eq!(
            send(&mut t, "alice.near", 2_000_000, &msg(&b, Some(1)), 3),
            vec![0]
        );
        assert_eq!(last("bid").unwrap()["nth"].as_u64(), Some(1));
    }

    /// `seq` is a JSON number: a string (`"0"`) is refunded `bad_msg`, as posted to clients.
    #[test]
    fn i8_string_seq_is_bad_msg() {
        let mut t = with_sale(|_| {});
        let mut m: Value =
            serde_json::from_str(&msg(&cm("alice.near", 2_000_000, 1, 1), None)).unwrap();
        m["seq"] = json!("0");
        assert_eq!(
            send(&mut t, "alice.near", 2_000_000, &m.to_string(), 1),
            vec![2_000_000]
        );
        assert_eq!(reason().as_deref(), Some("bad_msg"));
        assert_eq!(counts(&t), (0, 0, 0));
    }
}
