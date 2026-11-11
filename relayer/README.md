# @tender/relayer

- `api/relay.ts` (Vercel function): `POST /relay` with a signed MultiPayload → `intents.near.simulate_intents` → `execute_intents`. Pays gas from `relayer.tenderseal.near` (hot key, ≤ 0.5 NEAR, rate limited). Permissionless by design: anyone can run their own.
- `src/keeper.ts`: calls `open`, submits `reveal` for every decryptable bid, then `finalize` for a sale. Runs from GitHub Actions for sale #2 (closes 2026-11-17T12:00Z).
- Ops scripts as needed (S3 mainnet spike, rehearsal bids). Keys come from env (`.env.example`), never from the repo.

## What `POST /relay` answers

| Status | Body | Meaning |
|---|---|---|
| 200 | `{txHash, sender}` | `execute_intents` succeeded. `sender` is the signing account, so the transaction can be looked up. |
| 202 execute_unknown | `{status, txHashes, sender, until, detail}` | The relayer signed and sent, but the answer was lost. The transaction may still land until `until` (the latest payload deadline). Look the hashes up (`sender` is the signing account); do not sign the payload again with a new nonce. |
| 409 already_stored | `{sale, n}` | The chain already shows this signer's bid with the same commitment as bid `n`. Nothing was sent. |
| 409 bid_seq | `{sale, have, seq}` | The signer already has more bids in the sale than the bid's `seq` says. Nothing was sent. |
| 503 execute_unavailable | `{retry: true}` | Nothing was signed; retrying is safe. |

The two 409s only save relayer gas. The contract (`dup_bid`, `bid_seq`) and intents.near (the nonce) decide; a failed `get_bids` read refuses nothing.

## Keeper rules

- During live sales a human starts the keeper with `gh workflow run keeper`, not from a laptop: two keepers at once are guarded by the workflow concurrency group and the contract state, a third one from a laptop is not.
- Never resend a payout because an item looks stuck, even one that stays `pending` ([why](../docs/protocol.md#off-chain-services)).
