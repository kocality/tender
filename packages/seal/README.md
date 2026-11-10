# @tender/seal

Encrypt to a NEAR contract's future MPC CKD key now; decrypt after the contract requests it. Boneh-Franklin IBE (tlock-style Fujisaki-Okamoto), G2 master key = `v1.signer` domain-2 public key, identity hashed to G1 with DST `NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_` over `pk_compressed(96B) || app_id`.

Status: placeholder. Port from `../../prototype/ibe.mjs`.

API:
- `appId(account, path)` = sha3_256(`near-mpc v0.1.0 app_id derivation:{account},{path}`)
- `encrypt(mpk, appId, msg ≤ 32 B)` → 160-byte ciphertext (U 96 + V 32 + W 32)
- `keyFromCkd(big_y, big_c, mode)`: identity → `C`, generator → `C − Y`
- `checkKey(S, mpk, appId)`: `e(S, G2) == e(H(pk || app_id), mpk)`. noble refuses pairings with the zero point, so never pair with an identity `pk2`.
- `decrypt(S, ct)` with the FO re-encryption check

`pnpm vectors` runs `src/vectors.test.ts` on the 4 official near/mpc@3.17.0 vectors (`prototype/vec.json`).
