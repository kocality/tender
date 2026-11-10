# Shot list (recording settings U9: browser 1440x900, 100% zoom, light theme; terminal 16 pt, light theme)

Raw clips go to `video/raw/<UTC>-<event>.mov` (gitignored). Backup for every shot: the rehearsal recording `video/raw/<UTC>-rehearsal-*.mov` (M4). File names and in/out times are filled when the clips exist; until then the cells say TODO(evidence).

| # | Section | Source file | In / out | Numbers on screen | Proof of the number | Backup |
|---|---|---|---|---|---|---|
| 1 | 0:00-0:20 twin close, sale 1 (left) | `video/raw/<UTC>-twin-open-1.mov` TODO(evidence) | TODO(evidence) | 6 bids, 4 chain badges, 6 green commitments, counter 0 | open(1) tx hash; `v1.signer` receipt link; `evidence/mainnet.json` | rehearsal clip |
| 2 | 0:00-0:20 twin close, sale 0 (right) | `video/raw/<UTC>-twin-cancel-0.mov` TODO(evidence) | TODO(evidence) | escrow 1 / 50 USDC, bidders 1 / 3, key_requests 0 | cancel(0) tx hash; `pnpm verify --keys` output `evidence/verify/keys-*.txt` | rehearsal clip |
| 3 | 0:00-0:20 lower banner | still card, made in the editor | 0:00-0:20 | "Team-funded demo sales on NEAR mainnet - sale 0 configured to miss its thresholds" | README (Live mainnet evidence) | n/a |
| 4 | 0:20-0:40 sniping quote and meme.cooking | still capture of blog.uniswap.org and api.meme.cooking, `video/raw/<UTC>-sources.mov` TODO(evidence) | TODO(evidence) | 267 tokens with a pool (2,319 memes, 590 with a deposit, all deposits wrap.near, read 2026-11-10) | the final-run meme.cooking scan notes (re-read 2026-11-14) | screenshots |
| 5 | 0:40-1:05 Phantom bid | `video/raw/<UTC>-bid-sol1.mov` TODO(evidence) | TODO(evidence) | deposit address, QR, status green | SOL-1 bid tx hash and 1Click status in `evidence/mainnet.json` | rehearsal clip |
| 6 | 0:40-1:05 MetaMask on Base, 4x speed | `video/raw/<UTC>-bid-evm.mov` TODO(evidence) | TODO(evidence) | signature window | EVM bid tx hash | rehearsal clip |
| 7 | 1:05-1:35 sale 1 result | `video/raw/<UTC>-result-1.mov` TODO(evidence) | TODO(evidence) | checkKey green, 6 commitments, clearing price 3.60 | `get_result(1)`; `evidence/verify/sale-1-*.txt` | rehearsal clip |
| 8 | 1:35-2:05 withdrawals | `video/raw/<UTC>-withdraw.mov` TODO(evidence) | TODO(evidence) | Base and Solana explorer pages | withdraw txs (origin, NEAR tx hashes, destination) | basescan and solscan screenshots |
| 9 | 1:35-2:05 sale 2 card | `video/raw/<UTC>-sale2.mov` TODO(evidence) | TODO(evidence) | 22,400 JAMBO, open until 2026-11-17 | `pnpm verify --sale 2` and `get_sale(2)` | rehearsal clip |
| 10 | 2:05-2:35 clean clone | `video/raw/<UTC>-verify-cli.mov` TODO(evidence) | TODO(evidence) | green check list, key list | `evidence/verify/sale-1-*.txt`, `keys-*.txt` | previous run of the same commands |
| 11 | 2:35-2:59 close | stills from README (trust table, Honest limits) and a closing card | 2:35-2:59 | 11 of 16 | README Trust table | n/a |
