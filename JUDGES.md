# Tender: evidence for judges

The steps: [README › Try it](README.md#try-it-free-no-wallet).

## Claims and where to check them

| Claim | Check | Code | Rows |
|---|---|---|---|
| The key is requested only if the public open conditions hold | steps 6 and 11; check #21 `key-ledger` | `contract/src/lib.rs` `open` | T14, T15, M05, M13 |
| Only `v1.tenderseal.near` can get this key | steps 4-5; checks #4 `no-access-keys`, #5 `wasm-imports`, #8 `sale-identity` | `contract/src/seal.rs` | S6-ckd, T3, M01 |
| The MPC key and live threshold are the ones [README › Trust and limits](README.md#trust-and-limits) cites | checks #1 `mpc-key`, #2 `mpc-network` | `cli/src/lib/verify-sale.ts` | |
| Deployed wasm = repo wasm = source | steps 5 and 9; checks #3 `code-hash`, #6 `reproducible-build` | `contract/res/tender.wasm.sha256` | T3, M01 |
| Bids are ciphertext before close | step 10; check #10 `key-after-close` | `packages/seal/src/ibe.ts` | S2, M07-M12 |
| Each stored bid is decrypted and checked against its commitment | checks #12 `ciphertexts-decrypt`, #13 `plaintext-matches-commitment` | `contract/src/lib.rs` `reveal` | M15 |
| One uniform, recomputable price | step 10; checks #15 `clearing-price` to #18 `uniform-price` | `contract/src/clearing.rs`, `packages/clearing` | M16 |
| The penalty never goes to the seller's account ([rule](docs/protocol.md#clearing-and-penalty)) | step 10; check #17 `conservation` (and #16 `allocations`) | `contract/src/clearing.rs` | M16 (penalty pool 0: every bid was revealed) |
| A failed sale's key is never requested | step 11; check #23 `cancelled-sealed` | `contract/src/lib.rs` `cancel` | T15, M05 |
| A sale goes Keyed only with a key that passes the pairing check against the pinned MPC key | step 10; checks #11 `key-pairing`, #21 `key-ledger` | `contract/src/seal.rs`; sandbox `x12f01_changed_key_refunds_in_full` | T7, M13 |
| One sealed bid is stored at most once per account in a sale, and of the copies our app, `pnpm seal:bid` or our bid script sign before close, intents.near runs at most one | step 10; checks #9 `bid-count`, #25 `archival-tx` | `contract/src/intents.rs`, `packages/intents/src/nonce.ts` | T10, T11 |
| Bids from four chains with the bidder's own wallet | rows M07-M12: MetaMask (Base, Arbitrum) and Phantom (Solana) in the hosted app, relayed with `execute_intents`; the NEAR bid signed with `bidder.tenderseal.near`'s own key (nep413) | `packages/intents` | S5, M07-M12 |
| Payouts are sent and confirmed | check #20 `payouts` | `contract/src/lib.rs` `finalize` | M16, M17 |

## Chain record

Raw RPC responses: `evidence/rpc/` (snapshot, not live); contract state at one block: `evidence/state/`; saved `pnpm verify` outputs: `evidence/verify/`. Machine-readable rows: `evidence/mainnet.json`, `evidence/spikes.json`, `evidence/testnet.json`.

### Mainnet: Tender

| ID | Step | Expected | Tx |
|---|---|---|---|
| M01 | birth of `v1.tenderseal.near` | one transaction, no `AddKey`; code_hash = README step 5 | [9FQuPMpJ…](https://nearblocks.io/txns/9FQuPMpJFNYJgv7dm2yyWxaUmTT73U4c9TJ9xFqMXHs3) (init block 224564596) |
| M02 | sale 0: create | [README › Demo sales](README.md#demo-sales) | [6BhEYs4m…](https://nearblocks.io/txns/6BhEYs4mPyLm7RkNuB5BY1aUcsfx8gRTK8iFvqLfsnjr) |
| M03 | sale 0: one 1.5 USDC bid | stored sealed | [CFbtMaBf…](https://nearblocks.io/txns/CFbtMaBf8uZ8H7Nzy1ABqNDkaEMWqWiPd5VWzp47T3Zc) |
| M04 | sale 0: `open` | panics: escrow below `min_escrow` | [8R92w5wm…](https://nearblocks.io/txns/8R92w5wmsoKn78jKoiC521BnS3bwEA8fo6eJvCty2DYQ) (expected failure: `open: escrow below min_escrow`) |
| M05 | sale 0: `cancel` | `Cancelled`, `key_requests = 0` | [ESQi1anK…](https://nearblocks.io/txns/ESQi1anKX1L1NjUnY46fbLZhwUdc48AT82nb1Gbw7Hef) (payouts 2/2: the bid and the seller's 0.1 wNEAR back in full) |
| M06 | sale 1: create | the sale in [README › The story](README.md#the-story) | [3nFEgSZY…](https://nearblocks.io/txns/3nFEgSZY2KAgnstvE2x8Q85srspHoqoobeDzEJ6XpgBW) |
| M07 | sale 1: bid idx 0, origin near (`bidder.tenderseal.near`, nep413), escrow 3 USDC | stored sealed | [E8pxij7q…](https://nearblocks.io/txns/E8pxij7qfa7fffBwRffJ7WS1WJzqztD2Ho9aWcH3xu7w) |
| M08 | sale 1: bid idx 1, origin base (MetaMask, erc191), escrow 5 USDC | stored sealed | [TWVwDtpS…](https://nearblocks.io/txns/TWVwDtpScJkUPuHjdijX3K4nnK79t2F61jbwNEAkPFB) |
| M09 | sale 1: bid idx 2, origin arb (MetaMask, erc191), escrow 4 USDC | stored sealed | [4AeAntyF…](https://nearblocks.io/txns/4AeAntyFbUvNUc5SsXJuWEbdMQP54Tks5caZvnUrgfcL) |
| M10 | sale 1: bid idx 3, origin base (MetaMask, erc191), escrow 2.5 USDC | stored sealed | [133qeErd…](https://nearblocks.io/txns/133qeErdhzD2LQExZmhTLvMdDXWgxLTSv5Xr21UoixtN) |
| M11 | sale 1: bid idx 4, origin sol (Phantom, raw_ed25519), escrow 5 USDC | stored sealed | [BYxRXCY4…](https://nearblocks.io/txns/BYxRXCY43cnfTAabVVPQ1wfHhwRLQhPQHHxAXSrW3vmC) |
| M12 | sale 1: bid idx 5, origin sol (Phantom, raw_ed25519), escrow 3.5 USDC | stored sealed | [GHs9KJ3T…](https://nearblocks.io/txns/GHs9KJ3Th9v3V2APo7qvcRDqXJgmzHiNj6QttaWBSb2v) |
| M13 | sale 1: `open` + `on_key` | key stored; key ledger entry `Ok` | [C9qFFYvJ…](https://nearblocks.io/txns/C9qFFYvJZfbeEiam8FEwRXCcPS85bKPfH4o52uFQN9Ni) (from the hosted app; key at block 224574778, 9 blocks after the request) |
| M14 | sale 2: `open` before close | panics: before close | not run on mainnet (sale 2 was not created) |
| M15 | sale 1: `reveal`, from the hosted app (Reveal all) | 6 bids `Revealed` | [6PpwsgUp…](https://nearblocks.io/txns/6PpwsgUpjpfwFqjghqq3g5QYcEDbTNj7HS379DvRGhc2) |
| M16 | sale 1: `finalize` | the worked-example price | [ENd8tTPH…](https://nearblocks.io/txns/ENd8tTPHDyJt3q8tcaEPCh46PSdUrczKyg1MkUfxnqta) (`Finalized`, P* 3.60, seller 10.800001 USDC, payouts 7/7) |
| M17 | sale 1: second payout batch, if needed | payouts done | not needed: all 7 payouts confirmed in M16 |
| M18 | sale 2: create | JAMBO, size filled in once created | not run on mainnet |
| M19 | team account requests CKD with sale 2's path | gets the key of its own `app_id`, which does not decrypt sale 2 | not run on mainnet |
| M20 | sale 2: `open` | after close | not run on mainnet |
| M21 | withdraw to Base through 1Click (bid idx 3's refund, from the hosted app) | arrives on the origin chain | [62mYU3Nz…](https://nearblocks.io/txns/62mYU3NzzicfeLmnbtP9MXwhvcBCa1zyXbUC9zH2cBTV) → Base [0xf97ecb5b…](https://basescan.org/tx/0xf97ecb5b09ea0f632a3620ff9675f09653dbac2659a08498fa02aadeb380f40b) (2.576906 USDC; 1Click `SUCCESS`) |
| M22 | sale 2: `finalize` | one price, payouts | not run on mainnet |

### Attack room

Sale 3 was not run on mainnet; M25-M27 are the testnet analogue on the T1 copy, sale 3 (sale 2 for the late bid). On mainnet: `open` with failed conditions (M04).

| ID | Attack | Expected | Tx |
|---|---|---|---|
| M23 | create sale 3 | — | not run on mainnet |
| M24 | honest bid | stored sealed, later `Revealed` | not run on mainnet |
| M25 | garbage ciphertext, never revealed | `Penalized` | not run on mainnet; testnet: [HXqkCCQ3…](https://testnet.nearblocks.io/txns/HXqkCCQ3v3CdM1LCAvKGB7Q66kUTQt4jjMSAv8LngCUg) (stored sealed) |
| M26 | copy someone else's ct + cm | `Penalized` ([why](docs/protocol.md#commitment)) | not run on mainnet; testnet: [Ez7HkU22…](https://testnet.nearblocks.io/txns/Ez7HkU22sFNctkZY33hyByu58UnZ8H4PfKRfEQDt2T8A) (stored sealed) |
| M27 | late bid | refunded by `mt_on_transfer` | not run on mainnet; testnet: [A9gYi4MN…](https://testnet.nearblocks.io/txns/A9gYi4MNVMKj8u8wSy51rCeKyvWPnVq3jfnxr1rDy4Xo) (refunded, reason `closed`) |
| M28 | `open` sale 3 | key stored | not run on mainnet |
| M29 | reveal with a wrong commitment | panics | not run on mainnet |
| M30 | `reveal` the honest bid | `Revealed` | not run on mainnet |
| M31 | `finalize` sale 3 | garbage and copy `Penalized` | not run on mainnet |

### Mainnet: spikes (before the contract)

| ID | What | Tx |
|---|---|---|
| S1 | CKD in identity mode from a NEAR account, checkKey true | [8F5AFdFs…](https://nearblocks.io/txns/8F5AFdFsUSC8BfzRMRZgV4XwvcCW7AuB4tidipC2wbNn) |
| S1 | CKD in generator mode from a NEAR account, checkKey true | [6xyJWF2E…](https://nearblocks.io/txns/6xyJWF2E5VWnicHivqKAWfXffaTmPXiMUWmXARuDDjgc) |
| S2 | a ciphertext made before the request decrypts with the live CKD key (identity mode; generator mode: step 10, check #12 `ciphertexts-decrypt`) | [E9dH2buE…](https://nearblocks.io/txns/E9dH2buEaK5bT5UdjwKsK3BJZBAYV1dnv7LNHZCBCr6b) |
| S3b | Intents transfer with notification reaches a contract's `mt_on_transfer` | [GY56NdTc…](https://nearblocks.io/txns/GY56NdTcE5ZSVXN1C5yjQMUqAnKtudL4MLYM1UUNfaYr) |
| S3b | late bid refunded | [BUSHLFW9…](https://nearblocks.io/txns/BUSHLFW9ARQKgkjP6bSswtLVRT1rarbADCRSLM5s5Ya9) |
| S5 | 3 USDC Base → Intents through 1Click | [FeHJEpWC…](https://nearblocks.io/txns/FeHJEpWCmynFuQ6cizgUJTWisLm6WJ3jraEMuizLM3hE) |
| S5 | 1 USDC Intents → Base, MetaMask erc191 signature | [6UerNgoy…](https://nearblocks.io/txns/6UerNgoyYR6wv3F51bmZhfC2L6fNaLQyZVC7xodQdgBY) |
| S6-ckd | contract-initiated CKD; a wrong `app_id` is rejected (identity mode; contract-initiated CKD in generator mode: T7) | [EFtUJfnV…](https://nearblocks.io/txns/EFtUJfnVANFgbv1Mkp9y3o7yxt3Xy82d6Z96DXfBNzNP) |
| S8 | `bidder.tenderseal.near` registers its nep413 key in `intents.near` | [Fd48NjqC…](https://nearblocks.io/txns/Fd48NjqCwgUPRPcMbYmHSTxXpnUXVueN9KhLF2mQoySt) |
| S9 | wNEAR → JAMBO swap through 1Click (the sale 2 supply) | [4PmogP1j…](https://nearblocks.io/txns/4PmogP1jrzmBnyftVA9oC7Bvt1B66BtWg4s1deP2po6Q) |

### Testnet

| ID | What | Tx |
|---|---|---|
| T1 | full rehearsal on 2026-11-10 on `v1.tender-09bdfe.testnet` with `v1.signer-prod.testnet` 3.18.0: a real CKD key 8 blocks after the request (block 277053281 → 277053289), P* 3.90, payouts 3/3 (`evidence/verify/testnet-v1.tender-09bdfe-*`). That copy runs an earlier, non-reproducible build, so against today's wasm `pnpm verify --network testnet --contract v1.tender-09bdfe.testnet --sale 0` prints `FAIL` on #3 `code-hash` and `22/24 checks passed (1 warning)` (2026-11-11) | birth [26np72KT…](https://testnet.nearblocks.io/txns/26np72KTmzC9z8HX743hRAcXFGXx2ohxRWyzutwYF4sK) · create [CT7GSr6x…](https://testnet.nearblocks.io/txns/CT7GSr6xCYAzm37J3fGAu7m7ceUqGefseoyfoMwt8sFF) · bid [5fdPPfk5…](https://testnet.nearblocks.io/txns/5fdPPfk5cEUg3x2aidUCZnsaE6VacJ9cztCMEgg7REsF) · bid [Ermgeczd…](https://testnet.nearblocks.io/txns/ErmgeczD8gfuRsCwDbiup6rcPZ3U3fEcuH13Vnk1T7vS) · open [4e74FNST…](https://testnet.nearblocks.io/txns/4e74FNSTRsqeckYYq8PJZmcX85DSkJeMPkjaChW48rwD) · reveal [BX2Z39mT…](https://testnet.nearblocks.io/txns/BX2Z39mTbTwcP1sinA4c63SQsuuvwAYc4pNDTKuaavPg) · finalize [FnypREk9…](https://testnet.nearblocks.io/txns/FnypREk9epKaXRaGMB8dY94rNL5PrK3PULYUduEwULui) |
| T2 | multichain-signed bids: testnet sales 4 and 6 on the T1 copy each hold a `raw_ed25519` bid (origin `sol`) and an `erc191` bid (origin `base`), relayed through `execute_intents`, later `Revealed` and paid. The signers are Node stand-ins with test keys, not real wallets | sale 4: [Gy9byvHc…](https://testnet.nearblocks.io/txns/Gy9byvHc1BEq468EzFuW4yiXE5pyhTEtTwhHuYcxjJpG) (`raw_ed25519`) · [A9AMis5a…](https://testnet.nearblocks.io/txns/A9AMis5aFz3GyiihRU4W8EEkW1wRRoNLkVafA6kNkdX1) (`erc191`); sale 6: [9eHYFAZd…](https://testnet.nearblocks.io/txns/9eHYFAZdu1JZvxLGnbsBLf4jot5sFKBFEBLo5djN5jgX) (`raw_ed25519`) · [5ZghewJ7…](https://testnet.nearblocks.io/txns/5ZghewJ73mNexVGpGpzfK9vHHNfThkz6j4EdCB2o55zv) (`erc191`) |
| T3 | RC3 copy `rc3.tender-c201d6.testnet` born from the step 9 wasm in `generator` mode, no `AddKey` | [6oWauj6o…](https://testnet.nearblocks.io/txns/6oWauj6ozFjXRGsAd8SQ8gFkYrR6vRrLuXXsT9de11JR) |
| T4 | RC3 copy: sale 0 create | [EgyGevcq…](https://testnet.nearblocks.io/txns/EgyGevcqN2dHzF11QYvWRQAweydwd1xk3jgAdNY8boEv) |
| T5 | RC3 copy: sale 0 bid, nep413 through `execute_intents`, stored sealed | [2eedD5QK…](https://testnet.nearblocks.io/txns/2eedD5QK5U1cdBQacriVSCpBSRd2XZCq7oCgrYgX8B1q) |
| T6 | RC3 copy: sale 0 bid through `mt_transfer_call`, stored sealed | [DK1C5fYz…](https://testnet.nearblocks.io/txns/DK1C5fYzRwsY8ZLcYTAc1v4u9pAMXQoZzaSPzat6R4ND) |
| T7 | RC3 copy: sale 0 `open`; the key from `v1.signer-prod.testnet` passes `on_key`'s check, key log entry 0 `Ok` | [BMET8Kxu…](https://testnet.nearblocks.io/txns/BMET8KxuhmuMTxHoFz22dTodBznBpSATkuDKKne6AFY5) |
| T8 | RC3 copy: sale 0 `reveal`, 2 bids | [EXA3vs4o…](https://testnet.nearblocks.io/txns/EXA3vs4oPwtzcwrBGwpBNppcEkiCGC8qs3w2nfsF5DFk) |
| T9 | RC3 copy: sale 0 `finalize`, P* 3.90, payouts 3/3 | [GZcQEyGc…](https://testnet.nearblocks.io/txns/GZcQEyGcjWKXrxJQN4ops2UwjKa1xiGx4L2DgwWwKNR6) |
| T10 | RC3 copy: the T6 bidder sends the same sealed bid again by direct `mt_transfer_call`, which carries no Intents nonce, so the contract decides: refunded in full, reason `dup_bid`; the sale still holds 2 bids | [Akpa82uN…](https://testnet.nearblocks.io/txns/Akpa82uN2up2GsRYMX158nRVXcjeheJPRhXuxAqq8NjJ) |
| T11 | RC3 copy: the T5 bid signed again with the same nonce and a later deadline; the Intents contract refuses it: nonce already used. Testnet has no `intents.near`: this is the project's copy `intents-09bdfe.testnet`, which runs the same intents 0.4.5 wasm (check #26 `upstream-code`) | [ADToD4ai…](https://testnet.nearblocks.io/txns/ADToD4aijCVcaxs6JXHqpfz5afJm3N6VNwgfDd7G3Zr9) |
| T12 | the hosted demo's relayer `relayer.tender-09bdfe.testnet`: a 1.5 NEAR top-up, then a function-call key limited to `execute_intents` on `intents-09bdfe.testnet` (allowance 0.5 NEAR); the hosted relayer signs with that key only | top-up [6u8YnLY7…](https://testnet.nearblocks.io/txns/6u8YnLY74TR8Z1zR2ZXcVozxoVDGfYtZDiJQqCbJJxXs) · key [VjQFm79w…](https://testnet.nearblocks.io/txns/VjQFm79wkpGvUBAtSFbYbKSvh9jNJ5xja81o6ErC57U) |
| T13 | RC3 copy: the twin, sales 1 and 2, created with the same terms and close time (0.5 wNEAR, reserve 3.00, `min_escrow` 2 USDC, `min_bidders` 2) after a 0.3 wNEAR seller deposit | deposit [48B6xbbK…](https://testnet.nearblocks.io/txns/48B6xbbKoeYFEs5D6Un2kcmncoJUJ6kfAzNA8e9PGBJH) · sale 1 [GiSDiTJ8…](https://testnet.nearblocks.io/txns/GiSDiTJ81BAQQYdvX8G62BJF4m8sPA9jVYKVXnntJA7F) · sale 2 [9z7T1GgH…](https://testnet.nearblocks.io/txns/9z7T1GgHa9unopAZAbe9EFMFJr7CdvuV8AAXxNrVpw1E) |
| T14 | RC3 copy: sale 1 meets its conditions, 4 USDC from 2 bidders (one nep413 bid sent through the hosted relayer, one `mt_transfer_call`); `open` gets the key (key log entry 1 `Ok`, 8 blocks), `reveal` 2 bids, `finalize` P* 3.60, payouts 3/3; `pnpm verify --sale 1 --rebuild` prints `25/25 checks passed` (`evidence/verify/testnet-rc3.tender-c201d6-sale-1-*`) | bid [DWcyaoLu…](https://testnet.nearblocks.io/txns/DWcyaoLuWiLc6XVFyKCEkHxNcHyKyd9A49MZYmGyhaU) · bid [24D95hCH…](https://testnet.nearblocks.io/txns/24D95hCHr9cq7KQc7weU5E2LpZf4sXVA8vq3NueAx3NE) · open [6ayJ8gf3…](https://testnet.nearblocks.io/txns/6ayJ8gf3AH9WZsD7s42UstTf4aRJMN6FktYHbUrdn8EX) · reveal [gaDfB93Z…](https://testnet.nearblocks.io/txns/gaDfB93ZnMnBGFN2YjoRAuscezkJ6Yo3K7uqjVLpJY3) · finalize [2UmEPSMQ…](https://testnet.nearblocks.io/txns/2UmEPSMQjqrJSshCe1PqTq1y68mngY7DkKCRW8JNi1Ro) |
| T15 | RC3 copy: sale 2 misses them, one 1 USDC bid from 1 bidder; `open` after close panics `escrow below min_escrow`; `cancel` makes it `Cancelled` with 0 key requests and refunds the bid in full; `pnpm verify --sale 2` passes #23 `cancelled-sealed` | bid [6ycS4HkS…](https://testnet.nearblocks.io/txns/6ycS4HkSoD8gda5Dat2D2p3QdDL9D43T5XsF2RE2mkuA) · open, refused [8ccWUc16…](https://testnet.nearblocks.io/txns/8ccWUc16v6VkF8isVsndHB3HyNL4NwBBkrGrurwbgqdp) · cancel [7yoRSnzL…](https://testnet.nearblocks.io/txns/7yoRSnzLgaKtibdq16DKe1xqvPWdp5etggwERt6RyNrz) |

### Off-chain

| ID | What | Expected | State |
|---|---|---|---|
| P1 | hosted app URL | up at least until 2026-11-18 | [tender-sealed.vercel.app](https://tender-sealed.vercel.app), mainnet: contract `v1.tenderseal.near`, NEAR Intents `intents.near`, relayer [tender-sealed-relay-mainnet.vercel.app/relay](https://tender-sealed-relay-mainnet.vercel.app/relay) (function-call key, `execute_intents` on `intents.near` only). Team-funded demo: the team is the seller and the bidders. Testnet copy: [tender-sealed-testnet.vercel.app](https://tender-sealed-testnet.vercel.app) (rows T13-T15; test tokens; 1Click runs on mainnet only) |
| P2 | demo video URL | unlisted video | pending |
| P3 | CI run of `ci.yml` with `ref` = the README step 9 commit | job `repro` prints the step 9 sha256 | [run 43080695741](https://github.com/kocality/tender/actions/runs/43080695741), job `repro` |
| P4 | tag `hackathon-submission` | tree link | pending |
| P5 | repository public | `git clone https://github.com/kocality/tender` works | pending |
| P6 | Arrow repository | public; its URL goes in this cell | [github.com/yigitcangokmen/arrow](https://github.com/yigitcangokmen/arrow) |
