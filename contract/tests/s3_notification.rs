//! Gate S3a: the Intents notification path in the sandbox, against the real intents.near 0.4.5
//! wasm and the spike contract (no Tender contract here). A signed `Transfer` intent must call
//! `mt_on_transfer` on the receiver with the right `sender_id`, a returned `[amount]` must be
//! refunded, a contract must be able to pay out with `mt_batch_transfer`, and the seller's
//! direct `mt_transfer_call` must notify the receiver too.
mod common;

use common::*;
use near_workspaces::Contract;
use serde_json::json;

async fn spike(w: &World) -> anyhow::Result<Contract> {
    let acc = sub(&w.root, "spike", 10).await?;
    Ok(acc
        .deploy(&read_wasm(&spike_wasm_path()))
        .await?
        .into_result()?)
}

/// Implicit raw_ed25519 signer with 5 USDC in its Intents account.
async fn funded_signer(w: &World) -> anyhow::Result<(ed25519_dalek::SigningKey, String)> {
    let (sk, hex) = raw_ed25519_signer(7);
    let alice = &w.bidders[0];
    mint(&w.usdc, alice.id().as_str(), 5_000_000).await?;
    deposit_to_intents(&w.usdc, &w.intents, alice, 5_000_000, Some(&hex)).await?;
    assert_eq!(mt_balance(&w.intents, &hex, USDC).await?, 5_000_000);
    Ok((sk, hex))
}

fn spike_log<'a>(logs: &[&'a str]) -> &'a str {
    logs.iter()
        .find(|l| l.starts_with("spike:mt_on_transfer"))
        .copied()
        .unwrap_or_else(|| panic!("no spike:mt_on_transfer log in {logs:?}"))
}

#[tokio::test]
async fn sandbox_deploys_defuse() -> anyhow::Result<()> {
    let w = world().await?;
    let salt: String = w.intents.view("current_salt").await?.json()?;
    assert_eq!(salt.len(), 8, "{salt}");
    assert!(salt.chars().all(|c| c.is_ascii_hexdigit()));
    Ok(())
}

#[tokio::test]
async fn s3a_transfer_intent_notifies_and_keeps() -> anyhow::Result<()> {
    let w = world().await?;
    let spike = spike(&w).await?;
    let (sk, hex) = funded_signer(&w).await?;
    let signed = signed_transfer(
        &w.intents,
        &sk,
        spike.id().as_str(),
        USDC,
        1_000_000,
        "hello",
    )
    .await?;
    let res = execute_intents(&w.root, &w.intents, vec![signed]).await?;
    assert!(res.is_success(), "{}", failure_text(&res));
    let logs = res.logs();
    let line = spike_log(&logs);
    assert!(line.contains(&format!("sender={hex}")), "{line}");
    assert!(line.contains(&format!("prev={hex}")), "{line}");
    assert!(line.contains("predecessor=intents.test.near"), "{line}");
    assert!(line.ends_with("msg=hello"), "{line}");
    assert_eq!(
        mt_balance(&w.intents, spike.id().as_str(), USDC).await?,
        1_000_000
    );
    assert_eq!(mt_balance(&w.intents, &hex, USDC).await?, 4_000_000);
    Ok(())
}

#[tokio::test]
async fn s3a_late_msg_refunds() -> anyhow::Result<()> {
    let w = world().await?;
    let spike = spike(&w).await?;
    let (sk, hex) = funded_signer(&w).await?;
    let signed = signed_transfer(
        &w.intents,
        &sk,
        spike.id().as_str(),
        USDC,
        1_000_000,
        "late",
    )
    .await?;
    let res = execute_intents(&w.root, &w.intents, vec![signed]).await?;
    assert!(res.is_success(), "{}", failure_text(&res));
    let logs = res.logs();
    assert!(spike_log(&logs).ends_with("msg=late"));
    assert_eq!(mt_balance(&w.intents, spike.id().as_str(), USDC).await?, 0);
    assert_eq!(mt_balance(&w.intents, &hex, USDC).await?, 5_000_000);
    Ok(())
}

#[tokio::test]
async fn s3a_payback_mt_batch_transfer() -> anyhow::Result<()> {
    let w = world().await?;
    let spike = spike(&w).await?;
    let (sk, _hex) = funded_signer(&w).await?;
    let signed = signed_transfer(
        &w.intents,
        &sk,
        spike.id().as_str(),
        USDC,
        1_000_000,
        "keep",
    )
    .await?;
    execute_intents(&w.root, &w.intents, vec![signed])
        .await?
        .into_result()?;
    let alice = &w.bidders[0];
    let res = w
        .root
        .call(spike.id(), "payback")
        .args_json(json!({
            "receiver_id": alice.id(),
            "token_id": USDC,
            "amount": "1000000",
            "intents": w.intents.id(),
        }))
        .gas(tgas(100))
        .transact()
        .await?;
    assert!(res.is_success(), "{}", failure_text(&res));
    assert!(res.logs().contains(&"spike:payback ok"), "{:?}", res.logs());
    assert_eq!(
        mt_balance(&w.intents, alice.id().as_str(), USDC).await?,
        1_000_000
    );
    assert_eq!(mt_balance(&w.intents, spike.id().as_str(), USDC).await?, 0);
    Ok(())
}

#[tokio::test]
async fn s3a_direct_mt_transfer_call_notifies() -> anyhow::Result<()> {
    let w = world().await?;
    let spike = spike(&w).await?;
    let amount: u128 = 3 * 10u128.pow(24);
    mint(&w.wnear, w.seller.id().as_str(), amount).await?;
    deposit_to_intents(&w.wnear, &w.intents, &w.seller, amount, None).await?;
    let res = w
        .seller
        .call(w.intents.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": spike.id(),
            "token_id": WNEAR,
            "amount": amount.to_string(),
            "approval": null,
            "memo": null,
            "msg": "create-like",
        }))
        .deposit(yocto(1))
        .gas(tgas(100))
        .transact()
        .await?;
    assert!(res.is_success(), "{}", failure_text(&res));
    let logs = res.logs();
    let line = spike_log(&logs);
    assert!(line.contains("sender=tenderseal.test.near"), "{line}");
    assert!(line.ends_with("msg=create-like"), "{line}");
    assert_eq!(
        mt_balance(&w.intents, spike.id().as_str(), WNEAR).await?,
        amount
    );
    Ok(())
}

/// Info only (WD-07): how far `fast_forward` moves chain time, and how long it takes.
#[tokio::test]
#[ignore]
async fn time_probe() -> anyhow::Result<()> {
    let worker = sandbox().await?;
    let before = worker.view_block().await?;
    let wall = std::time::Instant::now();
    worker.fast_forward(1000).await?;
    let after = worker.view_block().await?;
    println!(
        "time_probe: 1000 blocks = {} s chain, {:.1} s wall (height {} -> {})",
        (after.timestamp() - before.timestamp()) / 1_000_000_000,
        wall.elapsed().as_secs_f64(),
        before.height(),
        after.height()
    );
    Ok(())
}
