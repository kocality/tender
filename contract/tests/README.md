# contract/tests/

Sandbox tests (near-workspaces 0.24.0 + tokio 1.54.1) against the real `intents.near` 0.4.5 wasm and `mock-mpc/`.

- `res/defuse-0.4.5.wasm`: fetched from mainnet with RPC `view_code` on `intents.near` (source `near/intents@16d04f6ec4401263f8914638710260da50bb46b0`). Commit its sha256 next to it.
- `s3_notification.rs`: gate S3a (Intents `Transfer` notification, refund, `mt_batch_transfer`, direct `mt_transfer_call`) against the spike contract.
- `sandbox.rs`: Tender scenarios against intents 0.4.5 + `mock-ft` + `mock-mpc`. Build the wasms first: `bash scripts/build-wasms.sh`.
- `common/mod.rs`: sandbox world, signing (raw_ed25519, versioned nonce), sale/bid helpers, time travel via `patch_state`.
- Clearing golden vectors come from `../../fixtures/clearing/` and are shared with `cli/` TS tests.
- Gate S3 alternative: `defuse-sandbox` (commented in `Cargo.toml`).
