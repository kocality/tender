# verify: what each check proves

`pnpm verify --sale N` recomputes one sale from public RPC at one pinned block and prints one line per check (`PASS #3 code-hash — <detail> <link>`), then `N/M checks passed (W warnings)`, where M counts the checks that apply to the sale's state (`n/a` lines are not counted). Any `FAIL` makes the command exit 1.

## Flags

| Flag | Default | Use |
|---|---|---|
| `--network mainnet\|testnet` | `mainnet` | which chain to read |
| `--contract <id>` | `v1.tenderseal.near` on mainnet; required on testnet | another copy, e.g. `rc2.tender-339e4b.testnet` |
| `--rpc <url>`, `--archival-rpc <url>` | public FastNEAR, then NEAR RPC | when a public RPC rate-limits you |
| `--rebuild` | off | check #6 runs the Docker reproducible build (Docker and cargo-near) |
| `--wasm <file>` | `contract/res/tender.wasm` | the wasm checks #3 and #5 compare with |
| `--evidence <file>` | `evidence/mainnet.json` | the transaction rows checks #24 and #25 read |

## The 27 checks of `--sale`

| # | Name | Proves | Not PASS when |
|---|---|---|---|
| 1 | `mpc-key` | the domain-2 MPC key in the contract = the repo constant = the live `v1.signer` key | FAIL on any mismatch |
| 2 | `mpc-network` | MPC version, threshold of participants (live), key epoch, participant ids issued (`next_id`), TEE accounts, allowed images | WARN if the MPC is not `Running` or the TEE lists cannot be read |
| 3 | `code-hash` | on-chain code_hash = sha256 of the local wasm | FAIL on mismatch; WARN if the wasm file is missing |
| 4 | `no-access-keys` | the contract account has no access keys | FAIL if it has any |
| 5 | `wasm-imports` | the wasm has no forbidden host import (list: `contract/scripts/check-imports.mjs`) | FAIL on a forbidden import; WARN if the wasm file is missing |
| 6 | `reproducible-build` | a Docker rebuild of the embedded source commit gives the on-chain code_hash | WARN without `--rebuild`; FAIL on mismatch |
| 7 | `init-before-sale` | the contract was initialised before the sale was created | FAIL otherwise |
| 8 | `sale-identity` | the sale path has the form `tender/<sale>/<32 hex>` and gives this `app_id` | FAIL otherwise |
| 9 | `bid-count` | bid list, bidder count and escrow total agree with the sale record | FAIL on a mismatch |
| 10 | `key-after-close` | bids before close, key requested after close, reveal deadline and cancel time as the contract defines them | FAIL on any timing error |
| 11 | `key-pairing` | the stored key pairs with `H(pk ‖ app_id)` under the MPC key (checkKey) | FAIL otherwise |
| 12 | `ciphertexts-decrypt` | each stored ciphertext is decrypted with the sale key; the ones that do not decrypt are listed | WARN if a Revealed bid does not decrypt |
| 13 | `plaintext-matches-commitment` | each decrypted bid is compared with its sha256 commitment (mismatches are listed), and revealed values equal the plaintext | FAIL if revealed values differ |
| 14 | `reveal-states` | every revealable bid (decrypts, matches, 1 ≤ q ≤ B) is Revealed | FAIL or WARN per bid |
| 15 | `clearing-price` | recomputed P* = `get_result` | FAIL on mismatch |
| 16 | `allocations` | allocation, spend, refund and penalty of every bid = recomputed | FAIL on any difference |
| 17 | `conservation` | the conservation rule ([protocol › Clearing and penalty](protocol.md#clearing-and-penalty)) holds; tokens in = out; bids from sub-accounts of the seller (only the seller can create them) are listed | FAIL otherwise, including a bid from the seller account itself |
| 18 | `uniform-price` | every winner pays one price ≤ its bid; losers pay 0 | FAIL otherwise |
| 19 | `escrow-balance` | the contract's Intents balances cover what every sale still owes | FAIL on a deficit |
| 20 | `payouts` | every payout of a settled sale was sent and confirmed | FAIL if pending; WARN while in flight |
| 21 | `key-ledger` | the sale's key-ledger entries = its `key_requests` | FAIL on a mismatch |
| 22 | `nearblocks-receipts` | NearBlocks request receipts = key-ledger length | WARN only |
| 23 | `cancelled-sealed` | a Cancelled sale with 0 requests prints the "never requested" label | WARN if cancelled after a request |
| 24 | `oneclick-status` | the sale's recorded 1Click deposits are `SUCCESS` (mainnet only) | WARN only |
| 25 | `archival-tx` | every recorded transaction exists with its recorded outcome | WARN only |
| 26 | `upstream-code` | `intents.near` and `v1.signer` still run the tested versions | WARN only |
| 27 | `token-decimals` | `ft_metadata` decimals of the sale token = the sale's declared decimals, and the quote token has 6 | FAIL on a mismatch; WARN if unreadable |

## WARN, never FAIL, for third parties

The mandatory checks read only the contract's own state, which stores everything they need (init block, sale timestamps, key ledger, payout status), so they need no archival RPC. NearBlocks is support, not proof: the record is the contract's key ledger plus the code.

## `--keys`

Prints the MPC version and live threshold, the key-ledger length, one line per sale (with the #23 "never requested" label for a sale cancelled without a request), and the NearBlocks count of receipts from the Tender contract to `v1.signer.request_app_private_key`, ignoring other callers (WARN on any difference). It then tries every key the contract was given on every bid of every never-requested sale and expects 0 to decrypt.

## Build-time trust

- `cargo test` downloads near-sandbox 2.14.0 and runs it with no checksum outside CI. CI pins the Linux-x86_64 tarball sha256 `a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691`. The Darwin-arm64 tarball we downloaded on 2026-11-11 has sha256 `ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232`; nothing pins it.
- `.github/workflows/ci.yml` runs the jobs `rust`, `ts`, `oracle` and `secrets` on push; `repro` runs only on manual dispatch with a `ref`.
- `node --test` suites outside the per-package counts: docs-checks 31 (+3 opt-in: `COUNTS=1`, `LIVE=1`), ci-config 11 (lockfile, actions pinned by SHA, tool downloads checked by sha256, `engineStrict`, `.env.example`), check-imports 10, m3-reveal-items 1, testnet-rehearsal 2.
- The CKD test vectors file (sha256 `a6305d0f…`) is byte-identical to 3.17.0 in near/mpc 3.18.0.
