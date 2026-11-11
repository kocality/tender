//! Everything about the sale key: the CKD request to the MPC contract (the only place that
//! calls `request_app_private_key`), parsing its answer, and hex helpers for commitments.
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, Gas, GasWeight, NearToken, env};

use crate::keycheck::{self, G1_BYTES, G2_BYTES};
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
/// X12F-01: `on_key` with the key check burns 10.04 Tgas (sandbox `gas_report`, 2026-11-12;
/// 2.06 Tgas without the check), so about 3× headroom for a contract that can never be
/// upgraded. If a later protocol priced it above this, `on_key` would fail, the request would
/// go dead after IN_FLIGHT_TIMEOUT_SECS and cancel rule (b) would refund in full.
const ON_KEY_GAS: Gas = Gas::from_tgas(30);
const G1_PREFIX: &str = "bls12381g1:";
const G2_PREFIX: &str = "bls12381g2:";

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
/// weight 1), then `on_key(sale, log_idx)` (30 Tgas). The transaction's result is `on_key`'s.
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
    keycheck::decode_point(s, G1_PREFIX, G1_BYTES).is_some()
}

/// WD-12: `{"big_y","big_c"}`, both `bls12381g1:` + base58 of exactly 48 bytes. Format only;
/// `on_key` then runs `key_matches` (X12F-01) and `verify` re-checks off chain.
pub fn parse_ckd(raw: &[u8]) -> Option<(String, String)> {
    let r: CkdResponse = serde_json::from_slice(raw).ok()?;
    (is_g1(&r.big_y) && is_g1(&r.big_c)).then_some((r.big_y, r.big_c))
}

/// `new()`: `bls12381g2:` + base58 of a 96-byte compressed G2 point, not at infinity.
pub fn mpc_key_ok(mpk: &str) -> bool {
    keycheck::decode_point(mpk, G2_PREFIX, G2_BYTES).is_some_and(|k| keycheck::g2_ok(&k))
}

/// X12F-01: the parsed answer `(big_y, big_c)` is the key of `path` for the pinned domain-2
/// key `mpk` and this contract `account`: `e(S, G2) = e(H(mpk ‖ app_id(account, path)), mpk)`
/// with `S = big_c` (identity) or `S = big_c − big_y` (generator, plain). It catches a
/// changed domain-2 key and a changed app_id derivation in v1.signer, which its own output
/// check cannot (it moves with the upgrade). Never panics.
pub fn key_matches(
    mode: AppPkMode,
    big_y: &str,
    big_c: &str,
    mpk: &str,
    account: &str,
    path: &str,
) -> bool {
    let g1 = |s| keycheck::decode_point(s, G1_PREFIX, G1_BYTES);
    match (
        g1(big_y),
        g1(big_c),
        keycheck::decode_point(mpk, G2_PREFIX, G2_BYTES),
    ) {
        (Some(y), Some(c), Some(k)) => keycheck::key_ok(
            mode == AppPkMode::Identity,
            &y,
            &c,
            &k,
            &keycheck::app_id(account, path),
        ),
        _ => false,
    }
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

    // ---- X12F-01 key check: real v1.signer answers and the near/mpc vectors ----

    const MAINNET_MPK: &str = "bls12381g2:24mhN4RnB2CbiUkAfukyh4s1CT6dUNd9Pc8kRnL4LvAP3tcxhUupbphmfbmwHSi66aFCiZkMgiH2KqXWJLD7JUeAFhoLS3WQbzWcpUzhERLqxyocwT9Xrd4WNvEuKavxmXdR";
    const TESTNET_MPK: &str = "bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj";
    /// Signer of the S1 spikes (evidence/spikes/s1-*.json `caller`).
    const S1_CALLER: &str = "0a92bc62601112332a225ea19961d549bb4b689bbd723f5dcf1f19bab5212620";
    const S1_ID_Y: &str =
        "bls12381g1:7agABzwCzSKHWqkGhQ5wYK1MHaDefJ4Fo4SKDK1VkNY4XowxRVdHpRbShAhwKChRbA";
    const S1_ID_C: &str =
        "bls12381g1:5mpVvTmcVhUiJGixSuCkGs55xYBQ71sDR5Fida1C7U28pizzdgDJFSMpFLtYvsNUnS";
    const S1_ID_PATH: &str = "tender-spike/s1/identity/1";
    const S6_Y: &str =
        "bls12381g1:5rRz24DcpQi4igrFTDmZX15vDo5sWRjRGdSKV9iHuJFQpwBGAYms7WbwQXbZejyjS2";
    const S6_C: &str =
        "bls12381g1:6Kadwq5ZceAbzKsLuCkP1eQW57wnsmUEpJa6UY36bS5mv1rgAAnVZkXaxeSUi3fiGt";

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn vm() {
        near_sdk::testing_env!(
            near_sdk::test_utils::VMContextBuilder::new()
                .prepaid_gas(Gas::from_tgas(300))
                .build()
        );
    }

    #[test]
    fn reduce_mod_p_edges() {
        let mut x = [0u8; 64];
        x[63] = 5;
        assert_eq!(keycheck::reduce_mod_p(&x)[47], 5);
        let p = hex(
            "1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab",
        );
        let mut x = [0u8; 64];
        x[16..].copy_from_slice(&p);
        assert_eq!(keycheck::reduce_mod_p(&x), [0u8; 48]);
        // (2^512 − 1) mod p, computed with Python integers.
        assert_eq!(
            hex_lower(&keycheck::reduce_mod_p(&[0xff; 64])),
            "02cb5d3a884e56c4fab7cd07ee4e16bc15efebb5d396d7cf82383087033108464532383fa8eaff4e967d3988a62b6c9c"
        );
    }

    /// `hash_to_g1(pk ‖ app_id)` equals `hash_point` of every near/mpc CKD test vector, and the
    /// a = 1 vectors pass the check in generator mode only.
    #[test]
    fn hash_to_g1_matches_ckd_vectors() {
        vm();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/ckd_test_vectors.json"
        );
        let j: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut n = 0;
        for v in j["vectors"].as_array().unwrap() {
            let f = |k: &str| hex(v[k].as_str().unwrap());
            let pk = f("pk");
            let want = env::bls12381_p1_decompress(f("hash_point")).unwrap();
            assert_eq!(
                keycheck::hash_to_g1(&[pk.as_slice(), &f("app_id")].concat()),
                Some(want)
            );
            let app: [u8; 32] = f("app_id").try_into().unwrap();
            let a = v["a"].as_str().unwrap();
            if a.trim_start_matches('0') == "1" {
                assert!(keycheck::key_ok(false, &f("big_y"), &f("big_c"), &pk, &app));
                assert!(!keycheck::key_ok(true, &f("big_y"), &f("big_c"), &pk, &app));
            }
            n += 1;
        }
        assert!(n >= 4);
    }

    /// Real mainnet identity answer (S1, tx 8F5AFdFs…): our app_id equals the recorded one and
    /// the key passes; another path, account, mode, key order, C at infinity or C not a point
    /// fails without a panic.
    #[test]
    fn key_check_mainnet_identity_and_rejections() {
        vm();
        assert_eq!(
            hex_lower(&keycheck::app_id(S1_CALLER, S1_ID_PATH)),
            "3e51e6e259f1bdb4924b943b3f226be074d34185c628dcfd82f8bb95b632a3cd"
        );
        let id = AppPkMode::Identity;
        fn ok(m: AppPkMode, y: &str, c: &str, acct: &str, path: &str) -> bool {
            key_matches(m, y, c, MAINNET_MPK, acct, path)
        }
        assert!(ok(id, S1_ID_Y, S1_ID_C, S1_CALLER, S1_ID_PATH));
        assert!(!ok(
            id,
            S1_ID_Y,
            S1_ID_C,
            S1_CALLER,
            "tender-spike/s1/identity/2"
        ));
        assert!(!ok(id, S1_ID_Y, S1_ID_C, "v1.tenderseal.near", S1_ID_PATH));
        assert!(!ok(
            AppPkMode::Generator,
            S1_ID_Y,
            S1_ID_C,
            S1_CALLER,
            S1_ID_PATH
        ));
        assert!(!ok(id, S1_ID_C, S1_ID_Y, S1_CALLER, S1_ID_PATH));
        let mut inf = [0u8; 48];
        inf[0] = 0xc0;
        let g1 = |b: &[u8]| format!("{G1_PREFIX}{}", near_sdk::bs58::encode(b).into_string());
        assert!(!ok(id, S1_ID_Y, &g1(&inf), S1_CALLER, S1_ID_PATH));
        assert!(!ok(id, S1_ID_Y, &g1(&[0x80; 48]), S1_CALLER, S1_ID_PATH));
        assert!(!ok(id, S1_ID_Y, "garbage", S1_CALLER, S1_ID_PATH));
        assert!(!key_matches(
            id,
            S1_ID_Y,
            S1_ID_C,
            "bls12381g2:x",
            S1_CALLER,
            S1_ID_PATH
        ));
    }

    /// Real mainnet generator answer (S1-generator, tx 6xyJWF2E…).
    #[test]
    fn key_check_mainnet_generator() {
        vm();
        let y = "bls12381g1:6BH2QyyQAW7oFUJYZLm3yxs9TDsL2ou8JWwVUVtVAExBGDSURVY717pXh6bM4wEtX4";
        let c = "bls12381g1:7AvCUFvQuh8oHD897FwBZBUTHrzeeXwKgeErssUP2R1prTbP55Ub1eD5QR2k68p1pP";
        let path = "tender-spike/s1/generator/1";
        let ok = |m| key_matches(m, y, c, MAINNET_MPK, S1_CALLER, path);
        assert!(ok(AppPkMode::Generator));
        assert!(ok(AppPkMode::Plain));
        assert!(!ok(AppPkMode::Identity));
        assert!(!key_matches(
            AppPkMode::Generator,
            y,
            c,
            MAINNET_MPK,
            S1_CALLER,
            S1_ID_PATH
        ));
    }

    /// A contract caller on mainnet (S6, `spike.tenderseal.near`), and the same answer checked
    /// against another pinned key (a changed domain-2 key) or a G2 key at infinity.
    #[test]
    fn key_check_contract_caller_and_changed_key() {
        vm();
        let path = "tender-spike/s6/1";
        let acct = "spike.tenderseal.near";
        assert_eq!(
            hex_lower(&keycheck::app_id(acct, path)),
            "42f82cf8a87aa6861236b3766acfb5b1f5798958b54adb74c52a0c67a98735b5"
        );
        let id = AppPkMode::Identity;
        assert!(key_matches(id, S6_Y, S6_C, MAINNET_MPK, acct, path));
        assert!(!key_matches(id, S6_Y, S6_C, TESTNET_MPK, acct, path));
        let mut inf = [0u8; 96];
        inf[0] = 0xc0;
        let inf = format!("{G2_PREFIX}{}", near_sdk::bs58::encode(inf).into_string());
        assert!(!key_matches(id, S6_Y, S6_C, &inf, acct, path));
    }

    /// Testnet answers in all three modes (s1-testnet-*.json), and the key a real Tender
    /// contract stored for a real sale path (M3 rehearsal, `v1.tender-09bdfe.testnet` sale 0).
    #[test]
    fn key_check_testnet_modes_and_m3_contract() {
        vm();
        let acct = "tender-s1-164b59.testnet";
        let cases = [
            (
                AppPkMode::Plain,
                "bls12381g1:7Rgu791rdAr2M1taXkNDQXvUWG9ZzbFL8uiEKcZ4r3vuSEQq7Hhf3vohNiBs6qpeRZ",
                "bls12381g1:7AdyDWJeJgE7KxoCyoS2Q8TVjp9VoBYqiXyE9MWW6DMcd6365xxgPbK5tdK6bW7dZE",
                "tender-spike/s1-testnet/plain/1",
            ),
            (
                AppPkMode::Generator,
                "bls12381g1:7aey3TJJWiHi3vz18GqPcEmtHqoKf9sTjebsPwLETAvrBa5xdJyjZUxy1nW9YDDb7B",
                "bls12381g1:7EddFFncsXq86SvRRsuYf3FvWBSzik82PUrfUSVomFfEDt1LcnPP9HJtNpw5bajvkP",
                "tender-spike/s1-testnet/generator/1",
            ),
            (
                AppPkMode::Identity,
                S1_Y,
                S1_C,
                "tender-spike/s1-testnet/identity/1",
            ),
        ];
        for (mode, y, c, path) in cases {
            assert!(key_matches(mode, y, c, TESTNET_MPK, acct, path), "{path}");
            assert!(!key_matches(mode, y, c, MAINNET_MPK, acct, path), "{path}");
        }
        let m3 = "v1.tender-09bdfe.testnet";
        let m3_path = "tender/0/f774cf89643a17d7a89e520b5510ccd8";
        let y = "bls12381g1:5t67chajyMfBKDbtDXLzJMTtSLg6fBNLyB43AykRPEqfFEnsuZ7i1CnnHTnpqgrTXZ";
        let c = "bls12381g1:7iZwDu1FoMqYLgfhirjPr6FBZ1cWGeD98yriBgg3dLyoR48f13r5wTrW8X53764te5";
        let id = AppPkMode::Identity;
        assert!(key_matches(id, y, c, TESTNET_MPK, m3, m3_path));
        assert!(!key_matches(
            id,
            y,
            c,
            TESTNET_MPK,
            "tender-09bdfe.testnet",
            m3_path
        ));
        assert!(!key_matches(id, y, c, MAINNET_MPK, m3, m3_path));
    }

    #[test]
    fn mpc_key_ok_only_for_a_g2_point() {
        vm();
        assert!(mpc_key_ok(MAINNET_MPK));
        assert!(mpc_key_ok(TESTNET_MPK));
        assert!(mpc_key_ok(GENERATOR_PK2));
        assert!(!mpc_key_ok(IDENTITY_PK2));
        assert!(!mpc_key_ok("bls12381g2:x"));
        assert!(!mpc_key_ok(&MAINNET_MPK.replace("g2", "g1")));
        let off = format!(
            "{G2_PREFIX}{}",
            near_sdk::bs58::encode([0x87u8; 96]).into_string()
        );
        assert!(!mpc_key_ok(&off));
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
