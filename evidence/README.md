# evidence/

Every mainnet transaction the project relies on. Committed. Contains no secrets, only public hashes, addresses and raw public RPC responses.

## Files

| Path | What |
|---|---|
| `spikes.json` | One row per gate (S1 to S7, plus the rehearsal and twin gates): `{gate, date_utc, result: PASS\|ALT\|FAIL, chosen_path, tx_hashes[], blocks:{request?, response?}, notes, evidence_files?[]}` |
| `spikes/` | Raw gate artifacts: CKD responses and their request/response blocks, NearBlocks visibility checks, 1Click status JSON, `mt_balance_of` before and after |
| `mainnet.json` | One row per transaction and step: `{sale, step, tx_hash, block, explorer_url}` plus optional `origin_tx`, `deposit_address`, `near_tx_hashes`, `destination_tx`, `network`, `signer_id`, `receiver_id`, `contract`, `outcome`, `expected`, `chain`, `snapshot`, `snapshot_source`, `oneclick_status`, `recorded_utc`, `note`. A cross-chain leg records the origin transaction, the 1Click `depositAddress`, the NEAR transactions (`nearTxHashes`) and the destination transaction. The key of a row is `tx_hash` plus `step`. |
| `testnet.json` | The same rows for testnet copies (`network: "testnet"`, `contract` set); `pnpm verify --network testnet --contract <copy> --sale N --evidence evidence/testnet.json` checks them in #25 |
| `rpc/<tx_hash>.json` | The raw `EXPERIMENTAL_tx_status` response for that transaction, wrapped as `{"_meta": {captured_utc, rpc_url, method, label: "snapshot, not live", source}, "result": ...}` |
| `state/<contract>-sale<id>-<YYYYMMDDTHHMMZ>.json` | A contract state snapshot at one block (config, sale, bids, result, key ledger, access keys, account, Intents balances), all read at the same `block_id` |
| `oneclick/<depositAddress>.json` | The raw 1Click `/v0/status` response for a cross-chain leg |
| `team-accounts.json` | Public addresses of the team-funded demo bidders. Not used by any other project. |
| `verify/` | Saved output of `pnpm verify` runs against mainnet |
| `wasm.json` | Wasm size, gas and storage report |

## Snapshot, not live

Every file under `rpc/`, `state/` and `oneclick/` is a snapshot taken at the time shown in its `_meta`. It is not a live view. Public non-archival NEAR RPC nodes kept about 20 hours of history on 2026-11-09; every snapshot here was captured inside that window unless its row says `snapshot_source: "archival"`. Rows marked `archival` were read from a public archival node instead, which is equally valid but not captured at the time.

A transaction that is expected to fail (for example the attack-room calls) is recorded with `"expected": "failure"` and `"outcome": "failure"`. That is the intended result, not an error.

## Reproduce

The mandatory checks of `pnpm verify` read only the contract state and do not need these files. The files here let a reader check the transactions without trusting this repository's claims:

```sh
curl -sS https://free.rpc.fastnear.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"EXPERIMENTAL_tx_status","params":{"tx_hash":"<tx_hash>","sender_account_id":"<signer_id>","wait_until":"FINAL"}}'
```

Open any `explorer_url` for the same transaction on NearBlocks.
