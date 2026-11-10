//! Spike contract for gates S3b (Intents notification on mainnet) and S6 (no link error on
//! mainnet), plus S6-ckd: what a contract's callback receives when it asks `v1.signer` for a CKD
//! key. Deployed to `spike.tenderseal.near` only, never to `v1.tenderseal.near`.
//!
//! Every cross-contract call uses the low-level `env::promise_*` API on purpose: near-sdk's
//! `Promise` links every action host function (add_key, deploy_contract, ...), which fails the
//! import check and can fail the deploy with a link error. Pattern from `defdone/annon`
//! `contracts/annon/src/mpc.rs` (Apache-2.0).
use near_sdk::json_types::U128;
use near_sdk::serde_json::{Value, json};
use near_sdk::{AccountId, Gas, GasWeight, NearToken, env, near};

const DEFAULT_INTENTS: &str = "intents.near";
const DEFAULT_MPC: &str = "v1.signer";
const DEFAULT_DOMAIN: u64 = 2;

const PAYBACK_GAS: Gas = Gas::from_tgas(20);
const ON_PAYBACK_GAS: Gas = Gas::from_tgas(5);
/// MPC asks for at least 15 Tgas today; the call also gets the unused gas (weight 1).
const CKD_GAS: Gas = Gas::from_tgas(30);
const ON_CKD_GAS: Gas = Gas::from_tgas(15);

// AppPublicKeyPV pairs for identity and generator mode, and the plain G1 generator (S1-C).
const IDENTITY_PK1: &str =
    "bls12381g1:83VnBdpeT9ioHuUTBD2zcitXg7JqNiebUs5yxDaYaLgZYDLLk2gayHrJKNyRt4vBQB";
const IDENTITY_PK2: &str = "bls12381g2:2995BcogDeU9PQxbssLWhG9J76ubezYVpjbceWnwcmRs9ypA2vYDikf8mpuzankQX6WMsDockieKarmDerS2xTPzR1dktiHiGkjvPpRYpDip6unu4WgtPqeCPtxqppMzuGwy";
const GENERATOR_PK1: &str =
    "bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp";
const GENERATOR_PK2: &str = "bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK";

#[near(contract_state)]
#[derive(Default)]
pub struct Spike {}

fn account(id: &str) -> AccountId {
    id.parse()
        .unwrap_or_else(|_| env::panic_str("bad account id"))
}

fn join<T: ToString>(items: &[T]) -> String {
    items
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn app_public_key(mode: &str) -> Value {
    match mode {
        "identity" => json!({ "AppPublicKeyPV": { "pk1": IDENTITY_PK1, "pk2": IDENTITY_PK2 } }),
        "generator" => json!({ "AppPublicKeyPV": { "pk1": GENERATOR_PK1, "pk2": GENERATOR_PK2 } }),
        "plain" => json!({ "AppPublicKey": GENERATOR_PK1 }),
        _ => env::panic_str("mode must be identity, generator or plain"),
    }
}

#[near]
impl Spike {
    pub fn ping(&self) -> String {
        "ok".to_string()
    }

    /// NEP-245 receiver. Logs what intents.near sent. `msg == "late"` refunds everything, any
    /// other msg keeps everything. No predecessor check on purpose (spike only).
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        env::log_str(&format!(
            "spike:mt_on_transfer predecessor={} sender={} prev={} tokens={} amounts={} msg={}",
            env::predecessor_account_id(),
            sender_id,
            join(&previous_owner_ids),
            token_ids.join(","),
            join(&amounts.iter().map(|a| a.0).collect::<Vec<_>>()),
            msg,
        ));
        if msg == "late" {
            amounts
        } else {
            vec![U128(0); amounts.len()]
        }
    }

    /// Pays `amount` of `token_id` from this contract's Intents balance to `receiver_id` with
    /// `mt_batch_transfer` (1 yocto from the contract balance), then logs the outcome.
    pub fn payback(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        intents: Option<AccountId>,
    ) {
        let intents = intents.unwrap_or_else(|| account(DEFAULT_INTENTS));
        let args = json!({
            "receiver_id": receiver_id,
            "token_ids": [token_id],
            "amounts": [amount],
        });
        let p = env::promise_batch_create(&intents);
        env::promise_batch_action_function_call_weight(
            p,
            "mt_batch_transfer",
            args.to_string().as_bytes(),
            NearToken::from_yoctonear(1),
            PAYBACK_GAS,
            GasWeight(0),
        );
        let then = env::promise_batch_then(p, &env::current_account_id());
        env::promise_batch_action_function_call_weight(
            then,
            "on_payback",
            b"{}",
            NearToken::from_yoctonear(0),
            ON_PAYBACK_GAS,
            GasWeight(0),
        );
        env::promise_return(then);
    }

    #[private]
    pub fn on_payback(&mut self) {
        match env::promise_result_checked(0, 64) {
            Ok(_) => env::log_str("spike:payback ok"),
            Err(_) => env::log_str("spike:payback err"),
        }
    }

    /// Asks the MPC contract for this contract's CKD key at `path` in `mode` (identity,
    /// generator or plain). 1 yocto from the contract balance. The MPC answer (or an error JSON)
    /// becomes the return value.
    pub fn ckd(
        &mut self,
        path: String,
        mode: String,
        mpc: Option<AccountId>,
        domain_id: Option<u64>,
    ) {
        let mpc = mpc.unwrap_or_else(|| account(DEFAULT_MPC));
        let args = json!({ "request": {
            "derivation_path": path,
            "app_public_key": app_public_key(&mode),
            "domain_id": domain_id.unwrap_or(DEFAULT_DOMAIN),
        }});
        let p = env::promise_batch_create(&mpc);
        env::promise_batch_action_function_call_weight(
            p,
            "request_app_private_key",
            args.to_string().as_bytes(),
            NearToken::from_yoctonear(1),
            CKD_GAS,
            GasWeight(1),
        );
        let then = env::promise_batch_then(p, &env::current_account_id());
        env::promise_batch_action_function_call_weight(
            then,
            "on_ckd",
            json!({ "path": path, "mode": mode }).to_string().as_bytes(),
            NearToken::from_yoctonear(0),
            ON_CKD_GAS,
            GasWeight(0),
        );
        env::promise_return(then);
    }

    #[private]
    pub fn on_ckd(&mut self, path: String, mode: String) {
        match env::promise_result_checked(0, 1024) {
            Ok(raw) => {
                env::log_str(&format!(
                    "spike:ckd ok mode={} path={} {}",
                    mode,
                    path,
                    String::from_utf8_lossy(&raw)
                ));
                env::value_return(&raw);
            }
            Err(_) => {
                env::log_str(&format!("spike:ckd err mode={} path={}", mode, path));
                env::value_return(b"{\"error\":\"mpc failed\"}");
            }
        }
    }
}
