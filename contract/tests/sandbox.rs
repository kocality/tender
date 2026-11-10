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

// ---- open / on_key / key ledger / cancel (WS1-T06; scenarios 3, 8, 9, 17, 18, 19) ----

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
    let r = call_tender(&w.root, &t, "cancel", json!({ "sale": id.to_string() })).await?;
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
    let r = call_tender(&w.root, &t, "cancel", json!({ "sale": id.to_string() })).await?;
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
    let r = call_tender(&w.root, &t, "cancel", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "cancel: conditions not met");
    close_minus(&w, &t, id, 86_401).await?;
    let r = call_tender(&w.root, &t, "cancel", json!({ "sale": id.to_string() })).await?;
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
    let r = call_tender(&w.root, &t, "cancel", json!({ "sale": id.to_string() })).await?;
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
    let r = call_tender(&w.root, &t, "cancel", json!({ "sale": id.to_string() })).await?;
    assert_fails_with(&r, "cancel: conditions not met");
    Ok(())
}
