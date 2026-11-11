# fixtures/

- `clearing/*.json`: golden vectors shared by `contract/` (Rust) and `cli/` (TS): `demo-sale-1.json` (spec §5.5 table, P* = 3.60), `jambo-sale-2.json` (lot_exp = 3), penalty and zero-reveal cases.
- `ckd_test_vectors.json`: copy of near/mpc 3.17.0 `crates/threshold-signatures/tests/vectors/ckd_test_vectors.json` (MIT). Identical to `../prototype/vec.json` (sha256 `a6305d0f5179ac38591bd20efc1ec46a50c84f95e279d981f143d88c72e5b6b5`, checked 2026-11-09).
- `intents/bid-nonce.json`: the one NEAR Intents nonce of a sealed bid (DOUBLE-PLAN layer 2), shared by `@tender/intents`, `pnpm seal:bid`, the app and the scripts. Computed with Python hashlib; case 1 is the Rust sandbox vector.
- Sandbox bid fixtures.
