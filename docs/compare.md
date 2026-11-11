# How Tender compares: sources

The quotes behind the compact table in the README's "How it compares" section. Quoted text is verbatim from the project's own documentation; unquoted text is our reading of it. All sources were read on 2026-11-10.

## Dark Vault

Source: https://near.zecdarkvault.xyz

- Bids hidden before close: "nobody can open it early, this site included"
- What opens them: a time lock, "as trustworthy as drand"
- Where the price is computed: the site. "The site learns the funded bids after the close. It has to, to decide the auction."
- Bid from: Zcash; "a bid paid in SOL, delivered as shielded ZEC by NEAR Intents"

## Uniswap CCA

Sources: https://blog.uniswap.org/continuous-clearing-auctions, https://github.com/Uniswap/continuous-clearing-auction/blob/main/docs/TechnicalDocumentation.md

- Bids hidden before close: no. Bidders submit `(maxPrice, amount)` bids at prices that are multiples of `tickSpacing` above `floorPrice`.
- Where the price is computed: on chain (EVM)
- Bid from: EVM chains
- Uniswap's blog says the design "reduces sniping, limits volatility".

## Echo / Sonar

Sources: https://docs.echo.xyz/sonar/integration-guides/reading-commitment-data.md, https://docs.echo.xyz/sonar/planning/settlement-strategies.md, https://docs.echo.xyz/sonar/planning/sale-lifecycle.md

- Bids hidden before close: no. "The commitment data API is public"
- Where the price is computed: "computed off-chain by Sonar"; "you implement the allocation logic yourself"
- Bid from: the sale contract's chain ("e.g., Ethereum, Base")

## Shutter API

Source: https://docs.shutter.network/docs/protocol/api

- Bids hidden before close: yes (threshold encryption)
- What opens them: "a predetermined time or … a specific on-chain event"
- Who decides: "the Keyper network"
- Bid from: "deployed on Gnosis Chain"

## MACI

Source: https://maci.pse.dev/docs/introduction

- Bids hidden before close: yes, except from the coordinator. "No one except a trusted coordinator should be able to decrypt a vote."
- Bid from: "an Ethereum application" (voting, not a sale)

## Morrowseal

Source: https://github.com/zer0plugyut-afk/morrowseal

Its README: "sealed to an OutLayer TEE enclave".

## meme.cooking

Source: api.meme.cooking/meme, read 2026-11-10T19:44Z (re-read before quoting).

2,320 memes, 591 with a deposit, 267 with a pool; every deposit is in wNEAR (`wrap.near`). Deposits are public.
