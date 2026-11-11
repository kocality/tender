# Tender protocol: mechanics

How the contract in `contract/src/` behaves, for reviewers. Constants are quoted from `contract/src/lib.rs` and `contract/src/sale.rs`.

## Sale states

`Open` → `Keyed` → `Finalized`, or `Open` → `Cancelled`.

- **Open.** Bids arrive until close. After close, `open` may request the key.
- **Keyed.** `on_key` stored the key; the reveal window runs.
- **Finalized.** The settling `finalize` cleared the sale; later calls send the remaining payouts.
- **Cancelled.** Terminal: no method leads from it to a key request. `cancel` needs state Open, no stored key, no live request, and either (a) close has passed, the open conditions fail and `key_requests == 0`, or (b) close + 24 h has passed.

The contract has no owner and no admin method; the seller list is fixed in `new()`.

## Commitment

`cm = sha256("tender/v1" ‖ u64_le(sale) ‖ u8(len(bidder)) ‖ bidder ‖ u128_le(B) ‖ u64_le(p) ‖ u64_le(q) ‖ salt16)`

It binds the bidder's Intents account and the escrow `B`, so a copied ciphertext and commitment cannot be revealed by another account. `reveal` accepts only `1 ≤ q ≤ B` and 32 lowercase hex characters of salt.

## Key request

- **App key mode.** It is fixed in `new()`: `identity` (`S = big_c`), `generator` (`S = big_c − big_y`) or `plain` (app public key = the G1 generator, `S = big_c − big_y`). `sales/v1-init.json` sets `identity`, and the RC2 testnet copy runs `identity`.
- **Ledger entry and call.** The entry starts as `Pending`. The call to `v1.signer.request_app_private_key` carries 1 yoctoNEAR from the contract balance and 30 Tgas plus the unused gas (weight 1); `on_key` gets 15 Tgas.
- **Failed answer.** If the answer does not parse, `on_key` records `Err` and clears the in-flight flag, so `open` can be retried.
- **Dead request.** A request still in flight 1 h after `open` (`IN_FLIGHT_TIMEOUT_SECS`) counts as dead: `open` may ask again and cancel rule (b) applies.
- **Changed MPC key.** `on_key` does not compare the answer with the stored domain-2 MPC key, so after a key change the sale still goes Keyed with a key that does not decrypt its bids (`verify` #1 and #11 fail); the way out is the bid file (Reveal › Recovery).

## Reveal

- **Window.** `create` accepts `reveal_secs` from 86 400 to 604 800 (1 to 7 days) and refunds anything else with reason `reveal_secs`. `finalize` may run early once every bid is revealed.
- **Direct `reveal`.** At most 16 items per call. An invalid item panics and reverts the whole batch; an item already revealed with the same opening is a no-op.
- **Gasless self-reveal.** A 1 micro-USDC Intents transfer with `{op: reveal}` carries at most 8 items in a message of at most 2048 bytes, and the micro-USDC is returned. The app's "Reveal my bids" signs one transfer per 8 bids.
- **Recovery.** `pnpm seal:bid` saves each bid to `~/.tender/bids/`. The app's "Reveal from my bid file" checks such a file against the on-chain bid and reveals it. This is the path for a bid that does not decrypt.

## Clearing and penalty

- **Ranking.** Bids rank by price, high to low; ties go by arrival.
- **Winners.** A full winner pays `q`. Every bid at `p == P*` forms the marginal group, which shares the remaining supply pro rata by `q` and pays `ceil(t·P*/scale)`.
- **Penalty.** The 10% penalty (README › How it works, row 7) is `floor(B/10)` per Sealed bid.
- **Conservation.** Σ refunds + seller USDC + pool = Σ B. `finalize` panics instead of paying out if this fails.
- **Same code twice.** `contract/src/clearing.rs` (u128) and `packages/clearing` (bigint) are both tested against `fixtures/clearing/*.json` and property tests.
- **Price unit.** Prices are micro-USDC per lot of 10^lot_exp tokens. `create` refunds with `decimals_plus_lot_exp` unless `decimals + lot_exp` is in 20..26, so one whole token can cost at most about 0.18 USDC at 6 decimals (table: `sales/README.md`). The contract cannot read `ft_metadata` while it handles the transfer, so `relayer/scripts/sale.ts` blocks a create whose declared decimals differ from the token's; `verify` #27 checks the same after the fact.

## Bids the contract refunds

`mt_on_transfer` never panics; each rejection logs a `refund` event with one of these reasons.

- **Bid reasons:** `closed`, `not_open` (also while a key request is in flight), `escrow_below_min`, `escrow_cap` (sale total over 1,000,000 USDC), `max_bids`, `msg_too_long` (bid message over 512 bytes), `bad_ct`, `bad_cm`, `bad_origin`, `wrong_token`, `seller_bid` (from the seller account), `no_sale`, `storage`.
- **Malformed transfers:** `bad_msg`, `bad_shape`, `not_from_intents`.

- **Signing deadline.** The app signs a bid payload valid for min(10 min, close − 60 s) and stops offering Seal and Sign in the last 60 s. It refuses a full sale, a sale at its escrow cap, or a sale with a key request in flight. The CLI signs deadlines that end a minute before close.
- **Plain transfers.** An Intents transfer to the contract without a bid message credits the contract and cannot be recovered.
- **Duplicates.** The same (bidder, ciphertext, commitment) can be stored twice if it is signed from two tabs at once. The app refuses to sign a commitment the account already has stored, but the contract does not.

## Storage guard

Every state-growing path keeps 0.3 NEAR free after storage (`STORAGE_RESERVE_YOCTO`). `create` and bids are refunded with reason `storage` unless that reserve still holds the room every unsettled sale needs for its `open`: 500 B per sale plus 125 B per sealed bid. An admitted bid's sale can therefore always be opened without a top-up. The contract starts with 4.5 NEAR (`evidence/wasm.json`).

## Gas and storage

Measured with the RC2 wasm in the sandbox (nearcore 2.14.0, the mock MPC, 64 bids in one sale). Source: `evidence/wasm.json`.

| Call | Tgas |
|---|---|
| `create` | 1.8 |
| bid via `mt_transfer_call` (its `mt_on_transfer` receipt) | 10.49 (2.12) |
| `open` total | 6.73 |
| `on_key` | 2.06 |
| `reveal` of 8 bids | 4.94 |
| gasless self-reveal | 4.81 |
| `finalize` of 64 bids, settle call (its receipt) | 70.9 (23.38) |
| `finalize` sending 8 payouts | 59.69 |
| `mt_batch_transfer` receipt | 4.47 |
| `on_paid` | 2.02 |
| `cancel` of a 64-bid sale (its receipt) | 68.67 (21.54) |

`cancel` and the settling `finalize` reserve 240 Tgas for up to 8 payouts, so the 64-bid cancel fits in 300 Tgas.

| Storage | Bytes |
|---|---|
| config | 447 |
| per sale | 313 |
| per bid | 580 |
| per key-ledger entry | 79 |
| per open, keyed sale | 265 |
| per settled sale | 106 |

## Off-chain services

- **Our `/relay`.** It writes nothing to disk. It keeps request times per IP and per signer for a minute (rate limit) and, for 10 minutes, the signed body of a bid that already failed on chain, so it is not executed twice. It logs signer accounts and transaction hashes, never the payload or signature (`relayer/src/relay.ts`).
- **1Click fees.** Every recorded 1Click quote carries 1Click's own `appFees`: 1 bps on the USDC quotes and 20 bps on the wNEAR→JAMBO swap (quotes of 2026-11-10, `evidence/oneclick/`, `evidence/spikes/s5-*.json`). This repo never sets them.
