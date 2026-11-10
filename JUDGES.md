# Tender: judge checklist

Tender runs sealed-bid token sales: bids are encrypted to a key that NEAR's MPC network releases only if the sale's public open conditions hold. Everything below is free and needs no wallet unless marked.

Status of this page: DRAFT, before the mainnet deployment. Rows that need mainnet evidence carry a `TODO(evidence)` marker; testnet evidence is labelled as testnet.

## Claims and where to check them
| Claim (README wording) | Check | Code | Mainnet proof |
|---|---|---|---|
| The key is requested only if the public open conditions hold | `pnpm verify --keys` | `contract/src/sale.rs` `open` | <!-- TODO(evidence: open(1) tx, open(0) panic tx) --> Testnet: `evidence/verify/testnet-v1.tender-09bdfe-keys-20261110T1013Z.txt` |
| Only `v1.tenderseal.near` can get this key | `pnpm verify --sale 1`, checks #4 and #8 | `contract/src/seal.rs` | <!-- TODO(evidence: access key list [] on v1.tenderseal.near) --> |
| Bids are encrypted before close | `pnpm seal:try --sale 2` | `packages/seal/src/ibe.ts` | <!-- TODO(evidence: get_bids(2) ciphertexts) --> |
| The clearing price is uniform and recomputable | `pnpm verify --sale 1`, checks #15 to #18 | `contract/src/clearing.rs`, `packages/clearing` | <!-- TODO(evidence: finalize(1) tx) --> Testnet: 21/22 checks passed (1 warning), `evidence/verify/testnet-v1.tender-09bdfe-sale-0-20261110T1013Z.txt` |
| The penalty never goes to the seller | `pnpm verify --sale 3`, check #16 | `contract/src/clearing.rs` | <!-- TODO(evidence: finalize(3) tx) --> |
| Multichain bids with the bidder's own wallets | rows in `evidence/mainnet.json` | `packages/intents` | <!-- TODO(evidence: origin and destination txs) --> |
| The deployed wasm equals the repo wasm | `pnpm verify --sale 1`, check #3; `--rebuild` | `contract/res/tender.wasm.sha256` | <!-- TODO(evidence: code_hash and reproducible build hash on mainnet) --> CI build only: sha256 `59c0b7bf2b4df66899bcee9beaa84cdca343f553826b197ce89df5be3119c106` ([run](https://github.com/yigitcangokmen/tender/actions/runs/42802547382), 2026-11-10) |

## Do X, see Y
No corepack? Run `npx -y pnpm@12.18.0 install --filter "@tender/cli..."`, then use `npx -y pnpm@12.18.0` instead of `pnpm`. Prerequisite: Node 24.22.2.
1. (needs network) `git clone https://github.com/yigitcangokmen/tender && cd tender && corepack enable && pnpm install --filter "@tender/cli..."` - see the install finish with only the CLI and its libraries (no wallet SDKs).
2. (needs network) `pnpm verify --keys` - see every key `v1.tenderseal.near` ever requested, and sale 0 never requested. <!-- TODO(evidence: mainnet output, not available before the mainnet deployment) -->
3. (needs network) `pnpm verify --sale 1` - see the last line `N/M checks passed (W warnings)`, no `FAIL`, clearing price `3.60`. <!-- TODO(evidence: N/M/W from the mainnet run) -->
4. (needs network) `pnpm verify --sale 0` - see sale 0 `Cancelled` with `key_requests = 0`.
5. (needs network) `pnpm seal:try --sale 2` - see `sealed: no key has been requested for sale 2 (key_requests = 0)`.
6. (needs network) `pnpm verify --sale 3` - see the attack-room sale: bad bids `Penalized`, their 10% paid to the revealed bidder and 0 to the seller.
7. (offline) `pnpm demo:local` - see 6 bids sealed, opened and cleared offline, clearing price `3.60`.
8. (offline) `pnpm vectors` - see `4/4` official near/mpc CKD test vectors pass.
9. (needs network on a fresh machine) `pnpm install && bash contract/scripts/build-wasms.sh && cd contract && cargo test` - see 28 sandbox scenarios and the property tests pass against the real `intents.near` 0.4.5 wasm. CI: https://github.com/yigitcangokmen/tender/actions/runs/42802450952
10. (needs Docker) <!-- TODO(evidence: reproducible build command and hash) -->
11. Open the hosted app at `/#/try` and sign with a wallet (human step, nothing is spent). <!-- TODO(evidence: hosted URL) -->
12. Open the hosted app at `/#/` and press **Decrypt** on sale 1 (human step in a browser). <!-- TODO(evidence: hosted URL) -->

## Known limits
Full list: the "Honest limits" section of `README.md`. The three that matter most:
- Privacy before the key is released needs fewer than 11 of 16 MPC nodes colluding (2026-11-10); it is not a mathematical guarantee.
- The open conditions measure public escrow, not price: a weak sale can be pushed over its thresholds with below-reserve bids that are refunded.
- The contract cannot check that a ciphertext decrypts: a garbage bid costs its bidder a 10% bond, paid to revealed bidders, never to the seller.

## If something fails
- A public RPC rate-limits you: `pnpm verify --sale 1 --rpc <url> --archival-rpc <url>`.
- Archival-only and NearBlocks checks print `WARN` with the reason, never `FAIL`.
- Raw RPC responses captured at the time are in `evidence/rpc/` (snapshot, not live).
