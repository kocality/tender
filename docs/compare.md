# How Tender compares: sources

Sources for [README › How it compares](../README.md#how-it-compares). Quoted text is verbatim from the project's own documentation; unquoted text is our reading of it. All sources were read on 2026-11-10 or 2026-11-11.

## Dark Vault

Source: https://near.zecdarkvault.xyz

- Bids hidden before close: "nobody can open it early, this site included"
- What opens them: a time lock, "as trustworthy as drand"
- Bid from: Zcash; "a bid paid in SOL, delivered as shielded ZEC by NEAR Intents"

## Uniswap CCA

Sources: https://blog.uniswap.org/continuous-clearing-auctions, https://github.com/Uniswap/continuous-clearing-auction/blob/main/docs/TechnicalDocumentation.md

- Bids hidden before close: bidders submit `(maxPrice, amount)` bids at prices that are multiples of `tickSpacing` above `floorPrice`.
- Bid from: on chain (EVM)
- Uniswap's blog says the design "reduces sniping, limits volatility".

## Echo / Sonar

Sources: https://docs.echo.xyz/sonar/integration-guides/reading-commitment-data.md, https://docs.echo.xyz/sonar/planning/settlement-strategies.md, https://docs.echo.xyz/sonar/planning/sale-lifecycle.md

- Bids hidden before close: "The commitment data API is public"
- Bid from: "e.g., Ethereum, Base"

## Shutter API

Source: https://docs.shutter.network/docs/protocol/api

- Bids hidden before close: "It operates as a distributed threshold encryption network"
- What opens them: "a predetermined time or … a specific on-chain event"
- Who decides: "the Keyper network"
- Bid from: "deployed on Gnosis Chain"

## MACI

Source: https://maci.pse.dev/docs/introduction

- Bids hidden before close: "No one except a trusted coordinator should be able to decrypt a vote."
- Bid from: "an Ethereum application"

## Morrowseal

Source: https://github.com/zer0plugyut-afk/morrowseal

Its README: "sealed to an OutLayer TEE enclave"; "If the owner stops checking in, the vault is released on chain".
