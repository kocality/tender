# contract/tests/

Sandbox tests (near-workspaces 0.24.0 + tokio 1.54.1) against the real `intents.near` 0.4.5 wasm and `mock-mpc/`.

- `res/defuse-0.4.5.wasm`: fetched from mainnet with RPC `view_code` on `intents.near` (source `near/intents@16d04f6ec4401263f8914638710260da50bb46b0`). Commit its sha256 next to it.
- 16 scenarios: KICKOFF §2.4 ("Sandbox senaryoları").
- Clearing golden vectors come from `../../fixtures/clearing/` and are shared with `cli/` TS tests.
- Gate S3 alternative: `defuse-sandbox` (commented in `Cargo.toml`).
