# @tender/cli

Judge-facing commands. Depends only on `@tender/seal`, noble and `fetch` (no wallet SDKs), so judges install it alone: `pnpm install --filter "@tender/cli..."`.

| Script | Does |
|---|---|
| `verify --sale N [--rpc URL] [--archival-rpc URL] [--rebuild]` | Re-reads mainnet state, checks the MPC key, the code hash, access keys, decrypts every bid, recomputes clearing and payouts. Checks that need archival history print WARN with the reason on provider errors. |
| `seal:try --sale N` | Encrypts a test message to sale N's identity and shows it cannot be decrypted until the key exists. |
| `seal:bid --sale N --price P --size Q --escrow B` | Seals a bid locally (no hosted bundle) and prints `{ct, cm, salt}` plus the unsigned Intents payload to sign in your own wallet. |
| `demo:local` | Full lifecycle offline in ~5 s with the demo-sale-1 fixture (P* = 3.60). |

Status: placeholder. The 20 planned `verify` checks are listed in spec §9.2; the README states the number it really runs.
