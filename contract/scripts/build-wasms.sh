#!/usr/bin/env bash
# Builds every wasm the sandbox tests read. Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
for d in spike mock-mpc tests/mock-ft; do (cd "$d" && cargo near build non-reproducible-wasm); done
if [ -f src/sale.rs ]; then cargo near build non-reproducible-wasm --locked; fi
node scripts/check-imports.mjs target/near/tender.wasm 2>/dev/null || [ ! -f target/near/tender.wasm ]
ls -l spike/target/near/*.wasm mock-mpc/target/near/*.wasm tests/mock-ft/target/near/*.wasm target/near/*.wasm 2>/dev/null || true
