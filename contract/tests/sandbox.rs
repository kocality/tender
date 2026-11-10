//! Sandbox tests for the Tender contract against the real intents.near 0.4.5 wasm and the mock
//! MPC. Build the wasms first: `bash contract/scripts/build-wasms.sh`.
mod common;

use common::*;
use serde_json::{Value, json};

#[test]
fn tender_wasm_env_override() {
    // Same resolution as TENDER_WASM=res/x.wasm, on a variable no other test reads (tests in
    // this binary run in parallel and read TENDER_WASM).
    // SAFETY: no other thread reads or writes this variable.
    unsafe { std::env::set_var("TENDER_WASM_OVERRIDE_PROBE", "res/x.wasm") };
    let p = wasm_path("TENDER_WASM_OVERRIDE_PROBE", "/target/near/tender.wasm");
    unsafe { std::env::remove_var("TENDER_WASM_OVERRIDE_PROBE") };
    assert_eq!(p, std::path::Path::new(MANIFEST_DIR).join("res/x.wasm"));
    if std::env::var_os("TENDER_WASM").is_none() {
        assert!(tender_wasm_path().ends_with("target/near/tender.wasm"));
    }
}

#[tokio::test]
async fn mock_mpc_roundtrip() -> anyhow::Result<()> {
    let worker = sandbox().await?;
    let root = worker.root_account()?;
    let mpc = deploy_mock_mpc(&root).await?;
    let request = json!({ "request": { "derivation_path": "tender/0/x", "domain_id": 2 } });

    let ok = root
        .call(mpc.id(), "request_app_private_key")
        .args_json(&request)
        .deposit(yocto(1))
        .gas(tgas(50))
        .transact()
        .await?;
    assert!(ok.is_success(), "{}", failure_text(&ok));
    let got: Value = ok.json()?;
    let want: Value = serde_json::from_str(&s1_response())?;
    assert_eq!(got, want);
    assert_eq!(mpc.view("calls").await?.json::<u32>()?, 1);
    assert_eq!(
        mpc.view("last_predecessor").await?.json::<String>()?,
        root.id().to_string()
    );

    mpc.call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let failed = root
        .call(mpc.id(), "request_app_private_key")
        .args_json(&request)
        .deposit(yocto(1))
        .gas(tgas(50))
        .transact()
        .await?;
    assert!(failed.is_failure());
    assert!(failure_text(&failed).contains("Request has timed out"));

    let low_gas = root
        .call(mpc.id(), "request_app_private_key")
        .args_json(&request)
        .deposit(yocto(1))
        .gas(tgas(14))
        .transact()
        .await?;
    assert!(low_gas.is_failure());
    assert!(failure_text(&low_gas).contains("Attached gas is less than the required gas"));
    Ok(())
}

#[tokio::test]
async fn birth_batch_keyless() -> anyhow::Result<()> {
    let w = world().await?;
    let id = deploy_tender(&w).await?;
    let keys = w.worker.view_access_keys(&id).await?;
    assert!(keys.is_empty(), "{keys:?}");
    let cfg = view_json(&w, &id, "get_config", json!({})).await?;
    assert!(cfg["init_block"].as_str().unwrap().parse::<u64>()? > 0);
    assert_eq!(cfg["app_pk_mode"], s1_mode());
    assert_eq!(cfg["sellers"], json!([w.seller.id()]));
    assert_eq!(cfg["sales"], "0");
    Ok(())
}

#[tokio::test]
async fn birth_new_from_non_parent_fails() -> anyhow::Result<()> {
    let w = world().await?;
    let id = tender_id(&w);
    w.seller
        .batch(&id)
        .create_account()
        .transfer(near_workspaces::types::NearToken::from_millinear(4500))
        .deploy(&read_wasm(&tender_wasm_path()))
        .transact()
        .await?
        .into_result()?;
    let r = w
        .root
        .call(&id, "new")
        .args_json(new_args(&w, "identity"))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(
        failure_text(&r).contains("only the parent"),
        "{}",
        failure_text(&r)
    );
    Ok(())
}

#[tokio::test]
async fn birth_new_twice_fails() -> anyhow::Result<()> {
    let w = world().await?;
    let id = deploy_tender(&w).await?;
    let r = w
        .seller
        .call(&id, "new")
        .args_json(new_args(&w, "identity"))
        .transact()
        .await?;
    assert!(r.is_failure());
    assert!(failure_text(&r).contains("already"), "{}", failure_text(&r));
    Ok(())
}

// ---- open / on_key / key ledger / cancel (scenarios 3, 8, 9, 17, 18, 19) ----

const CT: [u8; 160] = [0x5a; 160];

fn cm() -> String {
    "ab".repeat(32)
}

/// World + Tender + one 1-wNEAR sale (overrides via `f`) with `bids` (bidder index, escrow).
async fn sale_with_bids(
    f: impl FnOnce(&mut Value),
    bids: &[(usize, u128)],
) -> anyhow::Result<(World, near_workspaces::AccountId, u64)> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let id = create_sale(&w, &t, ONE_NEAR, f).await?;
    for &(b, escrow) in bids {
        let r = bid_mt(&w, &t, &w.bidders[b], id, escrow, &CT, &cm()).await?;
        assert!(
            event(&r.logs(), "bid").is_some(),
            "bid refunded: {:?}",
            r.logs()
        );
    }
    Ok((w, t, id))
}

fn assert_fails_with(r: &near_workspaces::result::ExecutionFinalResult, msg: &str) {
    assert!(r.is_failure(), "expected failure {msg}");
    assert!(failure_text(r).contains(msg), "{}", failure_text(r));
}

#[tokio::test]
async fn s03_open_before_close_rejected() -> anyhow::Result<()> {
    let (w, t, id) = sale_with_bids(
        |_| {},
        &[(0, 2 * ONE_USDC), (1, 2 * ONE_USDC), (2, 2 * ONE_USDC)],
    )
    .await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "open: before close");
    assert_eq!(mpc_calls(&w).await?, 0);
    let cfg = view_json(&w, &t, "get_config", json!({})).await?;
    assert_eq!(cfg["key_log_len"], "0");
    assert_eq!(get_sale(&w, &t, id).await?["key_requests"], 0);
    Ok(())
}

/// Scenario 8: the open conditions fail, so the key is never requested and the sale cancels.
async fn s08_setup() -> anyhow::Result<(World, near_workspaces::AccountId, u64)> {
    let (w, t, id) = sale_with_bids(
        |m| {
            m["min_escrow"] = json!("50000000");
            m["min_bidders"] = json!(1);
        },
        &[(3, ONE_USDC)],
    )
    .await?;
    close_now(&w, &t, id).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "open: escrow below min_escrow");
    let r = cancel(&w.root, &t, id).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    let ev = event(&r.logs(), "cancel").expect("cancel event");
    assert_eq!(ev["reason"], "conditions");
    assert_eq!(ev["key_requests"], 0);
    Ok((w, t, id))
}

#[tokio::test]
async fn s08_min_escrow_cancel_never_requested() -> anyhow::Result<()> {
    let (w, t, id) = s08_setup().await?;
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["state"], "Cancelled");
    assert_eq!(s["key_requests"], 0);
    assert_eq!(s["key"], Value::Null);
    assert_eq!(s["seller_payout"]["tokens"], ONE_NEAR.to_string());
    // cancel paid both items: the bidder's full escrow and the seller's supply.
    assert_eq!(s["payouts_done"], 2);
    let dave = w.bidders[3].id().as_str();
    assert_eq!(mt_balance(&w.intents, dave, USDC).await?, ONE_USDC);
    let seller = w.seller.id().as_str();
    assert_eq!(mt_balance(&w.intents, seller, WNEAR).await?, ONE_NEAR);
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, 0);
    assert_eq!(mpc_calls(&w).await?, 0);
    assert_eq!(key_log(&w, &t).await?, json!([]));
    Ok(())
}

#[tokio::test]
async fn s19_open_after_cancel_rejected() -> anyhow::Result<()> {
    let (w, t, id) = s08_setup().await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "open: sale is not open");
    assert_eq!(mpc_calls(&w).await?, 0);
    let r = cancel(&w.root, &t, id).await?;
    assert_fails_with(&r, "cancel: conditions not met");
    assert_eq!(get_sale(&w, &t, id).await?["state"], "Cancelled");
    Ok(())
}

#[tokio::test]
async fn s09_mpc_failure_retry_then_cancel_24h() -> anyhow::Result<()> {
    let (w, t, id) = sale_with_bids(
        |_| {},
        &[(0, 2 * ONE_USDC), (1, 2 * ONE_USDC), (2, 2 * ONE_USDC)],
    )
    .await?;
    w.mpc
        .call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    close_now(&w, &t, id).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert!(event(&r.logs(), "key_error").is_some(), "{:?}", r.logs());
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(
        (
            s["state"].clone(),
            s["in_flight"].clone(),
            s["key_requests"].clone()
        ),
        (json!("Open"), json!(false), json!(1))
    );
    let log = key_log(&w, &t).await?;
    assert_eq!(log.as_array().unwrap().len(), 1);
    assert_eq!(log[0]["outcome"], "Err");
    // Conditions hold and a key was requested once: (a) does not apply, (b) needs close + 24 h.
    let r = cancel(&w.root, &t, id).await?;
    assert_fails_with(&r, "cancel: conditions not met");
    close_minus(&w, &t, id, 86_401).await?;
    let r = cancel(&w.root, &t, id).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    let ev = event(&r.logs(), "cancel").expect("cancel event");
    assert_eq!(ev["reason"], "no_key_24h");
    assert_eq!(ev["key_requests"], 1);
    assert_eq!(get_sale(&w, &t, id).await?["state"], "Cancelled");
    Ok(())
}

#[tokio::test]
async fn s17_min_bidders() -> anyhow::Result<()> {
    let (w, t, id) = sale_with_bids(
        |_| {},
        &[(0, 2 * ONE_USDC), (0, 2 * ONE_USDC), (0, 2 * ONE_USDC)],
    )
    .await?;
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(
        (
            s["bids"].clone(),
            s["bidders"].clone(),
            s["escrow_total"].clone()
        ),
        (json!(3), json!(1), json!("6000000"))
    );
    close_now(&w, &t, id).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "open: fewer bidders than min_bidders");
    let r = cancel(&w.root, &t, id).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert_eq!(event(&r.logs(), "cancel").unwrap()["reason"], "conditions");
    assert_eq!(mpc_calls(&w).await?, 0);
    Ok(())
}

#[tokio::test]
async fn s18_key_ledger_err_then_ok() -> anyhow::Result<()> {
    let (w, t, id) = sale_with_bids(
        |_| {},
        &[(0, 2 * ONE_USDC), (1, 2 * ONE_USDC), (2, 2 * ONE_USDC)],
    )
    .await?;
    close_now(&w, &t, id).await?;
    w.mpc
        .call("set_fail")
        .args_json(json!({ "fail": true }))
        .transact()
        .await?
        .into_result()?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert!(event(&r.logs(), "key_error").is_some(), "{:?}", r.logs());
    w.mpc
        .call("set_fail")
        .args_json(json!({ "fail": false }))
        .transact()
        .await?
        .into_result()?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert!(r.is_success(), "{}", failure_text(&r));
    assert!(event(&r.logs(), "key").is_some(), "{:?}", r.logs());

    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["state"], "Keyed");
    assert_eq!(s["key_requests"], 2);
    assert_eq!(s["in_flight"], false);
    let want: Value = serde_json::from_str(&s1_response())?;
    assert_eq!(s["key"]["big_y"], want["big_y"]);
    assert_eq!(s["key"]["big_c"], want["big_c"]);
    let key_ns: u64 = s["key"]["ns"].as_str().unwrap().parse()?;
    let deadline: u64 = s["reveal_deadline_ns"].as_str().unwrap().parse()?;
    assert_eq!(deadline, key_ns + 86_400 * 1_000_000_000);

    let log = key_log(&w, &t).await?;
    let outcomes: Vec<&str> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["outcome"].as_str().unwrap())
        .collect();
    assert_eq!(outcomes, ["Err", "Ok"]);
    assert!(log[1]["resolved_block"].is_string());

    // The MPC saw exactly ckd_args(path, mode, 2) from the Tender account.
    let mode = tender::sale::AppPkMode::parse(&s1_mode()).unwrap();
    let path = s["path"].as_str().unwrap();
    let sent: Value = serde_json::from_str(&w.mpc.view("last_request").await?.json::<String>()?)?;
    let want_args: Value = serde_json::from_str(&tender::seal::ckd_args(path, mode, 2))?;
    assert_eq!(sent, want_args["request"]);
    assert_eq!(
        w.mpc.view("last_predecessor").await?.json::<String>()?,
        t.to_string()
    );
    assert_eq!(mpc_calls(&w).await?, 1);

    // Keyed: no second key request, no cancel.
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "open: sale is not open");
    let r = cancel(&w.root, &t, id).await?;
    assert_fails_with(&r, "cancel: conditions not met");
    Ok(())
}

// ---- reveal / self-reveal / finalize / payouts (scenarios 1, 4-7, 10-15) ----

type Exec = near_workspaces::result::ExecutionFinalResult;
type Id = near_workspaces::AccountId;

/// A named sandbox bidder (`w.bidders[i]`), or a raw_ed25519 implicit account (key seed) that
/// bids with a signed Transfer intent and is funded by `w.bidders[1]`.
#[derive(Clone, Copy)]
enum Who {
    Named(usize),
    Signed(u8),
}

fn account_of(w: &World, who: Who) -> String {
    match who {
        Who::Named(i) => w.bidders[i].id().to_string(),
        Who::Signed(seed) => raw_ed25519_signer(seed).1,
    }
}

/// Puts `amount` USDC into `who`'s Intents account.
async fn fund(w: &World, who: Who, amount: u128) -> anyhow::Result<()> {
    let (from, to) = match who {
        Who::Named(i) => (&w.bidders[i], None),
        Who::Signed(seed) => (&w.bidders[1], Some(raw_ed25519_signer(seed).1)),
    };
    mint(&w.usdc, from.id().as_str(), amount).await?;
    deposit_to_intents(&w.usdc, &w.intents, from, amount, to.as_deref()).await
}

/// `who` moves `amount` of its Intents USDC to Tender with `msg`.
async fn send(w: &World, t: &Id, who: Who, amount: u128, msg: &str) -> anyhow::Result<Exec> {
    match who {
        Who::Named(i) => mt_transfer_call(w, &w.bidders[i], t, USDC, amount, msg).await,
        Who::Signed(seed) => {
            let (sk, _) = raw_ed25519_signer(seed);
            let signed = signed_transfer(&w.intents, &sk, t.as_str(), USDC, amount, msg).await?;
            execute_intents(&w.root, &w.intents, vec![signed]).await
        }
    }
}

async fn place(
    w: &World,
    t: &Id,
    sale: u64,
    who: Who,
    escrow: u128,
    cm: &str,
) -> anyhow::Result<()> {
    fund(w, who, escrow).await?;
    let r = send(w, t, who, escrow, &bid_msg(sale, &CT, cm).to_string()).await?;
    assert!(
        event(&r.logs(), "bid").is_some(),
        "bid refunded: {:?}",
        r.logs()
    );
    Ok(())
}

#[derive(Clone, Copy)]
struct Planned {
    who: Who,
    escrow: u128,
    p: u64,
    q: u64,
}

fn salt(idx: usize) -> [u8; 16] {
    [idx as u8 + 1; 16]
}

fn item(idx: usize, p: u64, q: u64) -> Value {
    json!({ "idx": idx, "p": p.to_string(), "q": q.to_string(), "salt": to_hex(&salt(idx)) })
}

/// World + Tender + a sale of `supply` (overrides via `f`) with one sealed bid per plan entry
/// (real commitment, fixed ct), then closed and keyed. Returns the reveal items in bid order.
async fn keyed_sale(
    f: impl FnOnce(&mut Value),
    supply: u128,
    plan: &[Planned],
) -> anyhow::Result<(World, Id, u64, Vec<Value>)> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let id = create_sale(&w, &t, supply, f).await?;
    let mut items = Vec::new();
    for (i, b) in plan.iter().enumerate() {
        let cm = commit_hex(id, &account_of(&w, b.who), b.escrow, b.p, b.q, &salt(i));
        place(&w, &t, id, b.who, b.escrow, &cm).await?;
        items.push(item(i, b.p, b.q));
    }
    close_now(&w, &t, id).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert!(event(&r.logs(), "key").is_some(), "{:?}", r.logs());
    Ok((w, t, id, items))
}

async fn reveal(w: &World, t: &Id, id: u64, items: &[Value]) -> anyhow::Result<Exec> {
    call_tender(
        &w.root,
        t,
        "reveal",
        json!({ "sale": id.to_string(), "items": items }),
    )
    .await
}

fn num(v: &Value) -> u128 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        Value::Number(n) => n.as_u64().unwrap() as u128,
        _ => panic!("not a number: {v}"),
    }
}

/// Bids of a clearing fixture as a plan (sealed bids get p = q = 1 in their commitment).
fn plan_from(fx: &Value, who: impl Fn(usize) -> Who) -> Vec<Planned> {
    fx["bids"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, b)| Planned {
            who: who(i),
            escrow: num(&b["B"]),
            p: if b["p"].is_null() {
                1
            } else {
                num(&b["p"]) as u64
            },
            q: if b["q"].is_null() {
                1
            } else {
                num(&b["q"]) as u64
            },
        })
        .collect()
}

/// Create-msg overrides for a fixture's sale parameters; open conditions set to always hold.
fn fixture_sale(fx: &Value) -> impl FnOnce(&mut Value) + use<> {
    let s = fx["sale"].clone();
    move |m| {
        m["reserve"] = json!(num(&s["reserve"]).to_string());
        m["decimals"] = json!(num(&s["decimals"]));
        m["lot_exp"] = json!(num(&s["lot_exp"]));
        m["min_escrow"] = json!("1000000");
        m["min_bidders"] = json!(1);
    }
}

/// `get_result` and every bid equal the fixture's `expected`.
async fn check_fixture(w: &World, t: &Id, id: u64, fx: &Value) -> anyhow::Result<()> {
    let e = &fx["expected"];
    let r = get_result(w, t, id).await?;
    assert_eq!(r["p_star"], e["P_star"]);
    assert_eq!(r["seller_usdc"], e["seller_usdc"]);
    assert_eq!(r["seller_tokens_back"], e["seller_tokens_back"]);
    assert_eq!(r["token_dust"], e["dust"]);
    assert_eq!(r["cancelled"], false);
    let bids = get_bids(w, t, id).await?;
    for (i, b) in bids.as_array().unwrap().iter().enumerate() {
        assert_eq!(b["alloc"], e["alloc"][i], "alloc {i}");
        assert_eq!(b["spend"], e["spend"][i], "spend {i}");
        assert_eq!(b["penalty"], e["penalty"][i], "penalty {i}");
        assert_eq!(b["penalty_share"], e["penalty_share"][i], "share {i}");
        assert_eq!(b["paid"]["usdc"], e["refund"][i], "refund {i}");
        assert_eq!(b["paid"]["tokens"], e["alloc"][i], "tokens {i}");
        assert_eq!(b["state"], e["final_state"][i], "state {i}");
    }
    Ok(())
}

/// After every payout: each bidder holds its refund and allocation in Intents, the seller its
/// USDC and unsold tokens, Tender only the penalty pool (paid to nobody).
async fn check_balances(w: &World, t: &Id, plan: &[Planned], fx: &Value) -> anyhow::Result<()> {
    let e = &fx["expected"];
    for (i, b) in plan.iter().enumerate() {
        let acc = account_of(w, b.who);
        assert_eq!(
            mt_balance(&w.intents, &acc, USDC).await?,
            num(&e["refund"][i]),
            "usdc {i}"
        );
        assert_eq!(
            mt_balance(&w.intents, &acc, WNEAR).await?,
            num(&e["alloc"][i]),
            "wnear {i}"
        );
    }
    let seller = w.seller.id().as_str();
    assert_eq!(
        mt_balance(&w.intents, seller, USDC).await?,
        num(&e["seller_usdc"])
    );
    assert_eq!(
        mt_balance(&w.intents, seller, WNEAR).await?,
        num(&e["seller_tokens_back"])
    );
    let pool: u128 = e["penalty"].as_array().unwrap().iter().map(num).sum();
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, pool);
    assert_eq!(mt_balance(&w.intents, t.as_str(), WNEAR).await?, 0);
    Ok(())
}

fn assert_ok(r: &Exec) {
    assert!(r.is_success(), "{}", failure_text(r));
}

/// Revealed, finalized and fully paid fixture sale.
async fn run_fixture(
    fx: &Value,
    plan: &[Planned],
    f: impl FnOnce(&mut Value),
) -> anyhow::Result<(World, Id, u64)> {
    let (w, t, id, items) = keyed_sale(f, num(&fx["sale"]["S"]), plan).await?;
    let revealed: Vec<Value> = fx["bids"]
        .as_array()
        .unwrap()
        .iter()
        .zip(items)
        .filter(|(b, _)| b["state"] == "Revealed")
        .map(|(_, it)| it)
        .collect();
    for batch in revealed.chunks(3) {
        assert_ok(&reveal(&w, &t, id, batch).await?);
    }
    if revealed.len() < plan.len() {
        deadline_now(&w, &t, id).await?;
    }
    assert_ok(&finalize(&w.root, &t, id, 8).await?);
    check_fixture(&w, &t, id, fx).await?;
    check_balances(&w, &t, plan, fx).await?;
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["state"], "Finalized");
    assert_eq!(s["payouts_done"], s["payouts_total"]);
    Ok((w, t, id))
}

#[tokio::test]
async fn s01_full_lifecycle() -> anyhow::Result<()> {
    let fx = clearing_fixture("demo-sale-1");
    // Bid 1 comes from a raw_ed25519 implicit account through a signed Transfer intent.
    let plan = plan_from(&fx, |i| {
        if i == 1 {
            Who::Signed(7)
        } else {
            Who::Named(i)
        }
    });
    // Demo #1 parameters are the create defaults: reserve 3.00, min_escrow 5, min_bidders 3.
    let (w, t, id) = run_fixture(&fx, &plan, |_| {}).await?;
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["payouts_done"], 7);
    assert_eq!(s["seller_payout"]["ok"], true);
    assert_eq!(get_result(&w, &t, id).await?["p_star"], "3600000");
    assert_eq!(
        mt_balance(&w.intents, w.seller.id().as_str(), USDC).await?,
        10_800_001
    );
    let bids = get_bids(&w, &t, id).await?;
    assert_eq!(bids[1]["bidder"], raw_ed25519_signer(7).1);
    // Finalized and paid: another finalize is a no-op.
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    assert!(
        r.logs().contains(&"finalize: all payouts done"),
        "{:?}",
        r.logs()
    );
    assert!(event(&r.logs(), "payout").is_none());
    Ok(())
}

fn three_bids() -> Vec<Planned> {
    (0..3)
        .map(|i| Planned {
            who: Who::Named(i),
            escrow: 2 * ONE_USDC,
            p: 3_500_000 + i as u64,
            q: ONE_USDC as u64,
        })
        .collect()
}

#[tokio::test]
async fn s04_wrong_commitment_reveal_panics() -> anyhow::Result<()> {
    let (w, t, id, items) = keyed_sale(|_| {}, ONE_NEAR, &three_bids()).await?;
    let mut bad = items[0].clone();
    bad["salt"] = json!(to_hex(&[0xee; 16]));
    let r = reveal(&w, &t, id, &[bad]).await?;
    assert_fails_with(&r, "reveal: commitment mismatch for bid 0");
    // A batch with one bad item reverts the good ones too.
    let mut bad_q = items[2].clone();
    bad_q["q"] = json!("999");
    let r = reveal(&w, &t, id, &[items[1].clone(), bad_q]).await?;
    assert_fails_with(&r, "reveal: commitment mismatch for bid 2");
    let bids = get_bids(&w, &t, id).await?;
    assert_eq!(bids[0]["state"], "Sealed");
    assert_eq!(bids[1]["state"], "Sealed");
    assert_eq!(get_sale(&w, &t, id).await?["revealed"], 0);
    Ok(())
}

#[tokio::test]
async fn s05_double_reveal() -> anyhow::Result<()> {
    let (w, t, id, items) = keyed_sale(|_| {}, ONE_NEAR, &three_bids()).await?;
    assert_ok(&reveal(&w, &t, id, &items[..1]).await?);
    // The same opening again (another tab, the keeper) is a no-op, so the batch's other items
    // still go through (X12-01); a different opening of a revealed bid still panics.
    let r = reveal(&w, &t, id, &items[..2]).await?;
    assert_ok(&r);
    assert_eq!(get_sale(&w, &t, id).await?["revealed"], 2);
    let mut other = items[0].clone();
    other["q"] = json!("999999");
    let r = reveal(&w, &t, id, &[other.clone()]).await?;
    assert_fails_with(&r, "reveal: bid 0 is not sealed");
    // Gasless self-reveal of the other opening: logged, never panics, the 1 micro-USDC comes
    // back.
    let alice = Who::Named(0);
    fund(&w, alice, 1).await?;
    let msg = json!({ "op": "reveal", "sale": id.to_string(), "items": [other] });
    let r = send(&w, &t, alice, 1, &msg.to_string()).await?;
    assert_ok(&r);
    assert!(
        r.logs().contains(&"self-reveal: 0: bid 0 is not sealed"),
        "{:?}",
        r.logs()
    );
    assert_eq!(
        mt_balance(&w.intents, w.bidders[0].id().as_str(), USDC).await?,
        1
    );
    assert_eq!(get_sale(&w, &t, id).await?["revealed"], 2);
    Ok(())
}

#[tokio::test]
async fn s06_broken_ct_penalized() -> anyhow::Result<()> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let id = create_sale(&w, &t, ONE_NEAR, two_bidders).await?;
    let honest = Planned {
        who: Who::Named(0),
        escrow: 2 * ONE_USDC,
        p: 3_500_000,
        q: ONE_USDC as u64,
    };
    let cm = commit_hex(
        id,
        &account_of(&w, honest.who),
        honest.escrow,
        honest.p,
        honest.q,
        &salt(0),
    );
    place(&w, &t, id, honest.who, honest.escrow, &cm).await?;
    // Random ciphertext and a commitment nobody can open.
    place(
        &w,
        &t,
        id,
        Who::Named(1),
        2 * ONE_USDC + 1,
        &"cd".repeat(32),
    )
    .await?;
    close_now(&w, &t, id).await?;
    assert_ok(&call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?);
    assert_ok(&reveal(&w, &t, id, &[item(0, honest.p, honest.q)]).await?);
    deadline_now(&w, &t, id).await?;
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    assert_eq!(event(&r.logs(), "penalize").unwrap()["idx"], 1);
    let bids = get_bids(&w, &t, id).await?;
    assert_eq!(bids[1]["state"], "Penalized");
    assert_eq!(bids[1]["penalty"], "200000");
    // 0.9·B back to the broken bid; its 0.1·B stays in Tender (paid to nobody); the honest
    // bid gets only its refund and the seller only spend.
    let bob = w.bidders[1].id().as_str();
    assert_eq!(mt_balance(&w.intents, bob, USDC).await?, 1_800_001);
    let alice = w.bidders[0].id().as_str();
    assert_eq!(mt_balance(&w.intents, alice, USDC).await?, ONE_USDC);
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, 200_000);
    let r = get_result(&w, &t, id).await?;
    assert_eq!(
        (r["p_star"].clone(), r["penalty_pool"].clone()),
        (json!("3000000"), json!("200000"))
    );
    assert_eq!(
        mt_balance(&w.intents, w.seller.id().as_str(), USDC).await?,
        ONE_USDC
    );
    Ok(())
}

#[tokio::test]
async fn s07_copied_bid_penalized() -> anyhow::Result<()> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let id = create_sale(&w, &t, ONE_NEAR, two_bidders).await?;
    let (p, q, b) = (3_500_000u64, ONE_USDC as u64, 2 * ONE_USDC);
    let cm = commit_hex(id, w.bidders[0].id().as_str(), b, p, q, &salt(0));
    place(&w, &t, id, Who::Named(0), b, &cm).await?;
    // carol copies alice's ct and cm byte for byte, with the same escrow.
    place(&w, &t, id, Who::Named(2), b, &cm).await?;
    close_now(&w, &t, id).await?;
    assert_ok(&call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?);
    assert_ok(&reveal(&w, &t, id, &[item(0, p, q)]).await?);
    // Same opening for carol: the commitment binds the bidder, so it does not match.
    let mut copy = item(0, p, q);
    copy["idx"] = json!(1);
    let r = reveal(&w, &t, id, &[copy]).await?;
    assert_fails_with(&r, "reveal: commitment mismatch for bid 1");
    deadline_now(&w, &t, id).await?;
    assert_ok(&finalize(&w.root, &t, id, 8).await?);
    let bids = get_bids(&w, &t, id).await?;
    assert_eq!(
        (bids[0]["state"].clone(), bids[1]["state"].clone()),
        (json!("Revealed"), json!("Penalized"))
    );
    assert_eq!(bids[1]["paid"]["usdc"], "1800000");
    Ok(())
}

#[tokio::test]
async fn s10_marginal_pro_rata() -> anyhow::Result<()> {
    let fx = clearing_fixture("tie-marginal");
    let plan = plan_from(&fx, Who::Named);
    let (w, t, id) = run_fixture(&fx, &plan, fixture_sale(&fx)).await?;
    let r = get_result(&w, &t, id).await?;
    assert_eq!(
        (r["token_dust"].clone(), r["seller_tokens_back"].clone()),
        (json!("1"), json!("1"))
    );
    assert_eq!(
        mt_balance(&w.intents, w.seller.id().as_str(), WNEAR).await?,
        1
    );
    Ok(())
}

async fn intents_pause(w: &World, method: &str) -> anyhow::Result<()> {
    w.root
        .call(w.intents.id(), method)
        .args_json(json!({ "key": "mt_transfer" }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

#[tokio::test]
async fn s11_payout_retry() -> anyhow::Result<()> {
    let fx = clearing_fixture("tie-marginal");
    let plan = plan_from(&fx, Who::Named);
    let (w, t, id, items) = keyed_sale(fixture_sale(&fx), num(&fx["sale"]["S"]), &plan).await?;
    assert_ok(&reveal(&w, &t, id, &items).await?);
    intents_pause(&w, "pa_pause_feature").await?;
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    let failed: Vec<&str> = r
        .logs()
        .into_iter()
        .filter(|l| l.contains("\"event\":\"payout\""))
        .collect();
    assert_eq!(failed.len(), 4, "{:?}", r.logs());
    assert!(
        failed.iter().all(|l| l.contains("\"ok\":false")),
        "{failed:?}"
    );
    let bids = get_bids(&w, &t, id).await?;
    assert!(
        bids.as_array()
            .unwrap()
            .iter()
            .all(|b| b["paid"]["ok"] == false)
    );
    assert_eq!(get_sale(&w, &t, id).await?["payouts_done"], 0);
    // Nothing moved while paused.
    assert_eq!(
        mt_balance(&w.intents, t.as_str(), USDC).await?,
        6 * ONE_USDC
    );

    intents_pause(&w, "pa_unpause_feature").await?;
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    check_fixture(&w, &t, id, &fx).await?;
    check_balances(&w, &t, &plan, &fx).await?;
    assert_eq!(get_sale(&w, &t, id).await?["payouts_done"], 4);
    // A third call pays nothing twice.
    let r = finalize(&w.root, &t, id, 8).await?;
    assert!(event(&r.logs(), "payout").is_none());
    check_balances(&w, &t, &plan, &fx).await?;
    Ok(())
}

#[tokio::test]
async fn s12_penalty_to_nobody() -> anyhow::Result<()> {
    let fx = clearing_fixture("penalty");
    let w_plan = plan_from(&fx, Who::Named);
    // Bid 2 is a copy of bid 1: same escrow, same commitment, from another account.
    let (w, t, id, items) = {
        let w = world().await?;
        let t = deploy_tender(&w).await?;
        let id = create_sale(&w, &t, num(&fx["sale"]["S"]), fixture_sale(&fx)).await?;
        let mut items = Vec::new();
        let mut cm1 = String::new();
        for (i, b) in w_plan.iter().enumerate() {
            let mut cm = commit_hex(id, &account_of(&w, b.who), b.escrow, b.p, b.q, &salt(i));
            if i == 1 {
                cm1 = cm.clone();
            }
            if i == 2 {
                cm = cm1.clone();
            }
            place(&w, &t, id, b.who, b.escrow, &cm).await?;
            items.push(item(i, b.p, b.q));
        }
        close_now(&w, &t, id).await?;
        assert_ok(&call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?);
        (w, t, id, items)
    };
    assert_ok(&reveal(&w, &t, id, &[items[0].clone(), items[3].clone()]).await?);
    deadline_now(&w, &t, id).await?;
    assert_ok(&finalize(&w.root, &t, id, 8).await?);
    check_fixture(&w, &t, id, &fx).await?;
    check_balances(&w, &t, &w_plan, &fx).await?;
    // No revealed bid (idx 3 is below reserve) gets a share; the seller got spend only.
    assert_eq!(get_bids(&w, &t, id).await?[3]["penalty_share"], "0");
    assert_eq!(
        mt_balance(&w.intents, w.seller.id().as_str(), USDC).await?,
        350_000
    );
    Ok(())
}

#[tokio::test]
async fn s13_zero_reveal_no_penalty() -> anyhow::Result<()> {
    let fx = clearing_fixture("zero-reveal");
    let plan = plan_from(&fx, Who::Named);
    let (w, t, id) = run_fixture(&fx, &plan, fixture_sale(&fx)).await?;
    let r = get_result(&w, &t, id).await?;
    assert_eq!(
        (r["p_star"].clone(), r["penalty_pool"].clone()),
        (Value::Null, json!("0"))
    );
    let bids = get_bids(&w, &t, id).await?;
    assert!(
        bids.as_array()
            .unwrap()
            .iter()
            .all(|b| b["state"] == "Sealed")
    );
    Ok(())
}

#[tokio::test]
async fn s14_self_reveal_by_intent() -> anyhow::Result<()> {
    let signer = Who::Signed(9);
    let plan = [Planned {
        who: signer,
        escrow: 2 * ONE_USDC,
        p: 3_500_000,
        q: ONE_USDC as u64,
    }];
    let (w, t, id, items) = keyed_sale(
        |m| {
            m["min_bidders"] = json!(1);
            m["min_escrow"] = json!("1000000");
        },
        ONE_NEAR,
        &plan,
    )
    .await?;
    let hex = account_of(&w, signer);
    fund(&w, signer, 1).await?;
    assert_eq!(mt_balance(&w.intents, &hex, USDC).await?, 1);
    let msg = json!({ "op": "reveal", "sale": id.to_string(), "items": items });
    let r = send(&w, &t, signer, 1, &msg.to_string()).await?;
    assert_ok(&r);
    assert!(event(&r.logs(), "reveal").is_some(), "{:?}", r.logs());
    let b = &get_bids(&w, &t, id).await?[0];
    assert_eq!(b["state"], "Revealed");
    assert_eq!(b["revealed_by"], hex);
    assert_eq!(mt_balance(&w.intents, &hex, USDC).await?, 1);
    Ok(())
}

#[tokio::test]
async fn s15_early_finalize_when_all_revealed() -> anyhow::Result<()> {
    let plan = &three_bids()[..2];
    let (w, t, id, items) = keyed_sale(two_bidders, ONE_NEAR, plan).await?;
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_fails_with(&r, "finalize: reveal window still open");
    assert_ok(&reveal(&w, &t, id, &items).await?);
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["state"], "Finalized");
    let deadline: u64 = s["reveal_deadline_ns"].as_str().unwrap().parse()?;
    assert!(now_ns(&w).await? < deadline);
    assert_eq!(s["payouts_done"], 3);
    Ok(())
}

/// Audit C-01/X12-01: q == B for the marginal bid at the floor-loss knife edge. Finalize used
/// to panic with "clearing underflow" forever; now it clears, pays every item and matches the
/// fixture (spend == q, refund 0, one base unit of dust).
#[tokio::test]
async fn s22_marginal_floor_excess_finalizes() -> anyhow::Result<()> {
    let fx = clearing_fixture("marginal-floor-excess");
    let plan = plan_from(&fx, Who::Named);
    run_fixture(&fx, &plan, fixture_sale(&fx)).await?;
    Ok(())
}

/// Audit CRYPTO-01/T-01: undecryptable option bids left Sealed plus a large revealed decoy.
/// Sock-puppet accounts: the decoy gets exactly B back and the pool stays in Tender.
#[tokio::test]
async fn s23_last_look_pool_not_recycled() -> anyhow::Result<()> {
    let fx = clearing_fixture("last-look-recycle");
    let plan = plan_from(&fx, Who::Named);
    let (w, t, _) = run_fixture(&fx, &plan, fixture_sale(&fx)).await?;
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, 600_000);
    Ok(())
}

/// Open conditions for the two-bid scenarios: 2 bidders, 1 USDC.
fn two_bidders(m: &mut Value) {
    m["min_bidders"] = json!(2);
    m["min_escrow"] = json!("1000000");
}

// ---- create and bid guards (scenarios 2, 16, 20, 21) ----

#[tokio::test]
async fn s02_late_bid_refunded() -> anyhow::Result<()> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let id = create_sale(&w, &t, ONE_NEAR, |_| {}).await?;
    close_now(&w, &t, id).await?;
    let r = bid_mt(&w, &t, &w.bidders[0], id, 2 * ONE_USDC, &CT, &cm()).await?;
    assert_ok(&r);
    assert!(event(&r.logs(), "bid").is_none(), "{:?}", r.logs());
    let ev = event(&r.logs(), "refund").expect("refund event");
    assert_eq!(
        (ev["reason"].clone(), ev["op"].clone()),
        (json!("closed"), json!("bid"))
    );
    let alice = w.bidders[0].id().as_str();
    assert_eq!(mt_balance(&w.intents, alice, USDC).await?, 2 * ONE_USDC);
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, 0);
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(
        (s["bids"].clone(), s["escrow_total"].clone()),
        (json!(0), json!("0"))
    );
    Ok(())
}

#[tokio::test]
async fn s16_d_plus_lot_exp_bound() -> anyhow::Result<()> {
    // decimals 24 + lot_exp 2 = 26, the upper bound: accepted, and finalize matches the fixture.
    let fx = clearing_fixture("bound-d-lot-exp");
    assert_eq!(
        (num(&fx["sale"]["decimals"]), num(&fx["sale"]["lot_exp"])),
        (24, 2)
    );
    let plan = plan_from(&fx, Who::Named);
    let (w, t, id) = run_fixture(&fx, &plan, fixture_sale(&fx)).await?;
    // decimals 24 + lot_exp 3 = 27: refunded in full, no sale.
    let seller = w.seller.id().as_str();
    let before = mt_balance(&w.intents, seller, WNEAR).await?;
    let close = now_ns(&w).await? + 3_600 * 1_000_000_000;
    let msg = create_msg(close, |m| m["lot_exp"] = json!(3));
    let r = create_sale_raw(&w, &t, ONE_NEAR, &msg).await?;
    assert_ok(&r);
    assert!(event(&r.logs(), "create").is_none(), "{:?}", r.logs());
    let ev = event(&r.logs(), "refund").expect("refund event");
    assert_eq!(ev["reason"], "decimals_plus_lot_exp");
    assert_eq!(
        mt_balance(&w.intents, seller, WNEAR).await?,
        before + ONE_NEAR
    );
    let cfg = view_json(&w, &t, "get_config", json!({})).await?;
    assert_eq!(cfg["sales"], (id + 1).to_string());
    Ok(())
}

#[tokio::test]
async fn s20_storage_guard() -> anyhow::Result<()> {
    let w = world().await?;
    // Code storage (1 NEAR per 100 KB) + 0.33 NEAR: only a few bids fit above the 0.3 NEAR
    // reserve (C26) and the room kept back for the sale's open (F6).
    let wasm = read_wasm(&tender_wasm_path()).len() as u128;
    let balance = wasm * 10u128.pow(19) + 330 * 10u128.pow(21);
    let r = deploy_tender_with(
        &w,
        &s1_mode(),
        near_workspaces::types::NearToken::from_yoctonear(balance),
    )
    .await?;
    assert_ok(&r);
    let t = tender_id(&w);
    let one_bidder = |m: &mut Value| {
        m["min_bidders"] = json!(1);
        m["min_escrow"] = json!("1000000");
    };
    let id = create_sale(&w, &t, ONE_NEAR, one_bidder).await?;
    let mut items = Vec::new();
    let mut refused = None;
    for i in 0..BIDDERS.len() {
        let who = Who::Named(i);
        let (escrow, p, q) = (2 * ONE_USDC, 3_500_000 + i as u64, ONE_USDC as u64);
        let cm = commit_hex(id, &account_of(&w, who), escrow, p, q, &salt(i));
        fund(&w, who, escrow).await?;
        let r = send(&w, &t, who, escrow, &bid_msg(id, &CT, &cm).to_string()).await?;
        assert_ok(&r);
        if let Some(ev) = event(&r.logs(), "refund") {
            assert_eq!(ev["reason"], "storage", "{:?}", r.logs());
            refused = Some(i);
            break;
        }
        assert!(event(&r.logs(), "bid").is_some(), "{:?}", r.logs());
        items.push(item(i, p, q));
    }
    let refused = refused.expect("the storage guard never refused a bid");
    assert!(refused >= 1, "not even one bid fit");
    let late = w.bidders[refused].id().as_str();
    assert_eq!(mt_balance(&w.intents, late, USDC).await?, 2 * ONE_USDC);
    assert_eq!(get_sale(&w, &t, id).await?["bids"], refused);

    // F6: the bids already in kept room for the sale's open (C-02: its on_key, reveals and
    // settle), so it opens, reveals, finalizes and pays out with no top-up of the keyless
    // account.
    close_now(&w, &t, id).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": id.to_string() })).await?;
    assert!(event(&r.logs(), "key").is_some(), "{:?}", r.logs());
    assert_ok(&reveal(&w, &t, id, &items).await?);
    assert_ok(&finalize(&w.root, &t, id, 8).await?);
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["state"], "Finalized");
    assert_eq!(s["payouts_done"], s["payouts_total"]);
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, 0);
    assert_eq!(mt_balance(&w.intents, t.as_str(), WNEAR).await?, 0);
    Ok(())
}

#[tokio::test]
async fn s21_foreign_seller_refunded() -> anyhow::Result<()> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    // alice is not in `sellers` (C30).
    let alice = &w.bidders[0];
    mint(&w.wnear, alice.id().as_str(), ONE_NEAR).await?;
    deposit_to_intents(&w.wnear, &w.intents, alice, ONE_NEAR, None).await?;
    let close = now_ns(&w).await? + 3_600 * 1_000_000_000;
    let msg = create_msg(close, |_| {}).to_string();
    let r = mt_transfer_call(&w, alice, &t, WNEAR, ONE_NEAR, &msg).await?;
    assert_ok(&r);
    assert!(event(&r.logs(), "create").is_none(), "{:?}", r.logs());
    let ev = event(&r.logs(), "refund").expect("refund event");
    assert_eq!(
        (ev["reason"].clone(), ev["op"].clone()),
        (json!("not_seller"), json!("create"))
    );
    assert_eq!(
        mt_balance(&w.intents, alice.id().as_str(), WNEAR).await?,
        ONE_NEAR
    );
    assert_eq!(mt_balance(&w.intents, t.as_str(), WNEAR).await?, 0);
    let cfg = view_json(&w, &t, "get_config", json!({})).await?;
    assert_eq!(cfg["sales"], "0");
    Ok(())
}

// ---- views (C23) and NEP-297 events (C24) ----

/// Logs written by `account` in `r` (other contracts' events, e.g. Intents' nep245, excluded).
fn logs_of(r: &Exec, account: &Id) -> Vec<String> {
    r.outcomes()
        .into_iter()
        .filter(|o| &o.executor_id == account)
        .flat_map(|o| o.logs.clone())
        .collect()
}

/// Full lifecycle with a refund, a penalty and every payout: create, 3 bids (+1 refused),
/// open, 2 reveals, deadline, finalize. Returns every Tender log line.
async fn lifecycle() -> anyhow::Result<(World, Id, u64, Vec<String>)> {
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let mut logs = Vec::new();
    let close = now_ns(&w).await? + 3_600 * 1_000_000_000;
    let r = create_sale_raw(&w, &t, ONE_NEAR, &create_msg(close, two_bidders)).await?;
    logs.extend(logs_of(&r, &t));
    let id = 0;
    let plan = three_bids();
    let mut items = Vec::new();
    for (i, b) in plan.iter().enumerate() {
        let cm = commit_hex(id, &account_of(&w, b.who), b.escrow, b.p, b.q, &salt(i));
        fund(&w, b.who, b.escrow).await?;
        let r = send(&w, &t, b.who, b.escrow, &bid_msg(id, &CT, &cm).to_string()).await?;
        logs.extend(logs_of(&r, &t));
        items.push(item(i, b.p, b.q));
    }
    fund(&w, Who::Named(3), 999_999).await?;
    let small = bid_msg(id, &CT, &"ab".repeat(32)).to_string();
    let r = send(&w, &t, Who::Named(3), 999_999, &small).await?;
    logs.extend(logs_of(&r, &t));
    close_now(&w, &t, id).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": "0" })).await?;
    logs.extend(logs_of(&r, &t));
    let r = reveal(&w, &t, id, &items[..2]).await?;
    assert_ok(&r);
    logs.extend(logs_of(&r, &t));
    deadline_now(&w, &t, id).await?;
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    logs.extend(logs_of(&r, &t));
    Ok((w, t, id, logs))
}

fn keys(v: &Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
    k.sort();
    k
}

fn sorted(k: &[&str]) -> Vec<String> {
    let mut k: Vec<String> = k.iter().map(|s| s.to_string()).collect();
    k.sort();
    k
}

/// Every listed field is a decimal string (u64/u128, C4).
fn decimal_strings(v: &Value, fields: &[&str]) {
    for f in fields {
        let s = v[f]
            .as_str()
            .unwrap_or_else(|| panic!("{f} not a string: {v}"));
        assert!(
            !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()),
            "{f}: {s}"
        );
    }
}

fn small_numbers(v: &Value, fields: &[&str]) {
    for f in fields {
        assert!(v[f].is_u64(), "{f} not a number: {v}");
    }
}

#[tokio::test]
async fn views_json_shape() -> anyhow::Result<()> {
    let (w, t, id, _) = lifecycle().await?;

    let cfg = view_json(&w, &t, "get_config", json!({})).await?;
    assert_eq!(
        keys(&cfg),
        sorted(&[
            "version",
            "mpc",
            "intents",
            "domain_id",
            "app_pk_mode",
            "mpc_public_key",
            "quote_tokens",
            "sellers",
            "init_block",
            "init_ns",
            "sales",
            "key_log_len",
        ])
    );
    decimal_strings(
        &cfg,
        &["domain_id", "init_block", "init_ns", "sales", "key_log_len"],
    );
    assert_eq!(cfg["version"], "1.0.0");

    let s = get_sale(&w, &t, id).await?;
    assert_eq!(
        keys(&s),
        sorted(&[
            "id",
            "seller",
            "token",
            "supply",
            "decimals",
            "lot_exp",
            "reserve",
            "min_escrow",
            "min_bidders",
            "max_bids",
            "quote_token",
            "close_ns",
            "reveal_secs",
            "created_block",
            "created_ns",
            "path",
            "state",
            "bids",
            "bidders",
            "escrow_total",
            "revealed",
            "key_requests",
            "in_flight",
            "key",
            "reveal_deadline_ns",
            "seller_payout",
            "payouts_done",
            "payouts_total",
        ])
    );
    decimal_strings(
        &s,
        &[
            "id",
            "supply",
            "reserve",
            "min_escrow",
            "close_ns",
            "reveal_secs",
            "created_block",
            "created_ns",
            "escrow_total",
            "reveal_deadline_ns",
        ],
    );
    small_numbers(
        &s,
        &[
            "decimals",
            "lot_exp",
            "min_bidders",
            "max_bids",
            "bids",
            "bidders",
            "revealed",
            "key_requests",
            "payouts_done",
            "payouts_total",
        ],
    );
    assert_eq!(keys(&s["key"]), sorted(&["big_y", "big_c", "block", "ns"]));
    decimal_strings(&s["key"], &["block", "ns"]);
    assert_eq!(
        keys(&s["seller_payout"]),
        sorted(&["usdc", "tokens", "ok", "pending"])
    );
    decimal_strings(&s["seller_payout"], &["usdc", "tokens"]);
    assert_eq!(s["state"], "Finalized");
    assert_eq!(
        (s["payouts_done"].clone(), s["payouts_total"].clone()),
        (json!(4), json!(4))
    );

    let sales = view_json(&w, &t, "get_sales", json!({ "from": "0", "limit": 50 })).await?;
    assert_eq!(sales, json!([s]));

    let bids = get_bids(&w, &t, id).await?;
    assert_eq!(bids.as_array().unwrap().len(), 3);
    let bid_keys = sorted(&[
        "idx",
        "bidder",
        "escrow",
        "ct",
        "cm",
        "origin",
        "block",
        "ns",
        "state",
        "p",
        "q",
        "salt",
        "revealed_by",
        "alloc",
        "spend",
        "penalty",
        "penalty_share",
        "paid",
    ]);
    for b in bids.as_array().unwrap() {
        assert_eq!(keys(b), bid_keys);
        decimal_strings(
            b,
            &[
                "escrow",
                "block",
                "ns",
                "alloc",
                "spend",
                "penalty",
                "penalty_share",
            ],
        );
        small_numbers(b, &["idx"]);
        assert_eq!(
            keys(&b["paid"]),
            sorted(&["usdc", "tokens", "ok", "pending"])
        );
        decimal_strings(&b["paid"], &["usdc", "tokens"]);
        let ct = tender::sale::decode_ct(b["ct"].as_str().unwrap()).expect("ct");
        assert_eq!(ct, CT.to_vec());
        assert_eq!(b["cm"].as_str().unwrap().len(), 64);
    }
    decimal_strings(&bids[0], &["p", "q"]);
    assert_eq!(bids[0]["salt"], to_hex(&salt(0)));
    assert_eq!(bids[0]["revealed_by"], w.root.id().as_str());
    assert_eq!(bids[0]["origin"], Value::Null);
    assert_eq!(
        (
            bids[2]["p"].clone(),
            bids[2]["salt"].clone(),
            bids[2]["state"].clone()
        ),
        (Value::Null, Value::Null, json!("Penalized"))
    );

    let r = get_result(&w, &t, id).await?;
    assert_eq!(
        keys(&r),
        sorted(&[
            "p_star",
            "sold",
            "seller_usdc",
            "seller_tokens_back",
            "token_dust",
            "penalty_pool",
            "block",
            "ns",
            "cancelled",
        ])
    );
    decimal_strings(
        &r,
        &[
            "p_star",
            "sold",
            "seller_usdc",
            "seller_tokens_back",
            "token_dust",
            "penalty_pool",
            "block",
            "ns",
        ],
    );

    let log = key_log(&w, &t).await?;
    assert_eq!(
        keys(&log[0]),
        sorted(&["i", "sale", "block", "ns", "outcome", "resolved_block"])
    );
    decimal_strings(&log[0], &["i", "sale", "block", "ns", "resolved_block"]);
    assert_eq!(log[0]["outcome"], "Ok");

    // Unknown ids: null / empty; limits are capped, never a panic.
    assert_eq!(get_sale(&w, &t, 99).await?, Value::Null);
    assert_eq!(get_result(&w, &t, 99).await?, Value::Null);
    assert_eq!(get_bids(&w, &t, 99).await?, json!([]));
    let all = view_json(
        &w,
        &t,
        "get_bids",
        json!({ "id": "0", "from": 0, "limit": 255 }),
    )
    .await?;
    assert_eq!(all.as_array().unwrap().len(), 3);
    let none = view_json(&w, &t, "get_sales", json!({ "from": "5", "limit": 255 })).await?;
    assert_eq!(none, json!([]));
    Ok(())
}

#[tokio::test]
async fn events_shape() -> anyhow::Result<()> {
    let (_, _, _, logs) = lifecycle().await?;
    let names = [
        "create",
        "bid",
        "refund",
        "open",
        "key",
        "key_error",
        "reveal",
        "penalize",
        "finalize",
        "payout",
        "cancel",
    ];
    let mut seen = std::collections::BTreeSet::new();
    for l in &logs {
        if !l.contains("EVENT_JSON") {
            continue;
        }
        let body = l
            .strip_prefix("EVENT_JSON:")
            .unwrap_or_else(|| panic!("prefix: {l}"));
        let v: Value = serde_json::from_str(body)?;
        assert_eq!(
            keys(&v),
            sorted(&["standard", "version", "event", "data"]),
            "{l}"
        );
        assert_eq!(v["standard"], "tender", "{l}");
        assert_eq!(v["version"], "1.0.0", "{l}");
        let ev = v["event"].as_str().unwrap();
        assert!(names.contains(&ev), "{l}");
        let data = v["data"].as_array().unwrap_or_else(|| panic!("data: {l}"));
        assert_eq!(data.len(), 1, "{l}");
        assert!(data[0].is_object(), "{l}");
        assert!(!l.contains("\"ct\""), "{l}");
        seen.insert(ev.to_string());
    }
    for ev in [
        "create", "bid", "refund", "open", "key", "reveal", "penalize", "finalize", "payout",
    ] {
        assert!(seen.contains(ev), "no {ev} event in {logs:?}");
    }
    Ok(())
}

// ---- gas and storage report (evidence/wasm.json) ----

fn tgas_of(gas: u64) -> f64 {
    (gas as f64 / 1e10).round() / 100.0
}

/// Gas burnt by each receipt `account` executed in `r`, in execution order.
fn receipt_gas(r: &Exec, account: &Id) -> Vec<u64> {
    r.receipt_outcomes()
        .iter()
        .filter(|o| &o.executor_id == account)
        .map(|o| o.gas_burnt.as_gas())
        .collect()
}

async fn storage_usage(w: &World, t: &Id) -> anyhow::Result<u64> {
    Ok(w.worker.view_account(t).await?.storage_usage)
}

async fn set_mpc_fail(w: &World, fail: bool) -> anyhow::Result<()> {
    w.mpc
        .call("set_fail")
        .args_json(json!({ "fail": fail }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Largest payout receipt (`mt_batch_transfer` on Intents) and `on_paid` receipt in `r`, and
/// the number of payout events.
fn payout_gas(r: &Exec, w: &World, t: &Id) -> (u64, u64, usize) {
    let batch = receipt_gas(r, w.intents.id())
        .into_iter()
        .max()
        .unwrap_or(0);
    let on_paid = receipt_gas(r, t).into_iter().skip(1).max().unwrap_or(0);
    let n = r
        .logs()
        .iter()
        .filter(|l| l.contains("\"event\":\"payout\""))
        .count();
    (batch, on_paid, n)
}

/// Gas and storage of every contract path, worst cases: a 64-bid sale (one bid from a 64-hex
/// implicit account with the longest origin), an 8-item reveal and self-reveal, the first
/// finalize (clearing + penalty + 8 payouts), a later 8-payout finalize and the first cancel of a
/// 64-bid sale (64 bid rewrites + 8 payouts).
/// Writes `contract/scripts/out/gas.json` for `scripts/wasm-report.mjs`.
/// `cargo test --test sandbox gas_report -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn gas_report() -> anyhow::Result<()> {
    let w = world().await?;
    let wasm = read_wasm(&tender_wasm_path());
    let t = deploy_tender(&w).await?;
    let config_bytes = storage_usage(&w, &t).await? - wasm.len() as u64;

    let open_sale = |m: &mut Value| {
        m["max_bids"] = json!(64);
        m["min_bidders"] = json!(1);
        m["min_escrow"] = json!("1000000");
    };
    let before = storage_usage(&w, &t).await?;
    let close = now_ns(&w).await? + 3_600 * 1_000_000_000;
    let r = create_sale_raw(&w, &t, ONE_NEAR, &create_msg(close, open_sale)).await?;
    assert!(event(&r.logs(), "create").is_some(), "{:?}", r.logs());
    let create = receipt_gas(&r, &t)[0];
    let per_sale = storage_usage(&w, &t).await? - before;
    let id = 0u64;

    // 64 bids. Bid 0: signed intent from a 64-hex account with an 8-byte origin (largest
    // record); the rest: the six named bidders through mt_transfer_call.
    let n = 64usize;
    let signed = Who::Signed(11);
    fund(&w, signed, 2 * ONE_USDC).await?;
    for i in 0..BIDDERS.len() {
        fund(&w, Who::Named(i), 22 * ONE_USDC).await?;
    }
    let (mut bid_tx, mut bid_receipt, mut per_bid) = (0u64, 0u64, 0u64);
    let mut items = Vec::new();
    for i in 0..n {
        let who = if i == 0 {
            signed
        } else {
            Who::Named(i % BIDDERS.len())
        };
        let (escrow, p, q) = (2 * ONE_USDC, 3_000_000 + 10_000 * i as u64, ONE_USDC as u64);
        let cm = commit_hex(id, &account_of(&w, who), escrow, p, q, &salt(i));
        let mut msg = bid_msg(id, &CT, &cm);
        msg["origin"] = json!("arbitrum");
        let before = storage_usage(&w, &t).await?;
        let r = send(&w, &t, who, escrow, &msg.to_string()).await?;
        assert!(event(&r.logs(), "bid").is_some(), "{:?}", r.logs());
        per_bid = per_bid.max(storage_usage(&w, &t).await? - before);
        bid_receipt = bid_receipt.max(receipt_gas(&r, &t)[0]);
        if matches!(who, Who::Named(_)) {
            bid_tx = bid_tx.max(r.total_gas_burnt.as_gas());
        }
        items.push(item(i, p, q));
    }

    // open: once with the MPC failing (a key-ledger entry only), then for real.
    close_now(&w, &t, id).await?;
    set_mpc_fail(&w, true).await?;
    let before = storage_usage(&w, &t).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": "0" })).await?;
    assert!(event(&r.logs(), "key_error").is_some(), "{:?}", r.logs());
    let per_key_log = storage_usage(&w, &t).await? - before;
    set_mpc_fail(&w, false).await?;
    let before = storage_usage(&w, &t).await?;
    let r = call_tender(&w.root, &t, "open", json!({ "sale": "0" })).await?;
    assert!(event(&r.logs(), "key").is_some(), "{:?}", r.logs());
    let per_open_keyed = storage_usage(&w, &t).await? - before;
    let open_total = r.total_gas_burnt.as_gas();
    let on_key = *receipt_gas(&r, &t).last().unwrap();

    // reveal: 8 direct, 8 by a gasless self-reveal, 40 more direct; 8 stay sealed (penalized).
    let r = reveal(&w, &t, id, &items[0..8]).await?;
    assert_ok(&r);
    let reveal_8 = r.total_gas_burnt.as_gas();
    let bob = Who::Named(1);
    fund(&w, bob, 1).await?;
    let msg = json!({ "op": "reveal", "sale": "0", "items": items[8..16] });
    let r = send(&w, &t, bob, 1, &msg.to_string()).await?;
    assert_ok(&r);
    let n_rev = r
        .logs()
        .iter()
        .filter(|l| l.contains("\"event\":\"reveal\""))
        .count();
    assert_eq!(n_rev, 8, "{:?}", r.logs());
    let self_reveal = receipt_gas(&r, &t)[0];
    for batch in items[16..56].chunks(8) {
        assert_ok(&reveal(&w, &t, id, batch).await?);
    }
    deadline_now(&w, &t, id).await?;

    // finalize: the first call clears 64 bids and sends 8 payouts; later calls 8 payouts each.
    let before = storage_usage(&w, &t).await?;
    let r = finalize(&w.root, &t, id, 8).await?;
    assert_ok(&r);
    let per_settle = storage_usage(&w, &t).await? - before;
    let finalize_first = r.total_gas_burnt.as_gas();
    let finalize_first_receipt = receipt_gas(&r, &t)[0];
    let (mut batch, mut on_paid, paid) = payout_gas(&r, &w, &t);
    assert_eq!(paid, 8);
    let mut finalize_8 = 0u64;
    for _ in 0..10 {
        let s = get_sale(&w, &t, id).await?;
        if s["payouts_done"] == s["payouts_total"] {
            break;
        }
        let r = finalize(&w.root, &t, id, 8).await?;
        assert_ok(&r);
        let (b, p, k) = payout_gas(&r, &w, &t);
        (batch, on_paid) = (batch.max(b), on_paid.max(p));
        if k == 8 {
            finalize_8 = finalize_8.max(r.total_gas_burnt.as_gas());
        }
    }
    let s = get_sale(&w, &t, id).await?;
    assert_eq!(s["payouts_done"], s["payouts_total"]);
    // Only the penalty pool of the 8 sealed bids stays (paid to nobody).
    let pool = get_result(&w, &t, id).await?["penalty_pool"].clone();
    assert_eq!(pool, json!("1600000"));
    assert_eq!(mt_balance(&w.intents, t.as_str(), USDC).await?, 1_600_000);

    // cancel of a full sale (INFO-1): 64 bids rewritten + the first 8 payouts, min_escrow not
    // met. Own world: two 64-bid sales are too much state for close_now's view_state.
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let id1 = create_sale(&w, &t, ONE_NEAR, |m| {
        m["max_bids"] = json!(64);
        m["min_bidders"] = json!(1);
        m["min_escrow"] = json!("500000000");
    })
    .await?;
    for i in 0..n {
        let who = Who::Named(i % BIDDERS.len());
        fund(&w, who, 2 * ONE_USDC).await?;
        let r = send(
            &w,
            &t,
            who,
            2 * ONE_USDC,
            &bid_msg(id1, &CT, &cm()).to_string(),
        )
        .await?;
        assert!(event(&r.logs(), "bid").is_some(), "{:?}", r.logs());
    }
    close_now(&w, &t, id1).await?;
    let r = cancel(&w.root, &t, id1).await?;
    assert_ok(&r);
    let (b, p, k) = payout_gas(&r, &w, &t);
    assert_eq!(k, 8);
    (batch, on_paid) = (batch.max(b), on_paid.max(p));
    let cancel_total = r.total_gas_burnt.as_gas();
    let cancel_receipt = receipt_gas(&r, &t)[0];

    let gas = json!({
        "create": tgas_of(create),
        "bid_via_mt_transfer_call": tgas_of(bid_tx),
        "bid_mt_on_transfer_receipt": tgas_of(bid_receipt),
        "open_total": tgas_of(open_total),
        "on_key": tgas_of(on_key),
        "reveal_8": tgas_of(reveal_8),
        "self_reveal": tgas_of(self_reveal),
        "finalize_first_64_bids": tgas_of(finalize_first),
        "finalize_first_64_bids_receipt": tgas_of(finalize_first_receipt),
        "finalize_8_payouts": tgas_of(finalize_8),
        "mt_batch_transfer_receipt": tgas_of(batch),
        "on_paid": tgas_of(on_paid),
        "cancel": tgas_of(cancel_total),
        "cancel_64_bids_receipt": tgas_of(cancel_receipt),
    });
    let report = json!({
        "wasm_sha256": to_hex(&near_sdk::env::sha256(&wasm)),
        "wasm_bytes": wasm.len(),
        "bids": n,
        "gas_tgas": gas,
        "storage_bytes": {
            "config": config_bytes,
            "per_sale": per_sale,
            "per_bid": per_bid,
            "per_key_log": per_key_log,
            "per_open_keyed": per_open_keyed,
            "per_settle": per_settle,
        },
    });
    let out = format!("{MANIFEST_DIR}/scripts/out");
    std::fs::create_dir_all(&out)?;
    std::fs::write(
        format!("{out}/gas.json"),
        serde_json::to_string_pretty(&report)? + "\n",
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);

    // Limits: 80 % of each static gas constant and of the recommended prepaid gas (C14), and
    // the C26 storage estimates at least 1.25 × the measured bytes.
    let limits = [
        ("bid_mt_on_transfer_receipt", bid_receipt, 24),
        ("self_reveal", self_reveal, 24),
        ("on_key", on_key, 12),
        ("mt_batch_transfer_receipt", batch, 16),
        ("on_paid", on_paid, 4),
        ("finalize_first_64_bids", finalize_first, 240),
        ("open_total", open_total, 80),
        // 300 Tgas prepaid − 8 payouts × (20 + 10) Tgas static = 60 Tgas for the receipt.
        ("cancel_64_bids_receipt", cancel_receipt, 48),
    ];
    for (name, g, max) in limits {
        assert!(g < max * 1_000_000_000_000, "{name}: {} Tgas", tgas_of(g));
    }
    assert!(
        per_bid * 5 <= tender::BID_STORAGE_BYTES * 4,
        "per_bid {per_bid}"
    );
    assert!(
        per_sale * 5 <= tender::CREATE_STORAGE_BYTES * 4,
        "per_sale {per_sale}"
    );
    // C-02: what `open` keeps free covers its entry, the key and settle (reveals: lib.rs).
    assert!(
        (per_open_keyed + per_settle) * 5 <= tender::OPEN_STORAGE_BYTES * 4,
        "open {per_open_keyed} + settle {per_settle}"
    );
    // C-06: on_paid runs with at least 4 × the gas it uses.
    assert!(
        on_paid * 4 <= tender::intents::ON_PAID_GAS.as_gas(),
        "on_paid {} Tgas",
        tgas_of(on_paid)
    );
    Ok(())
}

/// NEP-330 metadata of the reproducible release wasm, deployed in the sandbox and read through
/// the `contract_source_metadata` view: the link and the source snapshot name commit
/// `REPRO_COMMIT`, the build ran in the pinned image.
/// `TENDER_WASM=res/tender.wasm REPRO_COMMIT=<sha> cargo test --test sandbox repro_metadata -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn repro_metadata() -> anyhow::Result<()> {
    let commit = std::env::var("REPRO_COMMIT").expect("set REPRO_COMMIT to the build commit");
    let w = world().await?;
    let t = deploy_tender(&w).await?;
    let m = view_json(&w, &t, "contract_source_metadata", json!({})).await?;
    println!("{}", serde_json::to_string_pretty(&m)?);
    let repo = "https://github.com/kocality/tender";
    assert_eq!(m["link"], format!("{repo}/tree/{commit}"));
    let b = &m["build_info"];
    assert_eq!(
        b["source_code_snapshot"],
        format!("git+{repo}?rev={commit}")
    );
    assert_eq!(
        b["build_environment"],
        "sourcescan/cargo-near:0.23.0-rust-1.99.1@sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc"
    );
    assert_eq!(b["contract_path"], "contract");
    Ok(())
}
