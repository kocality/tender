# Sale specs

One JSON file per sale, plus the `new()` arguments of the contract. The team-funded demo sales are created with `relayer/scripts/sale.ts`, which prints a dry-run first and sends only with `--yes`.

```sh
pnpm --filter @tender/relayer exec tsx scripts/sale.ts --sale 1        # dry-run
pnpm --filter @tender/relayer exec tsx scripts/sale.ts --sale 1 --yes  # sends, then checks get_sale
```

A spec holds sale parameters only. It never holds a bid, a price a bidder chose, or a salt.

| File | Sale | Contract |
|---|---|---|
| `R.json` | Rehearsal sale (id 0 on the rehearsal contract) | `rehearsal.tenderseal.near` |
| `0.json` | Sale #0, fails its open conditions on purpose | `v1.tenderseal.near` |
| `1.json` | Sale #1, the main demo (closes with #0) | `v1.tenderseal.near` |
| `2.json` | Sale #2, JAMBO, closes 2026-11-17T12:00Z | `v1.tenderseal.near` |
| `3.json` | Sale #3, the attack room | `v1.tenderseal.near` |
| `v1-init.json` | `new()` arguments of `v1.tenderseal.near` | |
| `rehearsal-init.json` | `new()` arguments of the rehearsal contract | |
| `testnet-init.json` | `new()` arguments of the testnet copy (fill the `<6hex>` placeholders) | |

## Sale fields

- `id`: the id the contract will give the sale. Ids follow creation order, so sales are created in order #0, #1, #2, #3. The script refuses a mismatch unless `--allow-id-mismatch` is given.
- `seller`, `token_id`, `amount`: the seller transfers `amount` of `token_id` from its Intents balance to the contract with `mt_transfer_call`; the transfer `msg` is the create message below. `amount: "intents_balance"` means the seller's whole Intents balance of the token at creation time. `wrap_near` is the NEAR to wrap when the token is wNEAR and the Intents balance is short.
- `close`: `relative_secs` (from now), or `utc` with an optional `utc_fallback` used by `--close fallback`. The contract needs `now + 300 s <= close <= now + 30 days`.
- `create_at_utc`: when the human creates the sale (informational).
- `msg`: the create message. `close_ns` is added by the script. Amounts are decimal strings of base units; `min_bidders`, `max_bids`, `decimals` and `lot_exp` are numbers.
  - `reserve`: minimum clearing price in micro-USDC per `10^lot_exp` tokens. `auto:oneclick_x0.9` means 90% of the 1Click USD price of the token at creation time, computed with integer math; the result goes into the transaction, not into this file. `--reserve <n>` overrides it.
  - `min_escrow` (micro-USDC) and `min_bidders` are the public open conditions.
  - `reveal_secs`: reveal window, 86400 s.
  - `decimals`, `lot_exp`: the contract requires `decimals + lot_exp <= 26`.

## `new()` arguments

`mpc`, `intents`, `domain_id`, `mpc_public_key` (must equal the live `public_key({domain_id})` of the MPC contract), `quote_tokens`, `sellers`, and `app_pk_mode`, one of `identity`, `generator`, `plain`. The mode is fixed by `new()` and is decided by gate S1. Gate S1 passed on mainnet in `identity` mode (first PASS; `generator` also passed, see `evidence/spikes.json`), so the files carry `identity`. `birth.ts` refuses a mode that differs from the S1 row's `chosen_path`.
