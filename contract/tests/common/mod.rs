//! Shared helpers for the sandbox tests (near-workspaces 0.24.0, nearcore 2.14.0 sandbox).
//! Wasm files are read from disk; build them first with `bash contract/scripts/build-wasms.sh`.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::Value;

pub const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

/// Valid 48-byte compressed G1 point (the generator), used until the S1 fixture exists.
pub const DEFAULT_G1: &str =
    "bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp";

/// Wasm path from `env_var` if set (relative values resolve against `contract/`), else
/// `contract/<default_rel>`.
pub fn wasm_path(env_var: &str, default_rel: &str) -> PathBuf {
    match std::env::var(env_var) {
        Ok(v) => {
            let p = PathBuf::from(&v);
            if p.is_absolute() {
                p
            } else {
                Path::new(MANIFEST_DIR).join(p)
            }
        }
        Err(_) => PathBuf::from(format!("{MANIFEST_DIR}{default_rel}")),
    }
}

pub fn tender_wasm_path() -> PathBuf {
    wasm_path("TENDER_WASM", "/target/near/tender.wasm")
}

pub fn spike_wasm_path() -> PathBuf {
    wasm_path("SPIKE_WASM", "/spike/target/near/tender_spike.wasm")
}

pub fn mock_mpc_wasm_path() -> PathBuf {
    wasm_path("MOCK_MPC_WASM", "/mock-mpc/target/near/mock_mpc.wasm")
}

pub fn mock_ft_wasm_path() -> PathBuf {
    wasm_path("MOCK_FT_WASM", "/tests/mock-ft/target/near/mock_ft.wasm")
}

pub fn defuse_wasm_path() -> PathBuf {
    wasm_path("DEFUSE_WASM", "/tests/res/defuse-0.4.5.wasm")
}

pub fn read_wasm(p: &Path) -> Vec<u8> {
    std::fs::read(p).unwrap_or_else(|_| {
        panic!(
            "{} missing: run contract/scripts/build-wasms.sh",
            p.display()
        )
    })
}

// ---- S1 fixture (DEC G4, WD-18) ----

fn s1_row() -> Option<Value> {
    let raw = std::fs::read_to_string(format!("{MANIFEST_DIR}/../evidence/spikes.json")).ok()?;
    let rows: Value = serde_json::from_str(&raw).ok()?;
    rows.as_array()?
        .iter()
        .find(|r| r.get("gate").and_then(Value::as_str) == Some("S1"))
        .cloned()
}

fn s1_file(mode: &str) -> Option<Value> {
    let raw = std::fs::read_to_string(format!("{MANIFEST_DIR}/../evidence/spikes/s1-{mode}.json"))
        .ok()?;
    serde_json::from_str(&raw).ok()
}

/// App public key mode chosen by gate S1: `chosen_path` of the `gate == "S1"` row in
/// `evidence/spikes.json`. Falls back to `identity` (ASSUMES s1 fixture) when the row, or the
/// matching `evidence/spikes/s1-<mode>.json` response, does not exist yet.
pub fn s1_mode() -> String {
    let mode = s1_row()
        .and_then(|r| {
            r.get("chosen_path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|m| matches!(m.as_str(), "identity" | "generator" | "plain"));
    match mode {
        Some(m)
            if s1_file(&m)
                .and_then(|f| f.get("response").cloned())
                .is_some() =>
        {
            m
        }
        _ => "identity".to_string(),
    }
}

/// The `{big_y, big_c}` JSON the mock MPC returns: the S1 response for `s1_mode()`, or the
/// default G1 pair before S1.
pub fn s1_response() -> String {
    s1_file(&s1_mode())
        .and_then(|f| f.get("response").cloned())
        .map(|r| r.to_string())
        .unwrap_or_else(|| format!(r#"{{"big_y":"{DEFAULT_G1}","big_c":"{DEFAULT_G1}"}}"#))
}

/// Second mock fixture: the S6-ckd response (a contract-made CKD on mainnet), if recorded.
pub fn s6_ckd_response() -> Option<String> {
    let raw =
        std::fs::read_to_string(format!("{MANIFEST_DIR}/../evidence/spikes/s6-ckd.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("response").map(|r| r.to_string())
}

// ---- deploy helpers ----

pub async fn sub(parent: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(parent
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

/// Deploys mock-mpc on `mpc.<root>` and loads the S1 response into it.
pub async fn deploy_mock_mpc(root: &Account) -> anyhow::Result<Contract> {
    let acc = sub(root, "mpc", 10).await?;
    let mpc = acc
        .deploy(&read_wasm(&mock_mpc_wasm_path()))
        .await?
        .into_result()?;
    mpc.call("set_response")
        .args_json(serde_json::json!({ "json": s1_response() }))
        .transact()
        .await?
        .into_result()?;
    Ok(mpc)
}

pub fn tgas(n: u64) -> Gas {
    Gas::from_tgas(n)
}

pub fn yocto(n: u128) -> NearToken {
    NearToken::from_yoctonear(n)
}

/// Debug text of a failed execution, for matching panic messages.
pub fn failure_text<T: std::fmt::Debug>(r: &T) -> String {
    format!("{r:?}")
}

pub async fn sandbox() -> anyhow::Result<Worker<Sandbox>> {
    Ok(near_workspaces::sandbox().await?)
}

// ---- Intents world ----

pub const USDC: &str = "nep141:usdc.test.near";
pub const WNEAR: &str = "nep141:wnear.test.near";
pub const BIDDERS: [&str; 6] = ["alice", "bob", "carol", "dave", "erin", "frank"];

pub struct World {
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub intents: Contract,
    pub usdc: Contract,
    pub wnear: Contract,
    pub mpc: Contract,
    /// `tenderseal.test.near`: the team / seller account.
    pub seller: Account,
    /// alice, bob, carol, dave, erin, frank (`.test.near`).
    pub bidders: Vec<Account>,
}

async fn deploy_ft(root: &Account, name: &str, decimals: u8) -> anyhow::Result<Contract> {
    let acc = sub(root, name, 10).await?;
    let ft = acc
        .deploy(&read_wasm(&mock_ft_wasm_path()))
        .await?
        .into_result()?;
    ft.call("new")
        .args_json(serde_json::json!({
            "owner_id": root.id(), "decimals": decimals, "symbol": name.to_uppercase()
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(ft)
}

/// Sandbox with intents.near 0.4.5 (`intents.test.near`), mock USDC (6) and wNEAR (24), mock
/// MPC (`mpc.test.near`, S1 response loaded), the seller and six bidders. Intents is
/// registered on both FTs.
pub async fn world() -> anyhow::Result<World> {
    let worker = sandbox().await?;
    let root = worker.root_account()?;

    let intents_acc = sub(&root, "intents", 50).await?;
    let intents = intents_acc
        .deploy(&read_wasm(&defuse_wasm_path()))
        .await?
        .into_result()?;
    intents
        .call("new")
        .args_json(serde_json::json!({ "config": {
            "wnear_id": "wnear.test.near",
            "fees": { "fee": 0, "fee_collector": root.id() },
            "roles": { "super_admins": [], "admins": {}, "grantees": { "DAO": [root.id()] } }
        }}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let usdc = deploy_ft(&root, "usdc", 6).await?;
    let wnear = deploy_ft(&root, "wnear", 24).await?;
    for ft in [&usdc, &wnear] {
        root.call(ft.id(), "storage_deposit")
            .args_json(serde_json::json!({ "account_id": intents.id() }))
            .deposit(NearToken::from_millinear(125))
            .transact()
            .await?
            .into_result()?;
    }
    let mpc = deploy_mock_mpc(&root).await?;
    let seller = sub(&root, "tenderseal", 30).await?;
    let mut bidders = Vec::new();
    for b in BIDDERS {
        bidders.push(sub(&root, b, 10).await?);
    }
    Ok(World {
        worker,
        root,
        intents,
        usdc,
        wnear,
        mpc,
        seller,
        bidders,
    })
}

pub async fn mint(ft: &Contract, to: &str, amount: u128) -> anyhow::Result<()> {
    ft.call("mint")
        .args_json(serde_json::json!({ "account_id": to, "amount": amount.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// `ft_transfer_call` from `from` to intents. `to = None` credits `from` itself (msg ""), else
/// the named Intents account (msg = account id).
pub async fn deposit_to_intents(
    ft: &Contract,
    intents: &Contract,
    from: &Account,
    amount: u128,
    to: Option<&str>,
) -> anyhow::Result<()> {
    from.call(ft.id(), "ft_transfer_call")
        .args_json(serde_json::json!({
            "receiver_id": intents.id(),
            "amount": amount.to_string(),
            "msg": to.unwrap_or(""),
        }))
        .deposit(yocto(1))
        .gas(tgas(100))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn mt_balance(intents: &Contract, account: &str, token_id: &str) -> anyhow::Result<u128> {
    let v: String = intents
        .view("mt_balance_of")
        .args_json(serde_json::json!({ "account_id": account, "token_id": token_id }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

/// Deterministic ed25519 key; its Intents account is the 64-hex implicit account.
pub fn raw_ed25519_signer(seed: u8) -> (ed25519_dalek::SigningKey, String) {
    let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let hex = to_hex(&sk.verifying_key().to_bytes());
    (sk, hex)
}

pub fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

/// RFC 3339 UTC with millisecond precision, e.g. `2026-11-13T02:10:00.000Z` (DEC G7).
pub fn rfc3339_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

static NONCE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Versioned nonce V1 (DEC I4): magic `5628f6c6` ‖ `00` ‖ salt (4) ‖ deadline i64 LE ns ‖ 15
/// unique bytes.
pub fn versioned_nonce(salt_hex: &str, deadline_ms: u64) -> [u8; 32] {
    let mut n = [0u8; 32];
    n[..4].copy_from_slice(&[0x56, 0x28, 0xf6, 0xc6]);
    n[5..9].copy_from_slice(&hex_to_bytes(salt_hex));
    n[9..17].copy_from_slice(&((deadline_ms as i64) * 1_000_000).to_le_bytes());
    let c = NONCE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    n[17..25].copy_from_slice(&t.to_le_bytes());
    n[25..32].copy_from_slice(&c.to_le_bytes()[..7]);
    n
}

/// Payload string + raw_ed25519 `MultiPayload` for one Transfer intent, signed by `signer`.
/// Deadline now + 10 min, whole seconds (payload and nonce carry the same instant).
#[allow(clippy::too_many_arguments)]
pub async fn signed_transfer(
    intents: &Contract,
    signer: &ed25519_dalek::SigningKey,
    receiver: &str,
    token: &str,
    amount: u128,
    msg: &str,
) -> anyhow::Result<Value> {
    use ed25519_dalek::Signer;
    use near_sdk::base64::Engine;
    let salt: String = intents.view("current_salt").await?.json()?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    let deadline_ms = (now_ms + 600_000) / 1000 * 1000;
    let nonce = versioned_nonce(&salt, deadline_ms);
    let signer_id = to_hex(&signer.verifying_key().to_bytes());
    let payload = serde_json::json!({
        "signer_id": signer_id,
        "verifying_contract": intents.id(),
        "deadline": rfc3339_ms(deadline_ms),
        "nonce": near_sdk::base64::engine::general_purpose::STANDARD.encode(nonce),
        "intents": [{
            "intent": "transfer",
            "receiver_id": receiver,
            "tokens": { token: amount.to_string() },
            "msg": msg,
            "min_gas": "30000000000000",
        }],
    })
    .to_string();
    let sig = signer.sign(payload.as_bytes()).to_bytes();
    Ok(serde_json::json!({
        "standard": "raw_ed25519",
        "payload": payload,
        "public_key": format!("ed25519:{}", near_sdk::bs58::encode(signer.verifying_key().to_bytes()).into_string()),
        "signature": format!("ed25519:{}", near_sdk::bs58::encode(sig).into_string()),
    }))
}

pub async fn execute_intents(
    relayer: &Account,
    intents: &Contract,
    signed: Vec<Value>,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(relayer
        .call(intents.id(), "execute_intents")
        .args_json(serde_json::json!({ "signed": signed }))
        .gas(tgas(300))
        .transact()
        .await?)
}

// ---- Tender deploy ----

/// Testnet domain-2 key shape; the contract only stores it (no BLS on chain).
pub const MPC_PK: &str = "bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj";

pub fn tender_id(w: &World) -> near_workspaces::AccountId {
    format!("v1.{}", w.seller.id()).parse().unwrap()
}

pub fn new_args(w: &World, mode: &str) -> Value {
    serde_json::json!({
        "mpc": w.mpc.id(),
        "intents": w.intents.id(),
        "domain_id": 2,
        "app_pk_mode": mode,
        "mpc_public_key": MPC_PK,
        "quote_tokens": [USDC],
        "sellers": [w.seller.id()],
    })
}

/// Keyless birth in one transaction signed by the parent (C1): CreateAccount + Transfer +
/// DeployContract + FunctionCall `new`. No AddKey.
pub async fn deploy_tender_with(
    w: &World,
    mode: &str,
    balance: NearToken,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    use near_workspaces::operations::Function;
    Ok(w.seller
        .batch(&tender_id(w))
        .create_account()
        .transfer(balance)
        .deploy(&read_wasm(&tender_wasm_path()))
        .call(
            Function::new("new")
                .args_json(new_args(w, mode))
                .gas(tgas(50)),
        )
        .transact()
        .await?)
}

/// `deploy_tender_with(s1_mode(), 4.5 NEAR)`, asserting success.
pub async fn deploy_tender(w: &World) -> anyhow::Result<near_workspaces::AccountId> {
    let r = deploy_tender_with(w, &s1_mode(), NearToken::from_millinear(4500)).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    Ok(tender_id(w))
}

pub async fn view_json(
    w: &World,
    id: &near_workspaces::AccountId,
    method: &str,
    args: Value,
) -> anyhow::Result<Value> {
    Ok(w.worker.view(id, method).args_json(args).await?.json()?)
}

// ---- sales, bids, time travel (WD-07) ----

pub const ONE_USDC: u128 = 1_000_000;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Default create msg for `close_ns`: 1 NEAR-style sale (d 24, lot 0), reserve 3.00, min_escrow
/// 5 USDC, min_bidders 3, max_bids 16, reveal 86 400 s. Override fields with `f`.
pub fn create_msg(close_ns: u64, f: impl FnOnce(&mut Value)) -> Value {
    let mut m = serde_json::json!({
        "op": "create", "close_ns": close_ns.to_string(), "reveal_secs": "86400",
        "reserve": "3000000", "min_escrow": "5000000", "min_bidders": 3, "quote_token": USDC,
        "max_bids": 16, "decimals": 24, "lot_exp": 0
    });
    f(&mut m);
    m
}

pub async fn now_ns(w: &World) -> anyhow::Result<u64> {
    Ok(w.worker.view_block().await?.timestamp())
}

/// `from` moves `amount` of its own Intents balance of `token_id` to `receiver` with `msg`
/// (`mt_transfer_call`, 1 yocto).
pub async fn mt_transfer_call(
    w: &World,
    from: &Account,
    receiver: &near_workspaces::AccountId,
    token_id: &str,
    amount: u128,
    msg: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(from
        .call(w.intents.id(), "mt_transfer_call")
        .args_json(serde_json::json!({
            "receiver_id": receiver, "token_id": token_id, "amount": amount.to_string(),
            "approval": null, "memo": null, "msg": msg,
        }))
        .deposit(yocto(1))
        .gas(tgas(150))
        .transact()
        .await?)
}

/// Seller mints `supply` wNEAR, deposits it to Intents and creates a sale with `msg`. Returns
/// the raw execution (check `[0]` vs refund in the logs).
pub async fn create_sale_raw(
    w: &World,
    tender: &near_workspaces::AccountId,
    supply: u128,
    msg: &Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    mint(&w.wnear, w.seller.id().as_str(), supply).await?;
    deposit_to_intents(&w.wnear, &w.intents, &w.seller, supply, None).await?;
    mt_transfer_call(w, &w.seller, tender, WNEAR, supply, &msg.to_string()).await
}

/// Creates a sale closing in 1 h (overrides via `f`), asserts it was accepted, returns its id.
pub async fn create_sale(
    w: &World,
    tender: &near_workspaces::AccountId,
    supply: u128,
    f: impl FnOnce(&mut Value),
) -> anyhow::Result<u64> {
    let before: Value = view_json(w, tender, "get_config", serde_json::json!({})).await?;
    let id: u64 = before["sales"].as_str().unwrap().parse()?;
    let close = now_ns(w).await? + 3_600 * 1_000_000_000;
    let r = create_sale_raw(w, tender, supply, &create_msg(close, f)).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert!(
        r.logs().iter().any(|l| l.contains("\"event\":\"create\"")),
        "create refunded: {:?}",
        r.logs()
    );
    Ok(id)
}

pub fn bid_msg(sale: u64, ct: &[u8], cm_hex: &str) -> Value {
    use near_sdk::base64::Engine;
    serde_json::json!({
        "op": "bid", "sale": sale.to_string(),
        "ct": near_sdk::base64::engine::general_purpose::STANDARD.encode(ct),
        "cm": cm_hex,
    })
}

/// Named bidder mints and deposits `escrow` USDC, then bids with `mt_transfer_call`.
pub async fn bid_mt(
    w: &World,
    tender: &near_workspaces::AccountId,
    bidder: &Account,
    sale: u64,
    escrow: u128,
    ct: &[u8],
    cm_hex: &str,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    mint(&w.usdc, bidder.id().as_str(), escrow).await?;
    deposit_to_intents(&w.usdc, &w.intents, bidder, escrow, None).await?;
    let msg = bid_msg(sale, ct, cm_hex).to_string();
    mt_transfer_call(w, bidder, tender, USDC, escrow, &msg).await
}

/// Reads `Sale` `id` from contract state, applies `f`, writes it back (`patch_state`).
pub async fn patch_sale(
    w: &World,
    tender: &near_workspaces::AccountId,
    id: u64,
    f: impl FnOnce(&mut tender::sale::Sale),
) -> anyhow::Result<()> {
    use near_sdk::borsh;
    let key = [b"s".as_slice(), &(id as u32).to_le_bytes()].concat();
    let state = w.worker.view_state(tender).prefix(&key).await?;
    let raw = state
        .get(&key)
        .ok_or_else(|| anyhow::anyhow!("sale {id} not in state"))?;
    let mut s: tender::sale::Sale = borsh::from_slice(raw)?;
    f(&mut s);
    w.worker
        .patch_state(tender, &key, &borsh::to_vec(&s)?)
        .await?;
    Ok(())
}

/// `close_ns = now − secs` (secs = 0 → now − 1 ns).
pub async fn close_minus(
    w: &World,
    tender: &near_workspaces::AccountId,
    id: u64,
    secs: u64,
) -> anyhow::Result<()> {
    let now = now_ns(w).await?;
    patch_sale(w, tender, id, |s| {
        s.close_ns = now - secs * 1_000_000_000 - 1
    })
    .await
}

pub async fn close_now(
    w: &World,
    tender: &near_workspaces::AccountId,
    id: u64,
) -> anyhow::Result<()> {
    close_minus(w, tender, id, 0).await
}

pub async fn get_sale(
    w: &World,
    tender: &near_workspaces::AccountId,
    id: u64,
) -> anyhow::Result<Value> {
    view_json(
        w,
        tender,
        "get_sale",
        serde_json::json!({ "id": id.to_string() }),
    )
    .await
}

pub async fn key_log(w: &World, tender: &near_workspaces::AccountId) -> anyhow::Result<Value> {
    view_json(
        w,
        tender,
        "get_key_log",
        serde_json::json!({ "from": "0", "limit": 100 }),
    )
    .await
}

pub async fn mpc_calls(w: &World) -> anyhow::Result<u32> {
    Ok(w.mpc.view("calls").await?.json()?)
}

pub async fn call_tender(
    by: &Account,
    tender: &near_workspaces::AccountId,
    method: &str,
    args: Value,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(by
        .call(tender, method)
        .args_json(args)
        .gas(tgas(100))
        .transact()
        .await?)
}

/// First NEP-297 event named `event` in `logs`, as its `data[0]`.
pub fn event(logs: &[&str], event: &str) -> Option<Value> {
    logs.iter().find_map(|l| {
        let v: Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:")?).ok()?;
        (v["event"] == event).then(|| v["data"][0].clone())
    })
}
