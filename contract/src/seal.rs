//! Everything about the sale key: the CKD request to the MPC contract (the only place that
//! calls `request_app_private_key`), parsing its answer, and hex helpers for commitments.
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, Gas, GasWeight, NearToken, env};

use crate::sale::AppPkMode;

/// AppPublicKeyPV pair whose app key is the identity (S = big_c).
pub const IDENTITY_PK1: &str =
    "bls12381g1:83VnBdpeT9ioHuUTBD2zcitXg7JqNiebUs5yxDaYaLgZYDLLk2gayHrJKNyRt4vBQB";
pub const IDENTITY_PK2: &str = "bls12381g2:2995BcogDeU9PQxbssLWhG9J76ubezYVpjbceWnwcmRs9ypA2vYDikf8mpuzankQX6WMsDockieKarmDerS2xTPzR1dktiHiGkjvPpRYpDip6unu4WgtPqeCPtxqppMzuGwy";
/// AppPublicKeyPV pair of the generators (a = 1, S = big_c − big_y); GENERATOR_PK1 alone is
/// the plain `AppPublicKey` (S1-C).
pub const GENERATOR_PK1: &str =
    "bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp";
pub const GENERATOR_PK2: &str = "bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK";

/// C14: MPC needs ≥ 15 Tgas; the call also gets the unused gas (weight 1).
const CKD_GAS: Gas = Gas::from_tgas(30);
const ON_KEY_GAS: Gas = Gas::from_tgas(15);
const G1_PREFIX: &str = "bls12381g1:";
const G1_BYTES: usize = 48;

pub fn app_public_key_json(mode: AppPkMode) -> Value {
    match mode {
        AppPkMode::Identity => {
            json!({ "AppPublicKeyPV": { "pk1": IDENTITY_PK1, "pk2": IDENTITY_PK2 } })
        }
        AppPkMode::Generator => {
            json!({ "AppPublicKeyPV": { "pk1": GENERATOR_PK1, "pk2": GENERATOR_PK2 } })
        }
        AppPkMode::Plain => json!({ "AppPublicKey": GENERATOR_PK1 }),
    }
}

/// `request_app_private_key` arguments, keys in the documented order.
pub fn ckd_args(path: &str, mode: AppPkMode, domain_id: u64) -> String {
    let path = serde_json::to_string(path).unwrap_or_else(|_| env::panic_str("bad path"));
    format!(
        r#"{{"request":{{"derivation_path":{path},"app_public_key":{},"domain_id":{domain_id}}}}}"#,
        app_public_key_json(mode)
    )
}

/// Asks the MPC contract for the key at `args` (1 yocto from this contract's balance, 30 Tgas +
/// weight 1), then `on_key(sale, log_idx)` (15 Tgas). The transaction's result is `on_key`'s.
pub(crate) fn request_key(mpc: &AccountId, args: &str, sale: u64, log_idx: u64) {
    let p = env::promise_batch_create(mpc);
    env::promise_batch_action_function_call_weight(
        p,
        "request_app_private_key",
        args.as_bytes(),
        NearToken::from_yoctonear(1),
        CKD_GAS,
        GasWeight(1),
    );
    let then = env::promise_batch_then(p, &env::current_account_id());
    let cb = json!({ "sale": sale.to_string(), "log_idx": log_idx.to_string() });
    env::promise_batch_action_function_call_weight(
        then,
        "on_key",
        cb.to_string().as_bytes(),
        NearToken::from_yoctonear(0),
        ON_KEY_GAS,
        GasWeight(0),
    );
    env::promise_return(then);
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct CkdResponse {
    big_y: String,
    big_c: String,
}

fn is_g1(s: &str) -> bool {
    s.strip_prefix(G1_PREFIX)
        .and_then(|b| near_sdk::bs58::decode(b).into_vec().ok())
        .is_some_and(|v| v.len() == G1_BYTES)
}

/// WD-12: `{"big_y","big_c"}`, both `bls12381g1:` + base58 of exactly 48 bytes. No BLS check
/// on chain (that happens off chain in `verify`).
pub fn parse_ckd(raw: &[u8]) -> Option<(String, String)> {
    let r: CkdResponse = serde_json::from_slice(raw).ok()?;
    (is_g1(&r.big_y) && is_g1(&r.big_c)).then_some((r.big_y, r.big_c))
}

/// C9 commitment preimage: `"tender/v1" ‖ u64_le(sale) ‖ u8(len(bidder)) ‖ bidder ‖
/// u128_le(B) ‖ u64_le(p) ‖ u64_le(q) ‖ salt16` (66 + len(bidder) bytes). Account ids are at
/// most 64 bytes, so the length always fits in one byte.
pub fn commitment_preimage(
    sale: u64,
    bidder: &str,
    b: u128,
    p: u64,
    q: u64,
    salt: &[u8; 16],
) -> Vec<u8> {
    let mut v = Vec::with_capacity(66 + bidder.len());
    v.extend_from_slice(b"tender/v1");
    v.extend_from_slice(&sale.to_le_bytes());
    v.push(bidder.len() as u8);
    v.extend_from_slice(bidder.as_bytes());
    v.extend_from_slice(&b.to_le_bytes());
    v.extend_from_slice(&p.to_le_bytes());
    v.extend_from_slice(&q.to_le_bytes());
    v.extend_from_slice(salt);
    v
}

/// `sha256(commitment_preimage(..))` (C9).
pub fn commitment(sale: u64, bidder: &str, b: u128, p: u64, q: u64, salt: &[u8; 16]) -> [u8; 32] {
    env::sha256_array(commitment_preimage(sale, bidder, b, p, q, salt))
}

/// Lowercase hex of exactly `2·N` characters to bytes. Uppercase is rejected (WD-11).
pub fn hex_decode_lower<const N: usize>(s: &str) -> Option<[u8; N]> {
    let b = s.as_bytes();
    if b.len() != 2 * N {
        return None;
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (nib(b[2 * i])? << 4) | nib(b[2 * i + 1])?;
    }
    Some(out)
}

pub fn hex_lower(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sale::{NS_PER_SEC, reveal_deadline};

    const PATH: &str = "tender/1/00112233445566778899aabbccddeeff";

    #[test]
    fn ckd_args_identity_exact() {
        assert_eq!(
            ckd_args(PATH, AppPkMode::Identity, 2),
            format!(
                r#"{{"request":{{"derivation_path":"{PATH}","app_public_key":{{"AppPublicKeyPV":{{"pk1":"{IDENTITY_PK1}","pk2":"{IDENTITY_PK2}"}}}},"domain_id":2}}}}"#
            )
        );
    }

    #[test]
    fn ckd_args_generator_exact() {
        assert_eq!(
            ckd_args(PATH, AppPkMode::Generator, 2),
            format!(
                r#"{{"request":{{"derivation_path":"{PATH}","app_public_key":{{"AppPublicKeyPV":{{"pk1":"{GENERATOR_PK1}","pk2":"{GENERATOR_PK2}"}}}},"domain_id":2}}}}"#
            )
        );
    }

    #[test]
    fn ckd_args_plain_exact() {
        assert_eq!(
            ckd_args(PATH, AppPkMode::Plain, 2),
            format!(
                r#"{{"request":{{"derivation_path":"{PATH}","app_public_key":{{"AppPublicKey":"bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp"}},"domain_id":2}}}}"#
            )
        );
    }

    /// Shape of the S1 testnet response (evidence/spikes/s1-testnet-identity.json).
    const S1_Y: &str =
        "bls12381g1:6FChjPPaArAH9pKMkMRcFsqGXDcZHu8Gcv2TJvjaLrjZC6WtNYvA2jz35X3Ag6aU54";
    const S1_C: &str =
        "bls12381g1:5nwqmUQvuRkXFZo7Gbp3x1FQYY8E7MwrYPdor959z9uWUubXumBiYwiPjkM6HWgdq9";

    #[test]
    fn parse_ckd_accepts_s1_shape() {
        let raw = format!(r#"{{"big_y":"{S1_Y}","big_c":"{S1_C}"}}"#);
        assert_eq!(
            parse_ckd(raw.as_bytes()),
            Some((S1_Y.to_string(), S1_C.to_string()))
        );
    }

    #[test]
    fn parse_ckd_rejects_missing_prefix() {
        let y = S1_Y.strip_prefix(G1_PREFIX).unwrap();
        let raw = format!(r#"{{"big_y":"{y}","big_c":"{S1_C}"}}"#);
        assert_eq!(parse_ckd(raw.as_bytes()), None);
        assert_eq!(parse_ckd(b"{\"error\":\"mpc failed\"}"), None);
        assert_eq!(parse_ckd(b""), None);
    }

    #[test]
    fn parse_ckd_rejects_47_bytes() {
        let short = format!(
            "{G1_PREFIX}{}",
            near_sdk::bs58::encode([7u8; 47]).into_string()
        );
        let raw = format!(r#"{{"big_y":"{S1_Y}","big_c":"{short}"}}"#);
        assert_eq!(parse_ckd(raw.as_bytes()), None);
    }

    /// Golden vectors shared with `@tender/seal` (`fixtures/seal/commitment.json`).
    #[test]
    fn commitment_matches_ws2_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/seal/commitment.json"
        );
        let raw = std::fs::read_to_string(path).expect("fixtures/seal/commitment.json");
        let j: Value = serde_json::from_str(&raw).unwrap();
        let cases = j["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 3);
        for c in cases {
            let s = |k: &str| c[k].as_str().unwrap().to_string();
            let salt = hex_decode_lower::<16>(&s("salt_hex")).unwrap();
            let args = (
                s("sale").parse::<u64>().unwrap(),
                s("bidder"),
                s("B").parse::<u128>().unwrap(),
                s("p").parse::<u64>().unwrap(),
                s("q").parse::<u64>().unwrap(),
            );
            let pre = commitment_preimage(args.0, &args.1, args.2, args.3, args.4, &salt);
            assert_eq!(hex_lower(&pre), s("preimage_hex"), "{}", s("name"));
            let cm = commitment(args.0, &args.1, args.2, args.3, args.4, &salt);
            assert_eq!(hex_lower(&cm), s("cm_hex"), "{}", s("name"));
        }
    }

    #[test]
    fn commitment_preimage_layout() {
        let salt = [9u8; 16];
        let pre = commitment_preimage(7, "alice.near", 5, 6, 8, &salt);
        assert_eq!(pre.len(), 66 + "alice.near".len());
        assert_eq!(&pre[..9], b"tender/v1");
        assert_eq!(&pre[9..17], &7u64.to_le_bytes());
        assert_eq!(pre[17], 10);
        assert_eq!(&pre[18..28], b"alice.near");
        assert_eq!(&pre[28..44], &5u128.to_le_bytes());
        assert_eq!(&pre[44..52], &6u64.to_le_bytes());
        assert_eq!(&pre[52..60], &8u64.to_le_bytes());
        assert_eq!(&pre[60..], &salt);
    }

    #[test]
    fn reveal_deadline_uses_min_86400() {
        assert_eq!(reveal_deadline(1_000, 3_600), 1_000 + 86_400 * NS_PER_SEC);
        assert_eq!(reveal_deadline(1_000, 86_400), 1_000 + 86_400 * NS_PER_SEC);
        assert_eq!(
            reveal_deadline(1_000, 200_000),
            1_000 + 200_000 * NS_PER_SEC
        );
    }
}
