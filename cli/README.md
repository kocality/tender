# @tender/cli

Judge-facing commands. Depends only on `@tender/seal`, noble and `fetch` (no wallet SDKs), so judges install it alone: `pnpm install --filter "@tender/cli..."`.

| Script | Does |
|---|---|
| `verify --sale N [--rpc URL] [--archival-rpc URL] [--rebuild]` | Re-reads mainnet state, checks the MPC key, the code hash, access keys, decrypts every bid, recomputes clearing and payouts. Checks that need archival history print WARN with the reason on provider errors. |
| `seal:try --sale N` | Encrypts a test message to sale N's identity and shows it cannot be decrypted until the key exists. |
| `seal:bid --sale N --price P --size Q --escrow B --signer ID [--seq N]` | Seals a bid locally (no hosted bundle) and prints the public `{ct, cm, seq, intents_salt, nonce, msg}` plus the unsigned Intents payload to sign in your own wallet; p, q and the salt stay in `~/.tender/bids/` (0600). The payload and a paste of the JSON into the app use one Intents nonce, so only one of them can run. `seq` is your stored bid count in the sale; the contract refunds the bid (`bid_seq`) if it differs when the bid lands. |
| `demo:local` | Full lifecycle offline in ~5 s with the demo-sale-1 fixture (P* = 3.60). |

`verify --sale N` runs 27 checks (`cli/src/lib/verify-sale.ts`).

RPC: `--rpc URL` is the only provider. Otherwise `NEAR_RPC_URL` and `NEAR_RPC_FALLBACKS` (mainnet) or `NEAR_TESTNET_RPC_URL` (testnet) go first, followed by the defaults for the chosen network: FastNEAR, dRPC, Shitzu (mainnet) or FastNEAR, dRPC, Intear (testnet). Duplicates are dropped. An HTTP 429 moves to the next provider at once.
