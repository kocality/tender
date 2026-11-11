# Tender protocol: mechanics

How the contract in `contract/src/` behaves. Constants are quoted from `contract/src/lib.rs` and `contract/src/sale.rs`.

## Sale states

`Open` → `Keyed` → `Finalized`, or `Open` → `Cancelled`.

- **Open.** Bids arrive until close. After close, `open` may request the key.
- **Keyed.** `on_key` stored the key; the reveal window runs.
- **Finalized.** The settling `finalize` cleared the sale; later calls send the remaining payouts.
- **Cancelled.** Terminal: no method leads from it to a key request. `cancel` needs state Open, no stored key, no live request, and either (a) close has passed, the open conditions fail and `key_requests == 0`, or (b) close + 24 h has passed.

The contract has no owner and no admin method. `new()` fixes the seller list, the only accounts that can create sales.

## Commitment

`cm = sha256("tender/v1" ‖ u64_le(sale) ‖ u8(len(bidder)) ‖ bidder ‖ u128_le(B) ‖ u64_le(p) ‖ u64_le(q) ‖ salt16)`

It binds the bidder's Intents account and the escrow `B`, so a copied ciphertext and commitment cannot be revealed by another account. `reveal` accepts only `1 ≤ q ≤ B` and 32 lowercase hex characters of salt.

## Key request

- **App key mode.** It is fixed in `new()`: `identity` (`S = big_c`), `generator` (`S = big_c − big_y`) or `plain` (app public key = the G1 generator, `S = big_c − big_y`). `sales/v1-init.json` sets `generator`. Both modes passed on mainnet, but identity passes the upstream key check only as a degenerate case, which a later `v1.signer` could reject; a non-upgradeable v1 could then never open a sale. Generator passes it as the ordinary case.
- **Ledger entry and call.** The entry starts as `Pending`. The call to `v1.signer.request_app_private_key` carries 1 yoctoNEAR from the contract balance and 30 Tgas plus the unused gas (weight 1); `on_key` gets 30 Tgas.
- **Key check.** `on_key` stores a key only if `e(S, G2) = e(H(mpk ‖ app_id), mpk)` holds for the domain-2 key `mpk` pinned in `new()`, with `app_id = sha3_256("near-mpc v0.1.0 app_id derivation:" ‖ contract ‖ "," ‖ path)`. `new()` refuses an `mpc_public_key` that is not a G2 point.
- **Failed answer.** If the answer does not parse or fails the key check, `on_key` records `Err`, logs a `key_error` event and clears the in-flight flag; the sale stays Open, so `open` can be retried.
- **Dead request.** A request still in flight 1 h after `open` (`IN_FLIGHT_TIMEOUT_SECS`) counts as dead: `open` may ask again and cancel rule (b) applies.
- **Late or failed key.** A key the MPC delivers after that timeout, or one whose `on_key` failed, is not stored but stays public in the MPC receipt ([`verify` #23](verify.md#the-27-checks-of---sale)).
- **Changed MPC key.** After a change of the MPC's domain-2 key, its answers fail the key check against the pinned key, so no sale goes Keyed with a key that cannot decrypt its bids: each `open` records `Err`, and cancel rule (b) refunds every bid in full from close + 24 h.

## Reveal

- **Window.** `create` accepts `reveal_secs` from 86 400 to 604 800 (1 to 7 days) and refunds anything else with reason `reveal_secs`. `finalize` may run early once every bid is revealed.
- **Direct `reveal`.** At most 16 items per call. An invalid item panics and reverts the whole batch; an item already revealed with the same opening is a no-op.
- **Gasless self-reveal.** A 1 micro-USDC Intents transfer with `{op: reveal}` carries at most 8 items in a message of at most 2048 bytes, and the micro-USDC is returned. The app's "Reveal my bids" signs one transfer per 8 bids.
- **Recovery.** `pnpm seal:bid` saves each bid to `~/.tender/bids/`. The app's "Reveal from my bid file" checks such a file against the on-chain bid and reveals it. This is the path for a bid that does not decrypt.

## Clearing and penalty

- **Ranking.** Bids rank by price, high to low; ties go by arrival.
- **Winners.** A full winner pays `q`. Every bid at `p == P*` forms the marginal group, which shares the remaining supply pro rata by `q` and pays `ceil(t·P*/scale)`.
- **Penalty.** Only if at least one bid was revealed, `finalize` withholds `floor(B/10)` from each bid still Sealed and refunds the rest; if no bid was revealed, every bid is refunded in full. The withheld pool is paid to nobody: it stays in the contract's NEAR Intents balance, and no Tender method pays it out; intents.near's admin roles could move it, as they can any Intents balance. It goes neither to the seller's account nor to the revealed bidders, because a share for revealed bids could flow back to the unrevealed bidder's own revealed decoy bid.
- **Conservation.** Σ refunds + seller USDC + pool = Σ B. `finalize` panics instead of paying out if this fails.
- **Same code twice.** `contract/src/clearing.rs` (u128) and `packages/clearing` (bigint) are both tested against `fixtures/clearing/*.json` and property tests.
- **Price unit.** Prices are micro-USDC per lot of 10^lot_exp tokens. `create` refunds with `decimals_plus_lot_exp` unless `decimals + lot_exp` is in 20..26, so one whole token can cost at most about 0.18 USDC at 6 decimals (table: `sales/README.md`). The contract cannot read `ft_metadata` while it handles the transfer, so `relayer/scripts/sale.ts` blocks a create whose declared decimals differ from the token's; `verify` #27 checks the same after the fact.

## Bids the contract refunds

`mt_on_transfer` never panics; each rejection logs a `refund` event with one of these reasons.

- **Bid reasons:** `closed`, `not_open` (also while a key request is in flight), `escrow_below_min`, `escrow_cap` (sale total over 1,000,000 USDC), `max_bids`, `msg_too_long` (bid message over 512 bytes), `bad_ct`, `bad_cm`, `bad_origin`, `wrong_token`, `seller_bid` (from the seller account), `no_sale`, `storage`, `dup_bid`, `bid_seq` (see Repeated bids).
- **Malformed transfers:** `bad_msg`, `bad_shape`, `not_from_intents`.

- **Signing deadline.** The app signs a bid payload valid for min(10 min, close − 60 s) and stops offering Seal and Sign in the last 60 s. It refuses a full sale, a sale at its escrow cap, or a sale with a key request in flight. The CLI signs deadlines that end a minute before close.
- **Plain transfers.** An Intents transfer to the contract without a bid message credits the contract and cannot be recovered.
- **Repeated bids.** A bid whose `cm` the sender already has stored in this sale is refunded `dup_bid`. A bid message may carry `seq`, a JSON number: how many bids the sender had stored in this sale when the bid was prepared; a bid whose `seq` differs from that count is refunded `bid_seq`. Only the sender's own bids are compared, and a refused bid changes no state. Both refunds name the `cm` and the sender's count (`have`, plus the stored copy's `idx` for `dup_bid`); the `bid` event names the `cm` and `nth`, the sender's earlier bids. The app, `pnpm seal:bid` and `relayer/scripts/bid-nep413.ts` sign every copy of one sealed bid with the same Intents nonce, so once one has run, a second signature of it fails as `nonce_used`. Two paths carry no such nonce: a deliberately late bid (`bid-nep413.ts --late`, a random nonce) and a direct `mt_transfer_call` (`contract/scripts/testnet-rehearsal.sh`, no Intents nonce); for those only `dup_bid` stops a second store. The app picks a new nonce only when the Intents salt was invalidated before the bid was first sent; a copy signed under an invalidated salt can never run.
- **Our app after an unclear answer.** Once a bid was sent, a lost relay answer or an Intents error (`insufficient_balance`, `deadline_expired`, `invalid_salt`, `nonce_expired`, `nonce_used`) goes to one chain check; until the chain shows the bid stored, refunded or expired, the page offers only "Sign" (the same nonce) and "Check the chain": no new deposit, quote, seal or second bid. Before any quote the page reads the account's bids: an account that already has bids gets a named confirmation ("This will be an additional bid."), and a failed read asks for nothing. The bid's ticket (commitments, ciphertext, escrow, Intents salt, `seq`, deadline, tx hashes; no price, size or commitment salt) stays in this browser's `localStorage`, so a reload or another tab finds the bid again, and tabs share one 1Click deposit address. Another browser or device sees neither.

## Storage guard

Every state-growing path keeps 0.3 NEAR free after storage (`STORAGE_RESERVE_YOCTO`). `create` and bids are refunded with reason `storage` unless that reserve still holds the room every unsettled sale needs for its `open`: 500 B per sale plus 125 B per sealed bid. An admitted bid's sale can therefore always be opened without a top-up. The contract starts with 4.5 NEAR (`evidence/wasm.json`).

## Gas and storage

Measured with the RC3 wasm in the sandbox (nearcore 2.14.0, the mock MPC, 64 bids in one sale). Source: `evidence/wasm.json`.

| Call | Tgas |
|---|---|
| `create` | 1.81 |
| bid via `mt_transfer_call` (its `mt_on_transfer` receipt) | 16.07 (7.72) |
| bid refunded `dup_bid` after scanning 64 bids (its receipt) | 7.34 |
| `open` total | 16.28 |
| `on_key` (with the key check) | 10.04 |
| `reveal` of 8 bids | 4.95 |
| gasless self-reveal | 4.82 |
| `finalize` of 64 bids, settle call (its receipt) | 70.97 (23.38) |
| `finalize` sending 8 payouts | 59.76 |
| `mt_batch_transfer` receipt | 4.47 |
| `on_paid` | 2.03 |
| `cancel` of a 64-bid sale (its receipt) | 68.69 (21.55) |

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

- **Our `/relay`.** It writes nothing to disk. It keeps request times per IP and per signer for a minute (rate limit) and, for 10 minutes, the signed body of a bid that already failed on chain, so it is not executed twice. [What it answers](../relayer/README.md#what-post-relay-answers). It logs signer accounts and transaction hashes, never the payload or signature (`relayer/src/relay.ts`).
- **Withdraw addresses.** The withdraw page refuses these addresses, which are not wallets, with the message "This is not a wallet address (a contract, mint, program or burn address).": on Solana an address off the ed25519 curve (a PDA, a vault) and the System, Token, Token-2022 and associated-token programs and the USDC and wrapped-SOL mints; on Base and Arbitrum the zero address, `0x…dead` and the USDC contracts. Any other address passes, including other EVM contracts, other Solana mints and programs, and a token account made from a normal keypair.
- **Payouts and the keeper.** `finalize` skips a payout item that is `pending` (sent, callback not run yet), so no item is paid twice; one whose callback ran out of gas stays `pending`, and `verify --sale N` lists it. Keeper rules: [relayer/README.md](../relayer/README.md#keeper-rules).
- **1Click fees.** Every recorded 1Click quote carries 1Click's own `appFees`: 1 bps on the USDC quotes and 20 bps on the wNEAR→JAMBO swap (quotes of 2026-11-10, `evidence/oneclick/`, `evidence/spikes/s5-*.json`). This repo never sets them.
