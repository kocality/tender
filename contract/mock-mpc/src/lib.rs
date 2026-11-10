//! Mock of `v1.signer` `request_app_private_key` for the sandbox tests. It returns a fixed
//! `{big_y, big_c}` JSON (the gate S1 response once it exists) in the same receipt instead of
//! running MPC, so the sandbox never sees the real yield/resume delay or timeout. Sandbox and
//! testnet only. Same role as defdone/annon `contracts/mock-mpc` (Apache-2.0).
use near_sdk::serde_json::{self, Value};
use near_sdk::{Gas, NearToken, env, near};

/// Valid 48-byte compressed G1 points (the G1 generator), used until the S1 fixture exists.
const DEFAULT_RESPONSE: &str = r#"{"big_y":"bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp","big_c":"bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp"}"#;

/// Same floor as v1.signer 3.18.0 (`ckd_call_gas_attachment_requirement_tera_gas = 15`).
const MIN_GAS: Gas = Gas::from_tgas(15);

#[near(contract_state)]
pub struct MockMpc {
    response: String,
    fail: bool,
    calls: u32,
    last_request: String,
    last_predecessor: String,
}

impl Default for MockMpc {
    fn default() -> Self {
        Self {
            response: DEFAULT_RESPONSE.to_string(),
            fail: false,
            calls: 0,
            last_request: String::new(),
            last_predecessor: String::new(),
        }
    }
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
        serde_json::from_str(&self.response)
            .unwrap_or_else(|_| env::panic_str("mock-mpc: stored response is not JSON"))
    }

    pub fn set_response(&mut self, json: String) {
        self.response = json;
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
}
