//! Uniform-price clearing with the unrevealed-bid penalty (Q2, C22, K1-K3, WD-02, WD-16). Pure,
//! integer-only, no `env` calls. Must match `fixtures/clearing/gen.py` and `@tender/clearing`
//! on every fixture in `fixtures/clearing/`.
//!
//! Prices are micro-USDC per 10^lot_exp whole tokens, so token amounts scale by
//! 10^(decimals + lot_exp). Bids are ranked by price (desc), ties by arrival (idx). A full
//! winner pays q and gets floor(q·scale/P*) tokens; every bid at p == P* forms the marginal
//! group, which shares the remaining supply pro rata by q, each share capped at what q buys at
//! P* (floor(q·scale/P*), the excess is dust), and pays ceil(t·P*/scale) ≤ q. A Sealed bid loses
//! B/10 when at least one bid was revealed; the pool is paid to nobody (not to revealed bids,
//! not to the seller) and stays in the contract, so Σ refund + seller_usdc + pool = Σ B. With
//! nothing revealed there is no penalty and every bid stays Sealed.
//!
//! u128 bounds: S ≤ 10^26 (WD-01), Σ B ≤ 10^12 and q ≤ B (C8, C16), decimals + lot_exp ≤ 26
//! (C6), so Q·scale, q·scale, R·q and t·P* stay ≤ ~10^38 < 2^128.
use crate::sale::BidState;

pub struct ClearBid {
    /// Arrival order; `bids[i].idx == i`.
    pub idx: u16,
    pub escrow: u128,
    /// `(p, q)` once revealed; `None` while Sealed.
    pub revealed: Option<(u64, u64)>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ClearOutcome {
    pub p_star: Option<u64>,
    pub alloc: Vec<u128>,
    pub spend: Vec<u128>,
    pub penalty: Vec<u128>,
    pub penalty_share: Vec<u128>,
    pub refund: Vec<u128>,
    pub final_state: Vec<BidState>,
    pub seller_usdc: u128,
    pub seller_tokens_back: u128,
    pub token_dust: u128,
    pub penalty_pool: u128,
}

fn mul(a: u128, b: u128) -> u128 {
    a.checked_mul(b).expect("clearing overflow")
}

fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).expect("clearing overflow")
}

fn sub(a: u128, b: u128) -> u128 {
    a.checked_sub(b).expect("clearing underflow")
}

pub fn clear(
    supply: u128,
    decimals: u8,
    lot_exp: u8,
    reserve: u64,
    bids: &[ClearBid],
) -> ClearOutcome {
    let scale = 10u128.pow(u32::from(decimals) + u32::from(lot_exp));
    let n = bids.len();
    let reserve = u128::from(reserve);
    let mut alloc = vec![0u128; n];
    let mut spend = vec![0u128; n];
    let mut penalty = vec![0u128; n];

    // K1-K3: penalty only when something was revealed. The pool is paid to nobody: any share
    // for revealed bids could flow back to the penalized bidder's own revealed (decoy) bid
    // (CRYPTO-01, T-01), so it stays in the contract.
    let any_revealed = bids.iter().any(|b| b.revealed.is_some());
    if any_revealed {
        for (i, b) in bids.iter().enumerate() {
            if b.revealed.is_none() {
                penalty[i] = b.escrow / 10;
            }
        }
    }
    let pool = penalty.iter().fold(0, |a, &x| add(a, x));

    // Eligible: revealed at or above reserve, by price desc then arrival.
    let mut el: Vec<(usize, u128, u128)> = bids
        .iter()
        .enumerate()
        .filter_map(|(i, b)| b.revealed.map(|(p, q)| (i, u128::from(p), u128::from(q))))
        .filter(|&(_, p, _)| p >= reserve)
        .collect();
    el.sort_by(|a, b| b.1.cmp(&a.1).then(bids[a.0].idx.cmp(&bids[b.0].idx)));

    let mut p_star: Option<u128> = None;
    let mut dust = 0u128;
    let mut q_sum = 0u128;
    for k in 0..el.len() {
        let (_, p_k, q_k) = el[k];
        q_sum = add(q_sum, q_k);
        let cand = reserve.max(mul(q_sum, scale).div_ceil(supply));
        let next = el.get(k + 1).map(|e| e.1);
        if cand <= p_k && next.is_none_or(|nx| cand > nx) {
            // Demand up to k fits at a price between the next bid and this one.
            for &(i, _, q) in &el[..=k] {
                spend[i] = q;
                alloc[i] = mul(q, scale) / cand;
            }
            p_star = Some(cand);
            break;
        }
        if cand > p_k {
            // Over-subscribed at p_k: P* = p_k and the bids at p_k share what is left.
            let price = p_k;
            let mut left = supply;
            let mut q_marg = 0u128;
            for &(i, p, q) in &el {
                if p > price {
                    spend[i] = q;
                    alloc[i] = mul(q, scale) / price;
                    left = sub(left, alloc[i]);
                } else if p == price {
                    q_marg = add(q_marg, q);
                }
            }
            let mut given = 0u128;
            for &(i, p, q) in &el {
                if p == price {
                    // Never more than q buys at P*, so spend ≤ q (C-01); the rest is dust.
                    alloc[i] = (mul(left, q) / q_marg).min(mul(q, scale) / price);
                    spend[i] = mul(alloc[i], price).div_ceil(scale);
                    given = add(given, alloc[i]);
                }
            }
            dust = sub(left, given);
            p_star = Some(price);
            break;
        }
    }

    let refund: Vec<u128> = (0..n)
        .map(|i| sub(sub(bids[i].escrow, spend[i]), penalty[i]))
        .collect();
    let final_state = bids
        .iter()
        .map(|b| match (b.revealed, any_revealed) {
            (Some(_), _) => BidState::Revealed,
            (None, true) => BidState::Penalized,
            (None, false) => BidState::Sealed,
        })
        .collect();
    let seller_usdc = spend.iter().fold(0, |a, &x| add(a, x));
    let sold = alloc.iter().fold(0, |a, &x| add(a, x));
    ClearOutcome {
        // P* ≤ the p of the bid that set it, so it fits in u64.
        p_star: p_star.map(|p| p as u64),
        alloc,
        spend,
        penalty,
        // Kept in the views for their shape; always 0 since the pool goes to nobody.
        penalty_share: vec![0; n],
        refund,
        final_state,
        seller_usdc,
        seller_tokens_back: sub(supply, sold),
        token_dust: dust,
        penalty_pool: pool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};
    use proptest::prelude::*;

    fn num(v: &Value) -> u128 {
        match v {
            Value::String(s) => s.parse().expect("decimal string"),
            Value::Number(n) => n.as_u64().expect("u64") as u128,
            _ => panic!("not a number: {v}"),
        }
    }

    fn nums(v: &Value) -> Vec<u128> {
        v.as_array().unwrap().iter().map(num).collect()
    }

    fn state_str(s: BidState) -> &'static str {
        s.as_str()
    }

    #[test]
    fn fixtures_match() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/clearing");
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .expect("fixtures/clearing")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        assert!(!files.is_empty(), "no fixtures in {dir}");
        for f in &files {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            let j: Value = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap();
            let sale = &j["sale"];
            let bids: Vec<ClearBid> = j["bids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| ClearBid {
                    idx: num(&b["idx"]) as u16,
                    escrow: num(&b["B"]),
                    revealed: (b["state"] == "Revealed")
                        .then(|| (num(&b["p"]) as u64, num(&b["q"]) as u64)),
                })
                .collect();
            let got = clear(
                num(&sale["S"]),
                num(&sale["decimals"]) as u8,
                num(&sale["lot_exp"]) as u8,
                num(&sale["reserve"]) as u64,
                &bids,
            );
            let e = &j["expected"];
            let p_star = (!e["P_star"].is_null()).then(|| num(&e["P_star"]) as u64);
            assert_eq!(got.p_star, p_star, "{name}: P_star");
            assert_eq!(got.alloc, nums(&e["alloc"]), "{name}: alloc");
            assert_eq!(got.spend, nums(&e["spend"]), "{name}: spend");
            assert_eq!(got.refund, nums(&e["refund"]), "{name}: refund");
            assert_eq!(got.penalty, nums(&e["penalty"]), "{name}: penalty");
            assert_eq!(
                got.penalty_share,
                nums(&e["penalty_share"]),
                "{name}: penalty_share"
            );
            let states: Vec<&str> = got.final_state.iter().map(|s| state_str(*s)).collect();
            let want: Vec<&str> = e["final_state"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap())
                .collect();
            assert_eq!(states, want, "{name}: final_state");
            assert_eq!(
                got.seller_usdc,
                num(&e["seller_usdc"]),
                "{name}: seller_usdc"
            );
            assert_eq!(
                got.seller_tokens_back,
                num(&e["seller_tokens_back"]),
                "{name}: seller_tokens_back"
            );
            assert_eq!(got.token_dust, num(&e["dust"]), "{name}: dust");
        }
    }

    /// A full winner with q = 1 at the highest possible P*: with 10^19 base units per lot it
    /// pays 1 micro-USDC for 0 tokens; with 10^20 (the `create` minimum) it gets tokens.
    #[test]
    fn full_winner_gets_tokens_at_min_scale() {
        let bids = [
            ClearBid {
                idx: 0,
                escrow: 1_000_000,
                revealed: Some((u64::MAX, 1)),
            },
            ClearBid {
                idx: 1,
                escrow: 1_000_000,
                revealed: Some((u64::MAX - 1, 1)),
            },
        ];
        let low = clear(1, 19, 0, 1, &bids);
        assert_eq!(low.p_star, Some(u64::MAX - 1));
        assert_eq!((low.spend[0], low.alloc[0]), (1, 0));
        let min = clear(10, 20, 0, 1, &bids);
        assert_eq!(min.p_star, Some(u64::MAX - 1));
        assert_eq!(min.spend[0], 1);
        assert!(min.alloc[0] >= 1, "{:?}", min.alloc);
    }

    /// C-01 / S-01 / X12-01: the full winners' floor losses stay in `left`, so the marginal bid
    /// could be given more tokens than q buys at P* and charged q + 1, which with q == B
    /// underflowed the refund and made every finalize panic.
    #[test]
    fn marginal_never_spends_more_than_q() {
        let rev = |idx, b: u64, p| ClearBid {
            idx,
            escrow: u128::from(b),
            revealed: Some((p, b)),
        };
        let cases = [
            (
                1_000_000_333_333_333_333_333_333u128,
                24,
                0,
                1_000_000,
                [rev(0, 1_000_001, 3_500_000), rev(1, 2_000_000, 3_000_000)],
            ),
            (
                18_918_924_324_324_324_324_324,
                18,
                3,
                174_000,
                [rev(0, 2_000_000, 200_000), rev(1, 1_500_001, 185_000)],
            ),
            (
                11_764_705,
                18,
                2,
                1,
                [
                    rev(0, 1_000_000, 18_000_000_000_000_000_000),
                    rev(1, 1_000_000, 17_000_000_000_000_000_000),
                ],
            ),
        ];
        for (supply, d, lot, reserve, bids) in cases {
            let o = clear(supply, d, lot, reserve, &bids);
            for (i, b) in bids.iter().enumerate() {
                assert!(o.spend[i] <= b.escrow, "{supply}: bid {i} {:?}", o.spend);
            }
            assert_eq!(o.refund, vec![0, 0], "{supply}");
            assert_eq!(o.alloc.iter().sum::<u128>() + o.seller_tokens_back, supply);
        }
    }

    /// CRYPTO-01 / T-01: three undecryptable option bids left Sealed after a last look, plus a
    /// large below-reserve decoy that is revealed. The decoy must not win the pool back: the
    /// withheld bids cost their full B/10 and the pool stays in the contract.
    #[test]
    fn penalty_pool_is_not_recycled_to_revealed_bids() {
        let usdc = 1_000_000u128;
        let sealed = |idx| ClearBid {
            idx,
            escrow: 2 * usdc,
            revealed: None,
        };
        let bids = [
            ClearBid {
                idx: 0,
                escrow: 5 * usdc,
                revealed: Some((3_600_000, 5_000_000)),
            },
            sealed(1),
            sealed(2),
            sealed(3),
            ClearBid {
                idx: 4,
                escrow: 1_000 * usdc,
                revealed: Some((1, 1_000_000_000)),
            },
        ];
        let o = clear(10u128.pow(24), 24, 0, 3_000_000, &bids);
        assert_eq!(o.penalty_pool, 600_000);
        assert_eq!(o.penalty_share, vec![0; 5]);
        assert_eq!(o.refund[4], 1_000 * usdc);
        assert_eq!(o.refund[1], 2 * usdc - 200_000);
        let refunded: u128 = o.refund.iter().sum();
        let escrow: u128 = bids.iter().map(|b| b.escrow).sum();
        assert_eq!(refunded + o.seller_usdc + o.penalty_pool, escrow);
    }

    #[derive(Debug, Clone)]
    struct Case {
        supply: u128,
        decimals: u8,
        lot_exp: u8,
        reserve: u64,
        bids: Vec<(u128, Option<(u64, u64)>)>,
    }

    impl Case {
        fn run(&self) -> (Vec<ClearBid>, ClearOutcome) {
            let bids: Vec<ClearBid> = self
                .bids
                .iter()
                .enumerate()
                .map(|(i, &(escrow, revealed))| ClearBid {
                    idx: i as u16,
                    escrow,
                    revealed,
                })
                .collect();
            let out = clear(
                self.supply,
                self.decimals,
                self.lot_exp,
                self.reserve,
                &bids,
            );
            (bids, out)
        }

        fn scale(&self) -> u128 {
            10u128.pow(u32::from(self.decimals) + u32::from(self.lot_exp))
        }
    }

    /// B ∈ [1, 15 625] USDC (64 bids ≤ 10^12), ~20 % Sealed, p ∈ [1, 10^13] or anywhere in
    /// u64, q ∈ [1, B] (half the time q == B).
    fn bid() -> impl Strategy<Value = (u128, Option<(u64, u64)>)> {
        (1_000_000u128..=15_625_000_000).prop_flat_map(|b| {
            let p = prop_oneof![1u64..=10_000_000_000_000, 1u64..=u64::MAX];
            let q = prop_oneof![Just(b as u64), 1u64..=b as u64];
            (
                Just(b),
                prop_oneof![
                    1 => Just(None),
                    4 => (p, q).prop_map(Some),
                ],
            )
        })
    }

    fn case() -> impl Strategy<Value = Case> {
        (0u8..=24).prop_flat_map(|d| {
            (
                Just(d),
                0u8..=(26 - d),
                prop_oneof![
                    1u128..=100_000_000_000_000_000_000_000_000,
                    1u128..=100_000_000_000_000,
                ],
                prop_oneof![1u64..=10_000_000_000_000, 1u64..=u64::MAX],
                prop::collection::vec(bid(), 1..=64),
            )
                .prop_map(|(decimals, lot_exp, supply, reserve, bids)| Case {
                    supply,
                    decimals,
                    lot_exp,
                    reserve,
                    bids,
                })
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn prop_supply_bound(c in case()) {
            let (_, o) = c.run();
            let sold: u128 = o.alloc.iter().sum();
            prop_assert!(sold <= c.supply);
            prop_assert_eq!(o.seller_tokens_back, c.supply - sold);
            prop_assert!(o.token_dust <= o.seller_tokens_back);
        }

        #[test]
        fn prop_price_le_bid(c in case()) {
            let (bids, o) = c.run();
            for (i, b) in bids.iter().enumerate() {
                if o.alloc[i] > 0 {
                    let (p, _) = b.revealed.unwrap();
                    prop_assert!(o.p_star.unwrap() <= p);
                    prop_assert!(o.p_star.unwrap() >= c.reserve);
                }
            }
        }

        #[test]
        fn prop_spend_le_q(c in case()) {
            let (bids, o) = c.run();
            for (i, b) in bids.iter().enumerate() {
                match b.revealed {
                    Some((_, q)) => prop_assert!(o.spend[i] <= u128::from(q)),
                    None => prop_assert_eq!(o.spend[i], 0),
                }
            }
        }

        #[test]
        fn prop_losers_zero(c in case()) {
            let (bids, o) = c.run();
            for (i, b) in bids.iter().enumerate() {
                let loses = match (b.revealed, o.p_star) {
                    (None, _) | (_, None) => true,
                    (Some((p, _)), Some(ps)) => p < ps || p < c.reserve,
                };
                if loses {
                    prop_assert_eq!((o.alloc[i], o.spend[i]), (0, 0));
                }
            }
        }

        #[test]
        fn prop_usdc_conservation(c in case()) {
            let (bids, o) = c.run();
            let total_b: u128 = bids.iter().map(|b| b.escrow).sum();
            let spent: u128 = o.spend.iter().sum();
            let refunded: u128 = o.refund.iter().sum();
            prop_assert_eq!(spent + refunded + o.penalty_pool, total_b);
        }

        #[test]
        fn prop_single_price(c in case()) {
            // Every winner is priced at the one P*: a full winner pays q for floor(q·scale/P*)
            // tokens, a marginal one pays ceil(alloc·P*/scale).
            let (bids, o) = c.run();
            let scale = c.scale();
            for (i, b) in bids.iter().enumerate() {
                if o.spend[i] == 0 && o.alloc[i] == 0 {
                    continue;
                }
                let ps = u128::from(o.p_star.unwrap());
                let (_, q) = b.revealed.unwrap();
                let full = o.spend[i] == u128::from(q) && o.alloc[i] == u128::from(q) * scale / ps;
                let marginal = o.spend[i] == (o.alloc[i] * ps).div_ceil(scale);
                prop_assert!(full || marginal, "bid {} alloc {} spend {}", i, o.alloc[i], o.spend[i]);
            }
        }

        #[test]
        fn prop_penalty_never_to_seller(c in case()) {
            let (_, o) = c.run();
            prop_assert_eq!(o.seller_usdc, o.spend.iter().sum::<u128>());
            prop_assert_eq!(o.penalty_share.iter().sum::<u128>(), 0);
            prop_assert_eq!(o.penalty_pool, o.penalty.iter().sum::<u128>());
        }

        #[test]
        fn prop_no_panic(c in case()) {
            let (bids, o) = c.run();
            prop_assert_eq!(o.final_state.len(), bids.len());
        }

        /// The knife edge of C-01: a full winner A and a marginal B with q == escrow, and
        /// S = floor(q_a·scale/P) + floor(q_b·scale/P) + 1 with r_a + r_b > P (r = q·scale mod
        /// P), so the floor losses alone would push B's spend to q_b + 1.
        #[test]
        fn prop_knife_edge_spend_le_q(
            exp in 20u32..=26,
            p in 1u64..=u64::MAX,
            q_a in 1_000_000u64..=500_000_000_000,
            q_b in 1_000_000u64..=500_000_000_000,
        ) {
            let scale = 10u128.pow(exp);
            let price = u128::from(p);
            let (qa, qb) = (u128::from(q_a), u128::from(q_b));
            prop_assume!((qa * scale) % price + (qb * scale) % price > price);
            let supply = qa * scale / price + qb * scale / price + 1;
            prop_assume!(supply <= 100_000_000_000_000_000_000_000_000);
            prop_assume!(p < u64::MAX);
            let decimals = exp.min(24) as u8;
            let bids = [
                ClearBid { idx: 0, escrow: qa, revealed: Some((p + 1, q_a)) },
                ClearBid { idx: 1, escrow: qb, revealed: Some((p, q_b)) },
            ];
            let o = clear(supply, decimals, exp as u8 - decimals, 1, &bids);
            prop_assert_eq!(o.p_star, Some(p));
            prop_assert!(o.spend[0] <= qa && o.spend[1] <= qb, "{:?}", o.spend);
            prop_assert_eq!(o.spend.iter().sum::<u128>() + o.refund.iter().sum::<u128>(), qa + qb);
        }
    }
}
