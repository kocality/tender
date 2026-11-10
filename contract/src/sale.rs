//! Sale, bid and key-ledger types, the create/bid validations and the state machine.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Deserialize;
use near_sdk::{AccountId, near};

use crate::seal::hex_decode_lower;

pub const NS_PER_SEC: u64 = 1_000_000_000;
pub const MIN_REVEAL_SECS: u64 = 86_400;
pub const MAX_REVEAL_SECS: u64 = 604_800;
pub const MIN_CLOSE_DELAY_SECS: u64 = 300;
pub const MAX_CLOSE_DELAY_SECS: u64 = 30 * 86_400;
pub const MAX_BIDS: u16 = 64;
pub const MAX_DECIMALS: u8 = 24;
/// `decimals + lot_exp ≤ 26` keeps `Q · 10^(d+lot_exp)` under 10^38 (fits u128).
pub const MAX_SCALE_EXP: u8 = 26;
/// WD-01: supply in base units, 1 ≤ S ≤ 10^26.
pub const MAX_SUPPLY: u128 = 100_000_000_000_000_000_000_000_000;
/// C8: a bid escrows at least 1 USDC (micro-USDC units).
pub const MIN_ESCROW_PER_BID: u128 = 1_000_000;
/// C8: total escrow of one sale ≤ 10^12 micro-USDC (1M USDC).
pub const MAX_ESCROW_TOTAL: u128 = 1_000_000_000_000;
pub const MAX_BID_MSG: usize = 512;
pub const CT_LEN: usize = 160;
pub const MAX_ORIGIN_LEN: usize = 8;

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppPkMode {
    Identity,
    Generator,
    Plain,
}

impl AppPkMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "identity" => Some(Self::Identity),
            "generator" => Some(Self::Generator),
            "plain" => Some(Self::Plain),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Generator => "generator",
            Self::Plain => "plain",
        }
    }
}

/// "Opening" is not stored: it is `Open` with a key request in flight (WD-14).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaleState {
    Open,
    Keyed,
    Finalized,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BidState {
    Sealed,
    Revealed,
    Penalized,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyOutcome {
    Pending,
    Ok,
    Err,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub big_y: String,
    pub big_c: String,
    pub block: u64,
    pub ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Payout {
    pub usdc: u128,
    pub tokens: u128,
    pub ok: bool,
    pub pending: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaleResult {
    pub p_star: Option<u64>,
    pub sold: u128,
    pub seller_usdc: u128,
    pub seller_tokens_back: u128,
    pub token_dust: u128,
    pub penalty_pool: u128,
    pub block: u64,
    pub ns: u64,
    pub cancelled: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sale {
    pub seller: AccountId,
    /// Sale token id as Intents names it (`nep141:wrap.near`).
    pub token: String,
    pub supply: u128,
    pub decimals: u8,
    pub lot_exp: u8,
    /// Micro-USDC per 10^lot_exp whole tokens.
    pub reserve: u64,
    pub min_escrow: u128,
    pub min_bidders: u16,
    pub max_bids: u16,
    pub quote_token: String,
    pub close_ns: u64,
    pub reveal_secs: u64,
    pub created_block: u64,
    pub created_ns: u64,
    /// CKD derivation path `tender/{id}/{32 hex}` (C11).
    pub path: String,
    pub state: SaleState,
    pub bids: u16,
    pub bidders: u16,
    pub escrow_total: u128,
    pub revealed: u16,
    pub key_requests: u32,
    pub in_flight: bool,
    pub pending_log: Option<u64>,
    pub key: Option<Key>,
    pub reveal_deadline_ns: Option<u64>,
    pub result: Option<SaleResult>,
    pub seller_payout: Payout,
    pub payouts_done: u16,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bid {
    /// Intents account that signed the transfer (`sender_id`).
    pub bidder: AccountId,
    pub escrow: u128,
    pub ct: Vec<u8>,
    pub cm: [u8; 32],
    /// Self-declared origin chain, UI badge only (C7).
    pub origin: Option<String>,
    pub block: u64,
    pub ns: u64,
    pub state: BidState,
    pub p: Option<u64>,
    pub q: Option<u64>,
    pub salt: Option<[u8; 16]>,
    pub revealed_by: Option<AccountId>,
    pub alloc: u128,
    pub spend: u128,
    pub penalty: u128,
    pub penalty_share: u128,
    pub paid: Payout,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyReq {
    pub sale: u64,
    pub block: u64,
    pub ns: u64,
    pub outcome: KeyOutcome,
    pub resolved_block: Option<u64>,
}

/// `{"op":"create",…}` (C5). Unknown fields are ignored.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CreateMsg {
    pub close_ns: U64,
    pub reveal_secs: U64,
    pub reserve: U64,
    pub min_escrow: U128,
    pub min_bidders: u16,
    pub quote_token: String,
    pub max_bids: u16,
    pub decimals: u8,
    pub lot_exp: u8,
}

/// `{"op":"bid",…}` (C7). Unknown fields are ignored.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BidMsg {
    pub sale: U64,
    pub ct: String,
    pub cm: String,
    pub origin: Option<String>,
}

/// Inputs of `validate_create` that come from the transfer, not the msg.
pub struct CreateCtx<'a> {
    pub sender: &'a AccountId,
    pub token: &'a str,
    pub amount: u128,
    pub now_ns: u64,
    pub sellers: &'a [AccountId],
    pub quote_tokens: &'a [String],
}

/// C6, C30, WD-01. Returns the refund reason on failure.
pub fn validate_create(c: &CreateCtx, m: &CreateMsg) -> Result<(), &'static str> {
    if !c.sellers.contains(c.sender) {
        return Err("not_seller");
    }
    if !c.quote_tokens.iter().any(|q| q == &m.quote_token) {
        return Err("unknown_quote_token");
    }
    if c.token == m.quote_token {
        return Err("sale_token_is_quote");
    }
    let min_close = c
        .now_ns
        .checked_add(MIN_CLOSE_DELAY_SECS * NS_PER_SEC)
        .ok_or("overflow")?;
    let max_close = c
        .now_ns
        .checked_add(MAX_CLOSE_DELAY_SECS * NS_PER_SEC)
        .ok_or("overflow")?;
    if m.close_ns.0 < min_close {
        return Err("close_too_soon");
    }
    if m.close_ns.0 > max_close {
        return Err("close_too_far");
    }
    if !(MIN_REVEAL_SECS..=MAX_REVEAL_SECS).contains(&m.reveal_secs.0) {
        return Err("reveal_secs");
    }
    if m.reserve.0 == 0 {
        return Err("zero_reserve");
    }
    if !(m.min_bidders >= 1 && m.min_bidders <= m.max_bids && m.max_bids <= MAX_BIDS) {
        return Err("bid_limits");
    }
    if m.decimals > MAX_DECIMALS {
        return Err("decimals");
    }
    if m.decimals as u16 + m.lot_exp as u16 > MAX_SCALE_EXP as u16 {
        return Err("decimals_plus_lot_exp");
    }
    if c.amount == 0 || c.amount > MAX_SUPPLY {
        return Err("supply");
    }
    Ok(())
}

/// A bid msg decoded and checked against the sale (C8, WD-11).
pub struct ParsedBid {
    pub ct: Vec<u8>,
    pub cm: [u8; 32],
    pub origin: Option<String>,
}

/// C8 + WD-11. `msg_len` is the length of the raw msg string. Returns the refund reason.
pub fn validate_bid(
    sale: &Sale,
    token: &str,
    amount: u128,
    msg_len: usize,
    m: &BidMsg,
    now_ns: u64,
) -> Result<ParsedBid, &'static str> {
    if token != sale.quote_token {
        return Err("wrong_token");
    }
    if sale.state != SaleState::Open || sale.in_flight || sale.key.is_some() {
        return Err("not_open");
    }
    if now_ns >= sale.close_ns {
        return Err("closed");
    }
    if amount < MIN_ESCROW_PER_BID {
        return Err("escrow_below_min");
    }
    let total = sale.escrow_total.checked_add(amount).ok_or("escrow_cap")?;
    if total > MAX_ESCROW_TOTAL {
        return Err("escrow_cap");
    }
    if sale.bids >= sale.max_bids {
        return Err("max_bids");
    }
    if msg_len > MAX_BID_MSG {
        return Err("msg_too_long");
    }
    let ct = decode_ct(&m.ct).ok_or("bad_ct")?;
    let cm = hex_decode_lower::<32>(&m.cm).ok_or("bad_cm")?;
    if let Some(o) = &m.origin
        && (o.len() > MAX_ORIGIN_LEN || !o.bytes().all(|b| b.is_ascii_graphic()))
    {
        return Err("bad_origin");
    }
    Ok(ParsedBid {
        ct,
        cm,
        origin: m.origin.clone(),
    })
}

/// Standard base64 with padding, exactly 160 bytes (S5, WD-11).
pub fn decode_ct(s: &str) -> Option<Vec<u8>> {
    use near_sdk::base64::Engine;
    let b = near_sdk::base64::engine::general_purpose::STANDARD
        .decode(s)
        .ok()?;
    (b.len() == CT_LEN).then_some(b)
}

pub fn encode_ct(b: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(b)
}

/// C15: the reveal window is never shorter than MIN_REVEAL_SECS after the key arrives.
pub fn reveal_deadline(key_ns: u64, reveal_secs: u64) -> u64 {
    key_ns.saturating_add(reveal_secs.max(MIN_REVEAL_SECS).saturating_mul(NS_PER_SEC))
}

/// C32: the only state changes that exist. Anything else is a bug and panics (state reverts).
pub fn transition(sale: &mut Sale, to: SaleState) {
    let allowed = matches!(
        (sale.state, to),
        (SaleState::Open, SaleState::Keyed)
            | (SaleState::Open, SaleState::Cancelled)
            | (SaleState::Keyed, SaleState::Finalized)
    );
    near_sdk::require!(allowed, "invalid state transition");
    sale.state = to;
}

impl Sale {
    /// State string for views: `Opening` while a key request is in flight (WD-14).
    pub fn state_str(&self) -> &'static str {
        match self.state {
            SaleState::Open if self.in_flight => "Opening",
            SaleState::Open => "Open",
            SaleState::Keyed => "Keyed",
            SaleState::Finalized => "Finalized",
            SaleState::Cancelled => "Cancelled",
        }
    }
}

impl BidState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sealed => "Sealed",
            Self::Revealed => "Revealed",
            Self::Penalized => "Penalized",
        }
    }
}

impl KeyOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "Pending",
            Self::Ok => "Ok",
            Self::Err => "Err",
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::Tender;
    use near_sdk::serde_json::{Value, json};
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::{NearToken, testing_env};

    pub const USDC: &str = "nep141:usdc.near";
    pub const WNEAR: &str = "nep141:wrap.near";
    pub const SELLER: &str = "tenderseal.near";
    pub const ME: &str = "v1.tenderseal.near";
    pub const INTENTS: &str = "intents.near";
    pub const NOW: u64 = 1_800_000_000 * NS_PER_SEC;
    pub const SUPPLY: u128 = 3_000_000_000_000_000_000_000_000;

    pub fn ctx(predecessor: &str, now: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(ME.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .block_timestamp(now)
            .block_height(100)
            .random_seed([7; 32]);
        b
    }

    pub fn setup() -> Tender {
        testing_env!(ctx(SELLER, NOW).build());
        Tender::new(
            "v1.signer".parse().unwrap(),
            INTENTS.parse().unwrap(),
            2,
            "identity".into(),
            "bls12381g2:x".into(),
            vec![USDC.into()],
            vec![SELLER.parse().unwrap()],
        )
    }

    pub fn create_msg() -> Value {
        json!({
            "op": "create", "close_ns": (NOW + 3600 * NS_PER_SEC).to_string(), "reveal_secs": "86400",
            "reserve": "3000000", "min_escrow": "5000000", "min_bidders": 3, "quote_token": USDC,
            "max_bids": 16, "decimals": 24, "lot_exp": 0
        })
    }

    /// Calls mt_on_transfer as intents.near at `now` with one token.
    pub fn transfer(
        t: &mut Tender,
        sender: &str,
        token: &str,
        amount: u128,
        msg: &str,
        now: u64,
    ) -> Vec<u128> {
        testing_env!(ctx(INTENTS, now).build());
        t.mt_on_transfer(
            sender.parse().unwrap(),
            vec![sender.parse().unwrap()],
            vec![token.into()],
            vec![U128(amount)],
            msg.into(),
        )
        .into_iter()
        .map(|a| a.0)
        .collect()
    }

    fn refund_reason() -> Option<String> {
        get_logs().iter().find_map(|l| {
            let v: Value = near_sdk::serde_json::from_str(l.strip_prefix("EVENT_JSON:")?).ok()?;
            (v["event"] == "refund").then(|| v["data"][0]["reason"].as_str().unwrap().to_string())
        })
    }

    fn assert_refunded(got: Vec<u128>, amount: u128, reason: &str) {
        assert_eq!(got, vec![amount]);
        assert_eq!(refund_reason().as_deref(), Some(reason));
    }

    fn create_with(t: &mut Tender, f: impl FnOnce(&mut Value), amount: u128) -> Vec<u128> {
        let mut m = create_msg();
        f(&mut m);
        transfer(t, SELLER, WNEAR, amount, &m.to_string(), NOW)
    }

    fn rejects(f: impl FnOnce(&mut Value), reason: &str) {
        let mut t = setup();
        let got = create_with(&mut t, f, SUPPLY);
        assert_refunded(got, SUPPLY, reason);
        assert_eq!(t.sales.len(), 0);
    }

    #[test]
    fn create_rejects_non_seller() {
        let mut t = setup();
        let got = transfer(
            &mut t,
            "alice.near",
            WNEAR,
            SUPPLY,
            &create_msg().to_string(),
            NOW,
        );
        assert_refunded(got, SUPPLY, "not_seller");
    }

    #[test]
    fn create_rejects_quote_as_sale_token() {
        let mut t = setup();
        let got = transfer(
            &mut t,
            SELLER,
            USDC,
            5_000_000,
            &create_msg().to_string(),
            NOW,
        );
        assert_refunded(got, 5_000_000, "sale_token_is_quote");
    }

    #[test]
    fn create_rejects_unknown_quote() {
        rejects(
            |m| m["quote_token"] = json!("nep141:other.near"),
            "unknown_quote_token",
        );
    }

    #[test]
    fn create_rejects_close_too_soon() {
        rejects(
            |m| m["close_ns"] = json!((NOW + 299 * NS_PER_SEC).to_string()),
            "close_too_soon",
        );
    }

    #[test]
    fn create_rejects_close_too_far() {
        rejects(
            |m| m["close_ns"] = json!((NOW + (30 * 86_400 + 1) * NS_PER_SEC).to_string()),
            "close_too_far",
        );
    }

    #[test]
    fn create_rejects_short_reveal() {
        rejects(|m| m["reveal_secs"] = json!("86399"), "reveal_secs");
    }

    #[test]
    fn create_rejects_long_reveal() {
        rejects(|m| m["reveal_secs"] = json!("604801"), "reveal_secs");
    }

    #[test]
    fn create_rejects_zero_reserve() {
        rejects(|m| m["reserve"] = json!("0"), "zero_reserve");
    }

    #[test]
    fn create_rejects_min_bidders_gt_max() {
        rejects(
            |m| {
                m["min_bidders"] = json!(5);
                m["max_bids"] = json!(4);
            },
            "bid_limits",
        );
    }

    #[test]
    fn create_rejects_max_bids_65() {
        rejects(|m| m["max_bids"] = json!(65), "bid_limits");
    }

    #[test]
    fn create_rejects_decimals_25() {
        rejects(|m| m["decimals"] = json!(25), "decimals");
    }

    #[test]
    fn create_rejects_d_plus_lot_27() {
        rejects(
            |m| {
                m["decimals"] = json!(24);
                m["lot_exp"] = json!(3);
            },
            "decimals_plus_lot_exp",
        );
    }

    #[test]
    fn create_rejects_supply_over_1e26() {
        let mut t = setup();
        let got = create_with(&mut t, |_| {}, MAX_SUPPLY + 1);
        assert_refunded(got, MAX_SUPPLY + 1, "supply");
    }

    #[test]
    fn create_rejects_bad_json() {
        let mut t = setup();
        let got = transfer(&mut t, SELLER, WNEAR, SUPPLY, "{\"op\":\"create\",", NOW);
        assert_refunded(got, SUPPLY, "bad_msg");
        let got = create_with(&mut t, |m| m["reserve"] = json!(3000000), SUPPLY);
        assert_refunded(got, SUPPLY, "bad_msg");
    }

    #[test]
    fn create_ok_returns_zero_and_path_shape() {
        let mut t = setup();
        let got = create_with(&mut t, |_| {}, SUPPLY);
        assert_eq!(got, vec![0]);
        assert_eq!(refund_reason(), None);
        let s = t.sales.get(0).unwrap();
        let tail = s.path.strip_prefix("tender/0/").unwrap();
        assert_eq!(tail.len(), 32);
        assert!(
            tail.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        );
        assert_eq!(
            (s.supply, s.state, s.created_ns),
            (SUPPLY, SaleState::Open, NOW)
        );
        assert!(
            get_logs()
                .iter()
                .any(|l| l.contains("\"event\":\"create\""))
        );
    }

    // ---- bid ----

    pub fn ct_b64(n: usize) -> String {
        encode_ct(&vec![0x5a; n])
    }

    pub fn bid_msg(sale: u64) -> Value {
        json!({ "op": "bid", "sale": sale.to_string(), "ct": ct_b64(CT_LEN), "cm": "ab".repeat(32), "origin": "base" })
    }

    /// Tender with sale 0 open (close NOW + 1 h, max_bids 16 unless changed).
    pub fn with_sale(f: impl FnOnce(&mut Value)) -> Tender {
        let mut t = setup();
        assert_eq!(create_with(&mut t, f, SUPPLY), vec![0]);
        t
    }

    fn bid(t: &mut Tender, sender: &str, amount: u128, m: &Value) -> Vec<u128> {
        transfer(t, sender, USDC, amount, &m.to_string(), NOW + NS_PER_SEC)
    }

    fn bid_rejects(f: impl FnOnce(&mut Value), amount: u128, reason: &str) {
        let mut t = with_sale(|_| {});
        let mut m = bid_msg(0);
        f(&mut m);
        assert_refunded(bid(&mut t, "alice.near", amount, &m), amount, reason);
        assert_eq!(t.sales.get(0).unwrap().bids, 0);
    }

    #[test]
    fn bid_rejects_wrong_token() {
        let mut t = with_sale(|_| {});
        let got = transfer(
            &mut t,
            "alice.near",
            WNEAR,
            1_000_000,
            &bid_msg(0).to_string(),
            NOW,
        );
        assert_refunded(got, 1_000_000, "wrong_token");
    }

    #[test]
    fn bid_rejects_after_close() {
        let mut t = with_sale(|_| {});
        let close = t.sales.get(0).unwrap().close_ns;
        let got = transfer(
            &mut t,
            "alice.near",
            USDC,
            1_000_000,
            &bid_msg(0).to_string(),
            close,
        );
        assert_refunded(got, 1_000_000, "closed");
    }

    #[test]
    fn bid_rejects_below_1_usdc() {
        bid_rejects(|_| {}, 999_999, "escrow_below_min");
    }

    #[test]
    fn bid_rejects_escrow_cap() {
        let mut t = with_sale(|_| {});
        assert_eq!(
            bid(
                &mut t,
                "alice.near",
                MAX_ESCROW_TOTAL - 1_000_000,
                &bid_msg(0)
            ),
            vec![0]
        );
        assert_refunded(
            bid(&mut t, "bob.near", 1_000_001, &bid_msg(0)),
            1_000_001,
            "escrow_cap",
        );
        assert_eq!(bid(&mut t, "bob.near", 1_000_000, &bid_msg(0)), vec![0]);
    }

    #[test]
    fn bid_rejects_max_bids() {
        let mut t = with_sale(|m| {
            m["max_bids"] = json!(1);
            m["min_bidders"] = json!(1);
        });
        assert_eq!(bid(&mut t, "alice.near", 1_000_000, &bid_msg(0)), vec![0]);
        assert_refunded(
            bid(&mut t, "bob.near", 1_000_000, &bid_msg(0)),
            1_000_000,
            "max_bids",
        );
    }

    #[test]
    fn bid_rejects_long_msg() {
        let mut t = with_sale(|_| {});
        let mut m = bid_msg(0);
        let base = m.to_string().len();
        m["pad"] = json!("");
        let with_empty_pad = m.to_string().len();
        m["pad"] = json!("x".repeat(MAX_BID_MSG + 1 - with_empty_pad));
        assert!(base < MAX_BID_MSG);
        assert_eq!(m.to_string().len(), MAX_BID_MSG + 1);
        assert_refunded(
            bid(&mut t, "alice.near", 1_000_000, &m),
            1_000_000,
            "msg_too_long",
        );
        m["pad"] = json!("x".repeat(MAX_BID_MSG - with_empty_pad));
        assert_eq!(bid(&mut t, "alice.near", 1_000_000, &m), vec![0]);
    }

    #[test]
    fn bid_rejects_ct_159() {
        bid_rejects(|m| m["ct"] = json!(ct_b64(159)), 1_000_000, "bad_ct");
    }

    #[test]
    fn bid_rejects_ct_no_padding() {
        let unpadded = ct_b64(CT_LEN).trim_end_matches('=').to_string();
        bid_rejects(|m| m["ct"] = json!(unpadded), 1_000_000, "bad_ct");
    }

    #[test]
    fn bid_rejects_uppercase_cm() {
        bid_rejects(|m| m["cm"] = json!("AB".repeat(32)), 1_000_000, "bad_cm");
    }

    #[test]
    fn bid_rejects_origin_9_bytes() {
        bid_rejects(
            |m| m["origin"] = json!("abcdefghi"),
            1_000_000,
            "bad_origin",
        );
    }

    #[test]
    fn bid_rejects_not_from_intents() {
        let mut t = with_sale(|_| {});
        testing_env!(ctx("evil.near", NOW).build());
        let got = t.mt_on_transfer(
            "alice.near".parse().unwrap(),
            vec!["alice.near".parse().unwrap()],
            vec![USDC.into()],
            vec![U128(1_000_000)],
            bid_msg(0).to_string(),
        );
        assert_eq!(got, vec![U128(1_000_000)]);
        assert_eq!(refund_reason().as_deref(), Some("not_from_intents"));
        assert_eq!(t.sales.get(0).unwrap().bids, 0);
    }

    #[test]
    fn bid_rejects_multi_token() {
        let mut t = with_sale(|_| {});
        testing_env!(ctx(INTENTS, NOW).build());
        let got = t.mt_on_transfer(
            "alice.near".parse().unwrap(),
            vec!["alice.near".parse().unwrap(), "alice.near".parse().unwrap()],
            vec![USDC.into(), USDC.into()],
            vec![U128(1_000_000), U128(1_000_000)],
            bid_msg(0).to_string(),
        );
        assert_eq!(got, vec![U128(1_000_000), U128(1_000_000)]);
        assert_eq!(refund_reason().as_deref(), Some("bad_shape"));
    }

    #[test]
    fn bid_counts_distinct_bidders() {
        let mut t = with_sale(|_| {});
        assert_eq!(bid(&mut t, "alice.near", 1_000_000, &bid_msg(0)), vec![0]);
        assert_eq!(bid(&mut t, "alice.near", 2_000_000, &bid_msg(0)), vec![0]);
        let s = t.sales.get(0).unwrap();
        assert_eq!((s.bids, s.bidders, s.escrow_total), (2, 1, 3_000_000));
        assert_eq!(bid(&mut t, "bob.near", 1_000_000, &bid_msg(0)), vec![0]);
        assert_eq!(t.sales.get(0).unwrap().bidders, 2);
        let b = t.bids.get(&(0, 1)).unwrap();
        assert_eq!(
            (b.escrow, b.state, b.ct.len()),
            (2_000_000, BidState::Sealed, CT_LEN)
        );
    }

    #[test]
    fn storage_guard_refunds() {
        let mut t = with_sale(|_| {});
        let mut c = ctx(INTENTS, NOW + NS_PER_SEC);
        // Just enough for current storage + 0.3 NEAR, not for one more bid.
        let usage = near_sdk::env::storage_usage();
        let balance = (usage as u128 + 100) * near_sdk::env::storage_byte_cost().as_yoctonear()
            + crate::STORAGE_RESERVE_YOCTO;
        c.account_balance(NearToken::from_yoctonear(balance))
            .storage_usage(usage);
        testing_env!(c.build());
        let got = t.mt_on_transfer(
            "alice.near".parse().unwrap(),
            vec!["alice.near".parse().unwrap()],
            vec![USDC.into()],
            vec![U128(1_000_000)],
            bid_msg(0).to_string(),
        );
        assert_eq!(got, vec![U128(1_000_000)]);
        assert_eq!(refund_reason().as_deref(), Some("storage"));
        assert_eq!(t.sales.get(0).unwrap().bids, 0);
    }
}
