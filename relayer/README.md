# @tender/relayer

- `api/relay.ts` (Vercel function): `POST /relay` with a signed MultiPayload → `intents.near.simulate_intents` → `execute_intents`. Pays gas from `relayer.tenderseal.near` (hot key, ≤ 0.5 NEAR, rate limited). Permissionless by design: anyone can run their own.
- `src/keeper.ts`: calls `open`, submits `reveal` for every decryptable bid, then `finalize` for a sale. Runs from GitHub Actions for sale #2 (closes 2026-11-17T12:00Z).
- Ops scripts as needed (S3 mainnet spike, rehearsal bids). Keys come from env (`.env.example`), never from the repo.

Status: placeholder.
