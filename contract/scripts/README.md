# contract/scripts/

- `check-imports.mjs`: wasm import allow-list, adapted from `defdone/annon` (Apache-2.0). Add `sha256`, `random_seed`, `promise_results_count`, `block_timestamp`, `account_balance` (spec §4.2). Must not allow `promise_batch_action_add_key_*`, `promise_batch_action_deploy_contract`, `promise_batch_action_delete_account` (KICKOFF §2.4 K7).
