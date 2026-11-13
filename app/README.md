# @tender/app

Vite + React frontend for Tender. It reads the sale contract over plain JSON-RPC, seals bids in the browser, asks your wallet for one signature, and hands the signed Intents payload to a relayer. Hosted on Vercel until at least 2026-11-18.

The app has no send-transaction code for EVM or Solana deposits: a deposit is a plain transfer you make from your own wallet to a 1Click deposit address. The only wallet interactions are connecting, signing one message, and (for NEAR accounts) the Open, Cancel and Reveal calls.

## Routes (hash router, so any static host works)

| Route | What |
|---|---|
| `#/` | Home: what Tender is (hero and a worked example), the two live twin sales (clock, verdict, public open conditions, key requests, timeline, Open / Cancel), who can see a bid, the 60-second path for judges. `#/?at=how`, `#/?at=live`, `#/?at=trust`, `#/?at=try` scroll to a section |
| `#/trust` | Who can see your bid: what is sealed and what is public, by role, what you rely on, all 11 limits, the seller flow, how to check it yourself |
| `#/sale/:id` | One sale: timeline, Open / Cancel, outcome, Decrypt, Reveal, Finalize, who got what, supply and demand chart; ciphertexts and rules folded |
| `#/bid/:id` | Bid wizard: wallet, price and size, fund through 1Click, seal, sign, relay. `?mode=fund` stops after funding. "Paste a sealed bid" accepts the output of `pnpm seal:bid` |
| `#/try` | Try signing (free): sign a real bid payload and ask `simulate_intents` to check it. Nothing is sent |
| `#/keys` | Key ledger: every MPC key request, matched with NearBlocks receipts |
| `#/withdraw` | Intents balance to Base, Arbitrum or Solana through 1Click |

Any other address shows "Not found".

## Record mode

`#/?rec=1` (or `#/?rec=1&at=live` to open on the twin sales) switches to the light theme, an 18 px root font and hides the debug panels (signed payloads, raw error text, evidence JSON). The choice is remembered in the browser; `#/?rec=0` turns it off. All numbers on screen stay real.

## Configuration

Read from the repository-root `.env` (`envDir: '..'`); only `VITE_*` variables reach the browser. Defaults are mainnet. The quote token, MPC public key and key mode always come from the contract's `get_config()`, never from env.

| Variable | Default |
|---|---|
| `VITE_NETWORK` | `mainnet` (`testnet` also accepted) |
| `VITE_NEAR_RPC_URL` | `https://free.rpc.fastnear.com` |
| `VITE_NEAR_RPC_FALLBACKS` | empty (comma separated URLs tried after the primary; the old default `rpc.mainnet.near.org` is deprecated and answers HTTP 429) |
| `VITE_TENDER_CONTRACT_ID` | `v1.tenderseal.near` |
| `VITE_INTENTS_CONTRACT_ID` | `intents.near` |
| `VITE_MPC_CONTRACT_ID` | `v1.signer` |
| `VITE_TRY_RECEIVER` | the Tender contract id |
| `VITE_RELAYER_URL` | empty; the full endpoint, e.g. `http://localhost:8787/relay` |
| `VITE_ONECLICK_API_URL` | `https://1click.chaindefuser.com` |
| `VITE_TWIN_SALES` | `1,0` |
| `VITE_TEAM_ACCOUNTS` | `tenderseal.near`; a sale sold by one of these accounts is labelled a team-funded demo sale |
| `VITE_DEMO_FAIL_SALES` | `0` on mainnet, empty on testnet; sale ids labelled as configured by the team to miss their open thresholds |
| `VITE_NEARBLOCKS_API_URL` | `https://api.nearblocks.io/v3` (testnet: `https://api-testnet.nearblocks.io/v3`) |
| `VITE_EXPLORER_URL` | `https://nearblocks.io` (testnet: `https://testnet.nearblocks.io`) |
| `VITE_REPO_URL` | empty; when set, the footer links the source code and JUDGES.md, and the home page links the README steps |
| `VITE_EARLIER_BUILD` | empty; `1` labels the twin sales as running on an earlier build of the contract (the T1 testnet copy) |

## Run

```sh
pnpm install --frozen-lockfile
pnpm --filter @tender/app dev                    # http://localhost:5173/#/ against mainnet defaults
pnpm --filter @tender/app test
ORACLE=1 pnpm --filter @tender/app test          # also runs the payload test against @defuse-protocol/intents-sdk (loads ~1700 dependency modules; off by default)
pnpm --filter @tender/app build                  # tsc + vite build into app/dist
```

Against a testnet copy. These are the values of the hosted testnet build ([JUDGES row P1](../JUDGES.md#off-chain)); swap in your own ids, and `VITE_RELAYER_URL=http://localhost:8787/relay` with `pnpm relay:local` on the same network to relay bids yourself:

```sh
VITE_NETWORK=testnet \
VITE_NEAR_RPC_URL=https://test.rpc.fastnear.com VITE_NEAR_RPC_FALLBACKS=https://near-testnet.drpc.org,https://testnet-rpc.intea.rs \
VITE_TENDER_CONTRACT_ID=rc3.tender-c201d6.testnet VITE_INTENTS_CONTRACT_ID=intents-09bdfe.testnet \
VITE_MPC_CONTRACT_ID=v1.signer-prod.testnet VITE_TWIN_SALES=1,2 VITE_DEMO_FAIL_SALES=2 \
VITE_TEAM_ACCOUNTS=tender-09bdfe.testnet VITE_RELAYER_URL=https://tender-sealed-relay.vercel.app/relay \
VITE_REPO_URL=https://github.com/kocality/tender \
pnpm --filter @tender/app dev
```

## NEAR wallets

The NEAR wallet list is fixed in `src/wallets/near-manifest.json`, and every wallet executor script in it is pinned to a commit. The connector's default manifest is read from a mutable branch at run time and would run whatever code is there as the signer bridge. A wallet that cannot be pinned (hosted on its vendor's own server) is not in the list. To add or update one, copy its entry from the upstream manifest, replace the executor URL by one that contains a 40-hex commit, and put the first 7 hex characters of that commit after a `+` in `version` (the connector caches executor code under `id:version`).

## Trust note

A hosted bundle could leak a price before it is sealed. To avoid trusting it, run the app locally or seal with `pnpm seal:bid` and paste the result.
