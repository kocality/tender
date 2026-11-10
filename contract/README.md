# contract/

Rust contract deployed as `v1.tenderseal.near` (locked) and, for the rehearsal, `rehearsal.tenderseal.near` (keyed, deleted afterwards).

Status: in progress. Done: state, keyless `new`, `create` and `bid` through `mt_on_transfer` (refund instead of panic), `open` / `on_key` with the key ledger, `cancel`, pure clearing (`src/clearing.rs`). Not done yet: `reveal`, self-reveal, `finalize`, payouts (`mt_batch_transfer`), full views.

## Toolchain
- Rust 1.99.1 (`rust-toolchain.toml`, same as the reproducible-build image), target `wasm32-unknown-unknown`.
- `cargo install --locked cargo-near@0.23.0`. Docker for the reproducible build.

## Commands (once code exists)
- `cargo near build non-reproducible-wasm`: fast local build (gate S6, testnet).
- `node scripts/check-imports.mjs target/near/tender.wasm`: must pass before any deploy (allow-list; no add_key, deploy_contract or delete_account imports).
- `cargo test`: unit tests, proptest on `clearing.rs`, sandbox scenarios in `tests/`.
- `cargo near build reproducible-wasm`: the wasm deployed to `v1.tenderseal.near`. Needs a committed git tree and the real `repository` URL in `Cargo.toml` (NEP-330 metadata). Record the sha256 in `res/` and `evidence/`.

## Deploy (human runs it, mainnet)
`v1.tenderseal.near` is created keyless in one transaction signed by `tenderseal.near`: CreateAccount + Transfer + DeployContract + FunctionCall `new`. No AddKey. Try the same batch on testnet first.
