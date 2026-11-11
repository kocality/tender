# contract/mock-mpc/

Mock of `v1.signer.request_app_private_key` for sandbox tests: instead of running MPC it answers a real CKD `{big_y, big_c}` for master secret 1 (domain-2 key = the G2 generator, `public_key()`), so Tender's on-chain key check (X12F-01) passes; `set_response` stores a fixed answer instead (a changed key), `clear_response` goes back, `set_fail` makes it panic. The hash-to-G1 code is the contract's own `src/keycheck.rs`. Adapted from `defdone/annon` `contracts/mock-mpc` (Apache-2.0); add the attribution to `NOTICE` when ported.

The response JSON shape must match the real one captured in gate S1 (`evidence/spikes/s1-*.json`).
