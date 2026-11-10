# Tender: sealed-bid token sales from any chain, opened by NEAR's MPC network

> Team-funded demo sales. There is no external seller yet. No AI in the product, on purpose.

Problem: in token sales today every bid is public, so participants snipe and herd, and buyers on other chains must bridge first.

Bid on a token sale from Base, Arbitrum, Solana or NEAR with your own wallet. Your price and real size are encrypted in your browser and stay as ciphertext on NEAR mainnet until the sale closes. Bidders don't have to come back: once the key is public anyone can reveal any bid (our keeper does; bidders can self-reveal without gas). At close anyone can call `open()`. The locked contract asks NEAR's MPC network for the sale's key only if the sale's public open conditions hold: total escrow ≥ `min_escrow` and distinct bidders ≥ `min_bidders`. These conditions read public escrow, not sealed prices. If they don't hold, the key is never requested, and since every key the MPC network releases to this contract is an on-chain receipt, you can check that with `pnpm verify --keys`. When the key is released, everyone decrypts every bid and the sale clears at one price anyone can recompute.

Privacy rests on NEAR's MPC threshold (11 of 16 nodes on 2026-11-10; `pnpm verify` prints the live value). We add no TEE and no committee of our own; the MPC nodes additionally run in attested TEEs.[^tee]

[^tee]: `v1.signer` `get_tee_accounts`: 17 entries, `allowed_docker_image_hashes`: 1, read on 2026-11-10; `pnpm verify` (check #2) prints the live counts. <!-- TODO(evidence: re-read in T06 from evidence/verify/sale-1-*.txt check #2, owner WS5-T06) -->

## Try it (free, no wallet, ~5 min)
Prerequisites: Node 24.22.2 (`nvm install 24.22.2`), `corepack enable`. Rust 1.99.1 and cargo-near 0.23.0 (`cargo install --locked cargo-near@0.23.0`) only for step 9, Docker only for step 10. No corepack (Node not from nodejs.org, a Docker image or a sandbox)? Use `npx -y pnpm@12.18.0` wherever a step says `pnpm`. Steps marked (needs network) read public NEAR RPC; steps marked (offline) need no network after install.
1. `git clone https://github.com/yigitcangokmen/tender && cd tender && corepack enable && pnpm install --filter "@tender/cli..."` (no corepack: `npx -y pnpm@12.18.0 install --filter "@tender/cli..."`) - see the install finish with only the CLI, `@tender/seal`, `@tender/clearing`, `@tender/intents`, noble and bs58 (no wallet SDKs).
2. (needs network) `pnpm verify --keys` - see every key `v1.tenderseal.near` ever requested from `v1.signer`, and `sale 0   0 requests · Cancelled … · never requested (sealed unless the MPC threshold colludes)`.
3. (needs network) `pnpm verify --sale 1` - see `<N>/<M> checks passed (<W> warnings)` and no `FAIL`, clearing price `3.60`, and an explorer link for every mainnet transaction. <!-- TODO(evidence: N/M/W copied verbatim from the last line of evidence/verify/sale-1-*.txt, owner WS5-T06) -->
4. (needs network) `pnpm verify --sale 0` - see sale 0 `Cancelled` with `key_requests = 0`.
5. (needs network) `pnpm seal:try --sale 2` - see `sealed: no key has been requested for sale 2 (key_requests = 0)`. Sale 2 (JAMBO) is open until 2026-11-17T12:00:00Z.
6. (needs network) `pnpm verify --sale 3` - see the attack-room sale: a garbage ciphertext and a copied bid `Penalized`, their 10% paid to the revealed bidder and 0 to the seller.
7. (offline) `pnpm demo:local` - see 6 bids sealed, opened and cleared offline in about 5 s, clearing price `3.60`.
8. (offline) `pnpm vectors` - see `4/4` official near/mpc CKD test vectors pass.
9. (needs network on a fresh machine: crates and the sandbox binary) `pnpm install && bash contract/scripts/build-wasms.sh && cd contract && cargo test` - see `<N>` sandbox scenarios and the property tests pass against the real `intents.near` 0.4.5 wasm and a mock MPC. CI: <link>. <!-- TODO(evidence: scenario count + CI run URL, owner WS1/WS4) -->
10. `<docker reproducible build command>` - see sha256 `<hash>` = the `code_hash` of `v1.tenderseal.near`; `pnpm verify --sale 1 --rebuild` does the same comparison. <!-- TODO(evidence: command + hash, owner WS1) -->
11. Open `<HOSTED_URL>/#/try` and sign with MetaMask, Phantom or a NEAR wallet - see `signature valid · insufficient balance` from `intents.near.simulate_intents` (MetaMask, Phantom); a named NEAR account whose key is not registered shows `signature valid · this NEAR key is not registered in NEAR Intents yet` (expected; a view call, nothing is spent). <!-- TODO(evidence: HOSTED_URL and texts verbatim from app/src/copy.ts, owner WS3-T02 / WS5-T06) -->
12. Open `<HOSTED_URL>/#/` - see sales 1 and 0 side by side; press **Decrypt** on sale 1 and see 6 bids decrypt in your browser and match their on-chain commitments. <!-- TODO(evidence: HOSTED_URL, owner WS4/WS5-T06) -->

Optional, costs real money (≥ 1 USDC): bid on sale 2 from any of the four chains at `<HOSTED_URL>/#/bid/2`.
If a public RPC rate-limits you: `pnpm verify --sale 1 --rpc <url> --archival-rpc <url>`. Archival-only checks print `WARN` with the reason, never `FAIL`.

## Trust table
| What | Who you trust | If it breaks |
|---|---|---|
| Bids stay unreadable until the key is released | Fewer than 11 of the 16 NEAR MPC nodes collude (2026-11-10; `verify` prints the live threshold). Same network that secures Chain Signatures. The nodes also run in attested TEEs; we add no TEE and no committee of our own | Bids are read early. Escrow stays in the contract |
| Nobody else can request this sale's key | `app_id` is derived from the calling account, so only `v1.tenderseal.near` gets this key. The account was created with no access key and has no upgrade method; each sale path contains a random seed generated after the contract existed. `verify` checks the code hash, the access-key list and the wasm imports | Visible in `verify` |
| The contract requests a key only when the public open conditions hold | Contract code (`open()`), reproducible build | Visible: the key ledger (`get_key_log`) and `pnpm verify --keys` |
| The key arrives (liveness) | NEAR MPC network | Anyone can call `cancel` after close + 24 h: full refunds |
| Bids get revealed | Anyone (the bidder, a gasless self-reveal through Intents, any third party, our keeper) during a window of at least 24 h | An unrevealed bid loses 10% of its escrow to the revealed bidders, never to the seller |
| Bidder identity and amounts | `intents.near` signature checks (erc191, raw_ed25519, nep413) | Depends on NEAR Intents |
| Clearing math | Contract code; `pnpm verify` recomputes it | A mismatch is visible |
| Cross-chain in and out | 1Click and its bridges | A stuck swap follows 1Click's own refund flow, outside the contract |
| Encryption in your browser | Our hosted JavaScript bundle | A malicious bundle could leak your price before sealing. Run the app locally or seal with `pnpm seal:bid` |
| Relaying | Nobody: `execute_intents` is permissionless | If our relayer censors you, relay elsewhere |

## Live mainnet evidence
<!-- evidence:start -->
<!-- TODO(evidence: generated by docs/scripts/evidence-table.mjs from evidence/mainnet.json, owner WS5-T06) -->
<!-- evidence:end -->
Sale 0 was configured by us to fail its thresholds (min_escrow 50 USDC, one 1 USDC bid). All bids in sales 0-3 are team-funded.
Source: `evidence/mainnet.json`. Raw RPC responses captured while still on non-archival nodes: `evidence/rpc/` (snapshot, not live).

## How it works
1. The bidder brings USDC into their own NEAR Intents account: from NEAR directly, or from Base, Arbitrum or Solana through a 1Click deposit address (the app has no send code; you send from your own wallet).
2. In the browser (or with `pnpm seal:bid`) the bid `(price, size, salt)` is encrypted with Boneh-Franklin identity-based encryption to the identity `pk ‖ app_id(v1.tenderseal.near, path)` and bound by a sha256 commitment.
3. The bidder signs one Intents `Transfer` (erc191, raw_ed25519 or nep413) of the escrow cap to `v1.tenderseal.near` with the ciphertext and commitment in `msg`. A relayer (permissionless; anyone can run one) simulates and submits it with `execute_intents`.
4. `intents.near` notifies `v1.tenderseal.near.mt_on_transfer`, which stores the sealed bid. Any failure returns the amount to the bidder.
5. After close anyone calls `open(sale)`. If the public open conditions hold (`min_escrow`, `min_bidders`), the contract calls `v1.signer.request_app_private_key` (MPC domain 2) and stores the key it receives.
6. Anyone fetches the key, decrypts every bid and calls `reveal`; the contract checks only the sha256 commitment. Bidders can also reveal gaslessly with a 1 micro-USDC Intents transfer that is returned.
7. `finalize` clears the sale at one uniform price with integer-only math, applies the 10% penalty on unrevealed bids (paid to revealed bidders, never to the seller) and pays out with `intents.near` `mt_batch_transfer`.
8. If the conditions don't hold, anyone calls `cancel`: full refunds, and the key is never requested. If no key arrives, `cancel` works after close + 24 h.
9. Bidders withdraw to any chain through a 1Click quote. `pnpm verify` recomputes the whole sale from public RPC.

## What is sealed, what is not
- Sealed until the key is released: price `p`, real size `q`, salt.
- Public from the start: each bid's escrow cap `B`, the bidder's NEAR Intents account, the time, total escrow and bidder count, the deposit transactions on the origin chain. The origin-chain badge is self-declared.
- Public after the key is released: everything, on purpose, so anyone can recompute the result.
- A cancelled sale with `key_requests = 0`: its key was never requested, so `p` and `q` were never decrypted by anyone using this contract's key. The ciphertexts stay on chain; see Honest limits.

## How Tender compares
Each competitor cell is a quote from that project's own documentation (links and read date below), or a dash where the source says nothing. Uniswap's Continuous Clearing Auction is complementary rather than a competitor.

| | Bids hidden before close | What opens them | Who evaluates the open condition | Where the price is computed | Bid from |
|---|---|---|---|---|---|
| Dark Vault [1] | Yes: "nobody can open it early, this site included" | A time lock: "as trustworthy as drand" | — (a time, not a condition) | The site: "The site learns the funded bids after the close. It has to, to decide the auction." | Zcash; "a bid paid in SOL, delivered as shielded ZEC by NEAR Intents" |
| Uniswap CCA [2] | No: bidders submit `(maxPrice, amount)` bids at prices that are multiples of `tickSpacing` above `floorPrice` | — (bids are public) | — | On chain (EVM) | EVM chains |
| Echo / Sonar [3] | No: "The commitment data API is public" | — | — | "computed off-chain by Sonar"; "you implement the allocation logic yourself" | The sale contract's chain ("e.g., Ethereum, Base") |
| Shutter API [4] | Yes (threshold encryption) | "a predetermined time or … a specific on-chain event" | "the Keyper network" | — (application-specific) | "deployed on Gnosis Chain" |
| MACI [5] | Yes, except from the coordinator: "No one except a trusted coordinator should be able to decrypt a vote." | The coordinator | The coordinator | — (voting, not a sale) | "an Ethereum application" |
| **Tender** | Yes: price and size (escrow caps are public) | `open()` on the sale contract → NEAR MPC CKD key | The contract that holds the escrow: total escrow ≥ `min_escrow` and distinct bidders ≥ `min_bidders` | On chain; anyone recomputes it with `pnpm verify` | Base, Arbitrum, Solana, NEAR, each with its own wallet |

Conditional decryption itself is not new: Shutter API offers "event-based decryption triggers". What we found nowhere else is the combination: the chain's existing MPC network as the key holder, a locked contract as the only account that can request the key, an on-chain record of every key it was given, and escrow plus settlement in the same contract. Inside this hackathon, Morrowseal [6] also releases a key from a NEAR contract on a condition; its key holder is an OutLayer TEE and the key stays private.

Tender is not a better CCA. It can run a sealed pre-round before a CCA or LBP liquidity launch: the sealed round finds a price, liquidity is handed to a pool afterwards (roadmap, not demonstrated).

[1] https://near.zecdarkvault.xyz, read 2026-11-10 · [2] https://blog.uniswap.org/continuous-clearing-auctions, https://github.com/Uniswap/continuous-clearing-auction/blob/main/docs/TechnicalDocumentation.md, read 2026-11-10 · [3] https://docs.echo.xyz/sonar/integration-guides/reading-commitment-data.md, https://docs.echo.xyz/sonar/planning/settlement-strategies.md, https://docs.echo.xyz/sonar/planning/sale-lifecycle.md, read 2026-11-10 · [4] https://docs.shutter.network/docs/protocol/api, read 2026-11-10 · [5] https://maci.pse.dev/docs/introduction, read 2026-11-10 · [6] https://github.com/zer0plugyut-afk/morrowseal, read 2026-11-10

<!-- TODO(WS5-T02-B: re-read every source 2026-11-13 10:30Z-11-14 00:00Z, refresh the read dates, owner WS5-T02) -->

## Honest limits
- Before the key is released, privacy needs fewer than 11 of 16 MPC nodes colluding (2026-11-10; `verify` prints the live value). It is not a mathematical guarantee.
- The open conditions measure public escrow, not price. Anyone with capital can push a weak sale over its thresholds with below-reserve bids, get fully refunded, and make every bid decrypt.
- The contract cannot check on chain that a ciphertext decrypts. A bidder can submit garbage and never reveal; that costs 10% of their escrow, paid to the revealed bidders, never to the seller. Invalid ciphertext is handled by this bond: the same class of fix as Dark Vault's deposits and Flock's bond.
- Bidders don't have to come back, but if nobody reveals an honest bid within the window it loses 10% too. The window is at least 24 h, anyone can reveal any bid once the key is public (our keeper does), and bidders can self-reveal without gas.
- No receipt-freeness: a bidder can prove their bid to a briber by revealing the salt, unlike MACI.
- Escrow caps, including a failed sale's total, are public. Only price and real size are sealed.
- A cancelled sale's key was never requested only if `key_requests = 0`. A sale cancelled after a failed key request may be decryptable; `verify` labels the two cases differently.
- "Never requested" means the contract never asked for the key; it still rests on the MPC threshold: eleven of sixteen nodes colluding could derive any key.
- Ciphertexts stay on chain permanently; a future compromise of NEAR's domain-2 master key would decrypt every sealed bid, including cancelled sales.
- If NEAR's MPC domain-2 key changed before a sale opens, that sale cannot open; it is cancelled after close + 24 h with full refunds.
- A seller's shill bids cannot be prevented, only seen after the key is released. Use the reserve price.
- A sale holds at most 64 bids with a 1 USDC minimum. Someone can fill the slots with below-reserve bids; nobody loses funds (they are refunded), but the sale can be crowded out. Sale 2 stays open during judging.
- Sale creation is restricted to the team account in this deployment; bidding, open, reveal, finalize and cancel are permissionless.
- If our hosted bundle were malicious it could leak your price before sealing. Seal locally with `pnpm seal:bid` if you do not trust it.
- `verify` proves the deployed wasm equals `contract/res/tender.wasm`. Proving that the source builds to that wasm needs the Docker reproducible build; without `--rebuild`, `verify` prints `WARN`.
- The NearBlocks cross-check in `verify --keys` relies on a third-party indexer and is support, not proof (`WARN` on errors). The proof is the contract's own key ledger plus the code.
- Cross-chain legs depend on 1Click and its bridges.
- Team-funded demo sales. There is no external seller yet. No AI in the product, on purpose.

## Attack room (sale 3 and others, mainnet)
| Attack | Result | Transaction |
|---|---|---|
| Call `open` before close (sale 2) | Panics | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Call `open` when the open conditions don't hold (sale 0) | Panics; `cancel` then makes it terminal | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Team account requests CKD with sale 2's path | Gets a key for its own `app_id`; it does not decrypt sale 2 (`pnpm seal:try --sale 2 --try-key evidence/spikes/eoa-ckd-2.json` → wrong identity; output `evidence/verify/seal-try-sale-2-eoa-*.txt`) | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Garbage ciphertext, never revealed | `Penalized`, 10% to revealed bidders | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Copy someone else's ct + cm (a second Solana wallet copies the honest bid) | Cannot be revealed (the commitment binds the original bidder and `B`), `Penalized` | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Late bid | Refunded by `mt_on_transfer` returning the amount | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Reveal with a wrong commitment | Panics | <!-- TODO(evidence: tx hash, owner WS4) --> |
| Seller withholds reveals to earn the penalty | Seller receives no part of the penalty | by construction (`contract/src/clearing.rs`) |

## NEAR technologies used
- MPC Confidential Key Derivation: `v1.signer` 3.18.0 on 2026-11-10 (`verify` prints the live version), domain 2 (BLS12-381), `request_app_private_key` in `<mode>` mode, called by the contract through yield/resume. <!-- TODO(evidence: app_pk_mode from get_config, owner WS1) -->
- NEAR Intents (`intents.near` 0.4.5): `Transfer` with notification → `mt_on_transfer` (NEP-245), MultiPayload `erc191`, `raw_ed25519`, `nep413`, `simulate_intents`, `execute_intents`, `mt_batch_transfer`.
- 1Click API: deposits from Base, Arbitrum and Solana into the bidder's own Intents account; withdrawals to any chain.
- A locked account: `v1.tenderseal.near` created with no access key in one transaction, no upgrade path.
- NEP-141 tokens: wNEAR (`wrap.near`), NEAR-native USDC, JAMBO (`jambo-1679.meme-cooking.near`, a meme.cooking token, sale 2).
- NEAR Connect (`@hot-labs/near-connect`), near-sdk 5.30.1, cargo-near 0.23.0 reproducible build with NEP-330 source metadata. Test vectors: near/mpc 3.18.0 (byte-identical to 3.17.0).

## Use `@tender/seal` in your own contract
<!-- TODO(ws2-api: a 10-line TypeScript example using the exact exports of packages/seal/src/index.ts; the package is private and not on npm, so the example shows a workspace import; owner WS5-T06) -->

## Built during the hackathon (Q-001, Q-003)
All of our code in this repository was written from 2026-11-08 to 2026-11-14, inside the window that opened with the announcement on 2026-10-19. There is no pre-hackathon code and no existing product on another chain (Q-002, Q-004). The IBE prototype in `prototype/` was written on 2026-11-08/09 and is kept unchanged for reference. First commit: `<hash>` (<date>). The submitted state is tagged `hackathon-submission`. Third-party files (the `intents.near` 0.4.5 wasm, adapted annon files, near/mpc test vectors) are listed under Libraries (Q-005). <!-- TODO(evidence: first commit hash and date, owner WS5-T06) -->

## Libraries, prior work and AI code (Q-005)
- `@noble/curves` 2.4.0 and `@noble/hashes` 2.4.0 (MIT), `bs58` 6.0.0: BLS12-381 pairing, hashing and encoding in `@tender/seal`.
- `drand/tlock-js` (Apache-2.0 OR MIT, Copyright (c) 2022 drand team): the identity-based encryption in `src/crypto/ibe.ts` is adapted from it.
- `defdone/annon` (Apache-2.0, Copyright 2026 defdone): `contracts/mock-mpc/` and `contracts/annon/check-imports.mjs` are adapted from it.
- `near/mpc` (MIT, Copyright (c) 2025 NEAR One Limited): CKD test vectors, `crates/threshold-signatures/tests/vectors/ckd_test_vectors.json`.
- `near/intents` (MIT, Copyright (c) 2025 NEAR Foundation): the `intents.near` 0.4.5 wasm used in sandbox tests.
- near-sdk 5.30.1, near-workspaces 0.24.0, cargo-near 0.23.0, viem 2.57.16, near-api-js 7.4.0, `@hot-labs/near-connect` 0.12.0, `@defuse-protocol/intents-sdk` 0.95.0, Vite, React.
- Parts of the code were written with AI coding assistants and reviewed by the team.
- Full list with file paths: `NOTICE` and `LICENSES/`. <!-- TODO(evidence: confirm versions against pnpm ls -r --depth 0 and contract/Cargo.toml, and NOTICE paths once WS2-T03 and WS1-T04 land, owner WS5-T06) -->

## Other projects by team members (Q-015)
Arrow: https://github.com/yigitcangokmen/arrow. A separate, independent submission: no shared code, packages, contracts, accounts or wallets. <!-- TODO(H-ARROW: confirm wording with the Arrow lead) -->

## License
MIT. See `LICENSE`, `NOTICE` and `LICENSES/`.
