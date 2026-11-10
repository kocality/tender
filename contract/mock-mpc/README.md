# contract/mock-mpc/

Mock of `v1.signer.request_app_private_key` for sandbox tests: returns a fixed `{big_y, big_c}` from a fixture instead of running MPC. Adapted from `defdone/annon` `contracts/mock-mpc` (Apache-2.0); add the attribution to `NOTICE` when ported.

The response JSON shape must match the real one captured in gate S1 (`evidence/spikes/s1-*.json`).
