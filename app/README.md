# @tender/app

Vite + React frontend (hosted on Vercel until at least 2026-11-18, ideally 2026-11-25).

Screens: sale page (countdown, ciphertext wall, chain badges) · Bid wizard (1Click quote → deposit address/QR → status poll → seal → sign → relay) for MetaMask (Base, Arbitrum), Phantom (Solana) and NEAR Connect · **Try signing (free)** (`simulate_intents`, nothing spent) · Open · Decrypt & reveal (in the browser) · Reveal my bid (gasless, via Intents transfer) · results and payout table · Withdraw to chain (1Click).

No send-transaction code: deposits are plain sends to 1Click deposit addresses. The only wallet interaction is signing the bid intent.

Status: placeholder.
