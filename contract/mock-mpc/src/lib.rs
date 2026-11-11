//! Mock of `v1.signer` `request_app_private_key` for the sandbox tests. It answers in the same
//! receipt instead of running MPC, so the sandbox never sees the real yield/resume delay or
//! timeout. Sandbox and testnet only. Same role as defdone/annon `contracts/mock-mpc`
//! (Apache-2.0).
//!
//! The answer is a real CKD for master secret 1 (domain-2 key = the G2 generator, `MPK`) and
//! y = 1: `big_y = G1`, `big_c = H(MPK ‖ app_id(predecessor, path)) + A`, where A is the
//! request's app public key (the point at infinity in identity mode). So the caller's own
//! key check (X12F-01) passes for `MPK`, and `set_response` stores a fixed answer instead (a
//! changed key, a malformed one).
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{Gas, NearToken, env, near};

// The contract's own key-check code; the contract's unit tests pin it to real v1.signer answers
// and the near/mpc vectors independently, so a bug shared with the mock cannot hide.
#[path = "../../src/keycheck.rs"]
#[allow(dead_code)]
mod keycheck;

/// Same floor as v1.signer 3.18.0 (`ckd_call_gas_attachment_requirement_tera_gas = 15`).
const MIN_GAS: Gas = Gas::from_tgas(15);
const G1_PREFIX: &str = "bls12381g1:";
/// Compressed G1 generator (`tender::seal::GENERATOR_PK1`).
const G1: &str = "bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp";
/// Domain-2 public key of the mock: the compressed G2 generator (`tender::seal::GENERATOR_PK2`).
pub const MPK: &str = "bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK";

#[near(contract_state)]
#[derive(Default)]
pub struct MockMpc {
    /// A fixed answer set by `set_response`; `None` computes the real CKD.
    response: Option<String>,
    fail: bool,
    calls: u32,
    last_request: String,
    last_predecessor: String,
}

fn bad(what: &str) -> ! {
    env::panic_str(&format!("mock-mpc: {what}"))
}

/// Uncompressed G1 (96 bytes) to compressed (48): x with flag 0x80, plus 0x20 when y is the
/// larger of {y, p − y}; infinity is 0xc0 and zeros.
fn compress(p: &[u8]) -> Vec<u8> {
    if p[0] & 0x40 != 0 {
        let mut inf = vec![0u8; 48];
        inf[0] = 0xc0;
        return inf;
    }
    let neg = env::bls12381_p1_sum([&[1u8][..], p].concat()).unwrap_or_else(|| bad("negate"));
    let mut out = p[..48].to_vec();
    out[0] |= 0x80;
    if p[48..96] > neg[48..96] {
        out[0] |= 0x20;
    }
    out
}

fn g1_text(p: &[u8]) -> String {
    format!(
        "{G1_PREFIX}{}",
        near_sdk::bs58::encode(compress(p)).into_string()
    )
}

fn decompress_g1(s: &str) -> Vec<u8> {
    let b = keycheck::decode_point(s, G1_PREFIX, keycheck::G1_BYTES)
        .unwrap_or_else(|| bad("app public key is not bls12381g1"));
    env::bls12381_p1_decompress(b).unwrap_or_else(|| bad("app public key is not a G1 point"))
}

/// `{big_y, big_c}` for msk = 1, y = 1.
fn ckd(request: &Value, caller: &str) -> Value {
    let path = request["derivation_path"]
        .as_str()
        .unwrap_or_else(|| bad("derivation_path"));
    let app_pk = &request["app_public_key"];
    let pk1 = app_pk["AppPublicKeyPV"]["pk1"]
        .as_str()
        .or_else(|| app_pk["AppPublicKey"].as_str())
        .unwrap_or_else(|| bad("app_public_key"));
    let mpk = keycheck::decode_point(MPK, "bls12381g2:", keycheck::G2_BYTES).unwrap();
    let app_id = keycheck::app_id(caller, path);
    let h = keycheck::hash_to_g1(&[mpk.as_slice(), &app_id].concat())
        .unwrap_or_else(|| bad("hash_to_g1"));
    let a = decompress_g1(pk1);
    let c =
        env::bls12381_p1_sum([&[0u8][..], &h, &[0u8], &a].concat()).unwrap_or_else(|| bad("sum"));
    json!({ "big_y": g1_text(&decompress_g1(G1)), "big_c": g1_text(&c) })
}

#[near]
impl MockMpc {
    /// Same checks as the real contract that matter here: ≥ 1 yocto and ≥ 15 Tgas. With
    /// `fail` set it panics with the real timeout text, so the caller's callback sees a
    /// failed promise.
    #[payable]
    pub fn request_app_private_key(&mut self, request: Value) -> Value {
        if env::attached_deposit() < NearToken::from_yoctonear(1) {
            env::panic_str("Attached deposit is lower than required");
        }
        if env::prepaid_gas() < MIN_GAS {
            env::panic_str("Attached gas is less than the required gas");
        }
        self.calls += 1;
        self.last_request = request.to_string();
        self.last_predecessor = env::predecessor_account_id().to_string();
        if self.fail {
            env::panic_str("Request has timed out");
        }
        match &self.response {
            Some(r) => serde_json::from_str(r)
                .unwrap_or_else(|_| env::panic_str("mock-mpc: stored response is not JSON")),
            None => ckd(&request, &self.last_predecessor),
        }
    }

    pub fn set_response(&mut self, json: String) {
        self.response = Some(json);
    }

    /// Back to the computed answer.
    pub fn clear_response(&mut self) {
        self.response = None;
    }

    pub fn set_fail(&mut self, fail: bool) {
        self.fail = fail;
    }

    pub fn calls(&self) -> u32 {
        self.calls
    }

    pub fn last_request(&self) -> String {
        self.last_request.clone()
    }

    pub fn last_predecessor(&self) -> String {
        self.last_predecessor.clone()
    }

    /// The domain-2 public key the computed answers are made for.
    pub fn public_key(&self) -> String {
        MPK.to_string()
    }
}
