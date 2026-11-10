# contract/scripts/

- `check-imports.mjs`: wasm import allow-list, adapted from `defdone/annon` (Apache-2.0). Add `sha256`, `random_seed`, `promise_results_count`, `block_timestamp`, `account_balance` (spec §4.2). Must not allow `promise_batch_action_add_key_*`, `promise_batch_action_deploy_contract`, `promise_batch_action_delete_account`.
- `build-wasms.sh`: builds spike, mock-mpc, tests/mock-ft and (once `src/sale.rs` exists) tender, then runs `check-imports` on `target/near/tender.wasm`. Run before `cargo test`.
- `wasm-report.mjs`: merges `scripts/out/imports.json` (`check-imports --json`) and `scripts/out/gas.json` (sandbox test `gas_report`, `cargo test --test sandbox gas_report -- --ignored --nocapture`) into `evidence/wasm.json`; exits 1 if the three inputs describe different wasms.
