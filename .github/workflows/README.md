# .github/workflows/

To add (KICKOFF §3):
- `ci.yml`: `cargo test` in `contract/` and `pnpm test`; link the run from the README.
- `keeper.yml`: scheduled job for sale #2 (closes 2026-11-17T12:00Z): `open`, then `reveal`, then `finalize`. Uses repository secrets `KEEPER_ACCOUNT_ID` / `KEEPER_PRIVATE_KEY` (prefer a function-call key limited to the Tender contract). Test the secret and gas on Fri 11-13.
