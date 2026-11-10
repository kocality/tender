# prototype/

IBE prototype written during research on 2026-11-08/09, copied unchanged from `near-build-beyond-boundaries/ideas/r3/prototypes/tender-ibe/` (without `node_modules`). Reference only: the product code lives in `packages/seal/`.

## Run

```sh
cd prototype
npm ci
node ibe.mjs
```

Expected (checked 2026-11-09):
```
{ sigOk: true, keyOk: true, roundTrip: true, wrongKey: 'rejected' }
```
four times, one line per official vector.

`@noble/*` 2.4.0 declares Node >= 20.19. It also ran on Node 18.20.8 here, but use Node 24 (`../.nvmrc`).

## Files

| File | What |
|---|---|
| `ibe.mjs` | Boneh-Franklin IBE (tlock-style FO) on BLS12-381 with NEAR's DST and identity `pk || app_id`. Exports `encrypt`, `decrypt`. On import it runs the 4 vectors from `vec.json` (read from the current directory): `sig = big_c − a·big_y`, key pairing check, round trip, wrong key rejected. |
| `vec.json` | near/mpc 3.17.0 `crates/threshold-signatures/tests/vectors/ckd_test_vectors.json`, byte-identical (sha256 `a6305d0f5179ac38591bd20efc1ec46a50c84f95e279d981f143d88c72e5b6b5`, compared with GitHub on 2026-11-09). MIT, NEAR One Limited. |
| `pv.mjs` | Checks a real mainnet PV CKD response (`live.json`, from `ckd-auth.logunov.near`) with `e(C,G2) = e(Y,pk2)·e(H(pk‖app_id),pk)`: prints `true`, then `false` for a wrong app_id. Prints the identity-point encodings and a simulated IBE round trip. |
| `live.json` | Public mainnet CKD request/response data used by `pv.mjs` (no secrets). |
| `gen.mjs` | Prints the G1/G2 generator encodings (generator-PV mode). Usage: `node gen.mjs vec.json`. |
| `t.mjs` | Earlier helper: decodes the mainnet domain-2 key and simulates a CKD + HKDF flow with a fake msk. |
| `package.json`, `package-lock.json` | Dependencies: `@noble/curves` 2.4.0, `@noble/hashes` 2.4.0, `bs58` 6.0.0. The `license: ISC` field is the npm-init default; the repository is MIT (`../LICENSE`). |

## Using it for gates S1 and S2
- Generator mode: back up `live.json` as `live.logunov.json`, write your S1 response into `live.json` (`acct: "tenderseal.near"`, your `path`, `pk2` = G2 generator), run `node pv.mjs` → first line `true`.
- Identity mode: `pv.mjs` throws `pairing is not available for ZERO point` (noble refuses pairings with the zero point). In a copy, change the `rhs` line to `const rhs = bls.pairing(Hp, pk);`. This is the same equation, since `e(Y, 0) = 1`.
