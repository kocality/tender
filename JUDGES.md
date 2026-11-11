# Tender: evidence for judges

The steps: [README › Try it](README.md#try-it-free-no-wallet).

## Claims and where to check them

| Claim | Check | Code | Rows |
|---|---|---|---|
| The key is requested only if the public open conditions hold | step 11; check #21 `key-ledger` | `contract/src/lib.rs` `open` | M05, M13 |
| Only `v1.tenderseal.near` can get this key | steps 4-5; checks #4 `no-access-keys`, #5 `wasm-imports`, #8 `sale-identity` | `contract/src/seal.rs` | S6-ckd, T3, M01 |
| The MPC key and live threshold are the ones [README › Trust and limits](README.md#trust-and-limits) cites | checks #1 `mpc-key`, #2 `mpc-network` | `cli/src/lib/verify-sale.ts` | |
| Deployed wasm = repo wasm = source | steps 5 and 9; checks #3 `code-hash`, #6 `reproducible-build` | `contract/res/tender.wasm.sha256` | T3, M01 |
| Bids are ciphertext before close | step 12; check #10 `key-after-close` | `packages/seal/src/ibe.ts` | S2, M07-M12 |
| Each stored bid is decrypted and checked against its commitment | checks #12 `ciphertexts-decrypt`, #13 `plaintext-matches-commitment` | `contract/src/lib.rs` `reveal` | M15 |
| One uniform, recomputable price | step 13; checks #15 `clearing-price` to #18 `uniform-price` | `contract/src/clearing.rs`, `packages/clearing` | M16 |
| The penalty never goes to the seller's account ([rule](docs/protocol.md#clearing-and-penalty)) | step 15; check #17 `conservation` (and #16 `allocations`) | `contract/src/clearing.rs` | M31 |
| A failed sale's key is never requested | step 14; check #23 `cancelled-sealed` | `contract/src/lib.rs` `cancel` | M05 |
| Bids from four chains with the bidder's own wallet | pending; testnet so far: row T2 | `packages/intents` | S5, M07-M12 |
| Payouts are sent and confirmed | check #20 `payouts` | `contract/src/lib.rs` `finalize` | M16, M17 |

## Chain record

Raw RPC responses: `evidence/rpc/` (snapshot, not live). Machine-readable rows: `evidence/mainnet.json`, `evidence/spikes.json`.

### Mainnet: Tender

| ID | Step | Expected | Tx |
|---|---|---|---|
| M01 | birth of `v1.tenderseal.near` | one transaction, no `AddKey`; code_hash = README step 5 | pending |
| M02 | sale 0: create | [README › Demo sales](README.md#demo-sales) | pending |
| M03 | sale 0: one 1 USDC bid | stored sealed | pending |
| M04 | sale 0: `open` | panics: escrow below `min_escrow` | pending |
| M05 | sale 0: `cancel` | `Cancelled`, `key_requests = 0` | pending |
| M06 | sale 1: create | the sale in [README › The story](README.md#the-story) | pending |
| M07 | sale 1: bid, origin base | stored sealed | pending |
| M08 | sale 1: bid, origin sol | stored sealed | pending |
| M09 | sale 1: bid, origin arb | stored sealed | pending |
| M10 | sale 1: bid, origin near | stored sealed | pending |
| M11 | sale 1: bid, origin sol | stored sealed | pending |
| M12 | sale 1: bid, origin base | stored sealed | pending |
| M13 | sale 1: `open` + `on_key` | key stored; key ledger entry `Ok` | pending |
| M14 | sale 2: `open` before close | panics: before close | pending |
| M15 | sale 1: `reveal` by the keeper | 6 bids `Revealed` | pending |
| M16 | sale 1: `finalize` | the worked-example price | pending |
| M17 | sale 1: second payout batch, if needed | payouts done | pending |
| M18 | sale 2: create | JAMBO, size filled in once created | pending |
| M19 | team account requests CKD with sale 2's path | gets the key of its own `app_id`, which does not decrypt sale 2 | pending |
| M20 | sale 2: `open` | after close | pending (close time: README step 12) |
| M21 | withdraw to Solana or Arbitrum through 1Click | arrives on the origin chain | pending |
| M22 | sale 2: `finalize` | one price, payouts | pending (close time: README step 12) |

### Attack room

Sale 3. Also attacks: `open` with failed conditions (M04), `open` before close (M14), CKD with another account (M19). Until mainnet, M25-M27 show their testnet analogue on the T1 copy, sale 3 (sale 2 for the late bid).

| ID | Attack | Expected | Tx |
|---|---|---|---|
| M23 | create sale 3 | — | pending |
| M24 | honest bid | stored sealed, later `Revealed` | pending |
| M25 | garbage ciphertext, never revealed | `Penalized` | pending; testnet: [HXqkCCQ3…](https://testnet.nearblocks.io/txns/HXqkCCQ3v3CdM1LCAvKGB7Q66kUTQt4jjMSAv8LngCUg) (stored sealed) |
| M26 | copy someone else's ct + cm | `Penalized` ([why](docs/protocol.md#commitment)) | pending; testnet: [Ez7HkU22…](https://testnet.nearblocks.io/txns/Ez7HkU22sFNctkZY33hyByu58UnZ8H4PfKRfEQDt2T8A) (stored sealed) |
| M27 | late bid | refunded by `mt_on_transfer` | pending; testnet: [A9gYi4MN…](https://testnet.nearblocks.io/txns/A9gYi4MNVMKj8u8wSy51rCeKyvWPnVq3jfnxr1rDy4Xo) (refunded, reason `closed`) |
| M28 | `open` sale 3 | key stored | pending |
| M29 | reveal with a wrong commitment | panics | pending |
| M30 | `reveal` the honest bid | `Revealed` | pending |
| M31 | `finalize` sale 3 | garbage and copy `Penalized` | pending |

### Mainnet: spikes (before the contract)

| ID | What | Tx |
|---|---|---|
| S1 | CKD in identity mode from a NEAR account, checkKey true | [8F5AFdFs…](https://nearblocks.io/txns/8F5AFdFsUSC8BfzRMRZgV4XwvcCW7AuB4tidipC2wbNn) |
| S1 | CKD in generator mode (record only) | [6xyJWF2E…](https://nearblocks.io/txns/6xyJWF2E5VWnicHivqKAWfXffaTmPXiMUWmXARuDDjgc) |
| S2 | a ciphertext made before the request decrypts with the live CKD key | [E9dH2buE…](https://nearblocks.io/txns/E9dH2buEaK5bT5UdjwKsK3BJZBAYV1dnv7LNHZCBCr6b) |
| S3b | Intents transfer with notification reaches a contract's `mt_on_transfer` | [GY56NdTc…](https://nearblocks.io/txns/GY56NdTcE5ZSVXN1C5yjQMUqAnKtudL4MLYM1UUNfaYr) |
| S3b | late bid refunded | [BUSHLFW9…](https://nearblocks.io/txns/BUSHLFW9ARQKgkjP6bSswtLVRT1rarbADCRSLM5s5Ya9) |
| S5 | 3 USDC Base → Intents through 1Click | [FeHJEpWC…](https://nearblocks.io/txns/FeHJEpWCmynFuQ6cizgUJTWisLm6WJ3jraEMuizLM3hE) |
| S5 | 1 USDC Intents → Base, MetaMask erc191 signature | [6UerNgoy…](https://nearblocks.io/txns/6UerNgoyYR6wv3F51bmZhfC2L6fNaLQyZVC7xodQdgBY) |
| S6-ckd | contract-initiated CKD; a wrong `app_id` is rejected | [EFtUJfnV…](https://nearblocks.io/txns/EFtUJfnVANFgbv1Mkp9y3o7yxt3Xy82d6Z96DXfBNzNP) |
| S8 | `bidder.tenderseal.near` registers its nep413 key in `intents.near` | [Fd48NjqC…](https://nearblocks.io/txns/Fd48NjqCwgUPRPcMbYmHSTxXpnUXVueN9KhLF2mQoySt) |
| S9 | wNEAR → JAMBO swap through 1Click (the sale 2 supply) | [4PmogP1j…](https://nearblocks.io/txns/4PmogP1jrzmBnyftVA9oC7Bvt1B66BtWg4s1deP2po6Q) |

### Testnet

| ID | What | Tx |
|---|---|---|
| T1 | full rehearsal on 2026-11-10 on `v1.tender-09bdfe.testnet` with `v1.signer-prod.testnet` 3.18.0: a real CKD key 8 blocks after the request (block 277053281 → 277053289), P* 3.90, payouts 3/3 (`evidence/verify/testnet-v1.tender-09bdfe-*`). That copy runs an earlier, non-reproducible build, so against today's wasm `pnpm verify --network testnet --contract v1.tender-09bdfe.testnet --sale 0` prints `FAIL` on #3 `code-hash` and `22/24 checks passed (1 warning)` (2026-11-11) | birth [26np72KT…](https://testnet.nearblocks.io/txns/26np72KTmzC9z8HX743hRAcXFGXx2ohxRWyzutwYF4sK) · create [CT7GSr6x…](https://testnet.nearblocks.io/txns/CT7GSr6xCYAzm37J3fGAu7m7ceUqGefseoyfoMwt8sFF) · bid [5fdPPfk5…](https://testnet.nearblocks.io/txns/5fdPPfk5cEUg3x2aidUCZnsaE6VacJ9cztCMEgg7REsF) · bid [Ermgeczd…](https://testnet.nearblocks.io/txns/ErmgeczD8gfuRsCwDbiup6rcPZ3U3fEcuH13Vnk1T7vS) · open [4e74FNST…](https://testnet.nearblocks.io/txns/4e74FNSTRsqeckYYq8PJZmcX85DSkJeMPkjaChW48rwD) · reveal [BX2Z39mT…](https://testnet.nearblocks.io/txns/BX2Z39mTbTwcP1sinA4c63SQsuuvwAYc4pNDTKuaavPg) · finalize [FnypREk9…](https://testnet.nearblocks.io/txns/FnypREk9epKaXRaGMB8dY94rNL5PrK3PULYUduEwULui) |
| T2 | multichain-signed bids: testnet sales 4 and 6 on the T1 copy each hold a `raw_ed25519` bid (origin `sol`) and an `erc191` bid (origin `base`), relayed through `execute_intents`, later `Revealed` and paid. The signers are Node stand-ins with test keys, not real wallets | sale 4: [Gy9byvHc…](https://testnet.nearblocks.io/txns/Gy9byvHc1BEq468EzFuW4yiXE5pyhTEtTwhHuYcxjJpG) (`raw_ed25519`) · [A9AMis5a…](https://testnet.nearblocks.io/txns/A9AMis5aFz3GyiihRU4W8EEkW1wRRoNLkVafA6kNkdX1) (`erc191`); sale 6: [9eHYFAZd…](https://testnet.nearblocks.io/txns/9eHYFAZdu1JZvxLGnbsBLf4jot5sFKBFEBLo5djN5jgX) (`raw_ed25519`) · [5ZghewJ7…](https://testnet.nearblocks.io/txns/5ZghewJ73mNexVGpGpzfK9vHHNfThkz6j4EdCB2o55zv) (`erc191`) |
| T3 | RC2 copy `rc2.tender-339e4b.testnet` born from the RC2 wasm, no `AddKey` | [NaApxsZu…](https://testnet.nearblocks.io/txns/NaApxsZuyGVZEsfSYsJmVUcAUpxPp2D7sLsVLfqzdPe) |
| T4 | RC2 copy: sale 0 create | pending |
| T5 | RC2 copy: sale 0 bid | pending |
| T6 | RC2 copy: sale 0 bid | pending |
| T7 | RC2 copy: sale 0 `open` | pending |
| T8 | RC2 copy: sale 0 `reveal` | pending |
| T9 | RC2 copy: sale 0 `finalize` | pending |

### Off-chain

| ID | What | Expected | State |
|---|---|---|---|
| P1 | hosted app URL | up at least until 2026-11-18 | pending |
| P2 | demo video URL | unlisted video | pending |
| P3 | CI run of `ci.yml` with `ref` = the README step 9 commit | job `repro` prints the step 9 sha256 | [run 43080695741](https://github.com/kocality/tender/actions/runs/43080695741), job `repro` |
| P4 | tag `hackathon-submission` | tree link | pending |
| P5 | repository public | `git clone https://github.com/kocality/tender` works | pending |
| P6 | Arrow repository | public; its URL goes in this cell | pending |
