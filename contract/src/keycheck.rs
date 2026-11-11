//! X12F-01: is a CKD answer the key for the pinned domain-2 key and this contract's app_id?
//! `e(S, G2) = e(H(mpk ‖ app_id), mpk)`, with H = RFC 9380 hash_to_curve
//! `BLS12381G1_XMD:SHA-256_SSWU_RO_` under NEAR's DST, as v1.signer's own `ckd_output_check`
//! (near/mpc 3.18.0 `crates/contract/src/primitives/ckd.rs`, MIT). Only host functions run the
//! curve math (`sha3_256`, `sha256`, `bls12381_*`); the wasm adds no crypto crate. Nothing here
//! panics: a bad point is a failed check. Shared with `mock-mpc` (`#[path]`), so it depends on
//! near-sdk only.
use near_sdk::env;

const DST: &[u8] = b"NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_";
/// near/mpc `derive_app_id` prefix (`crates/near-mpc-crypto-types/src/kdf.rs`).
const APP_ID_PREFIX: &str = "near-mpc v0.1.0 app_id derivation:";
pub const G1_BYTES: usize = 48;
pub const G2_BYTES: usize = 96;

/// BLS12-381 base field modulus, little-endian u64 limbs.
const P: [u64; 6] = [
    0xb9fe_ffff_ffff_aaab,
    0x1eab_fffe_b153_ffff,
    0x6730_d2a0_f6b0_f624,
    0x6477_4b84_f385_12bf,
    0x4b1b_a7b6_434b_acd7,
    0x1a01_11ea_397f_e69a,
];

/// Uncompressed −G2, from near/mpc 3.18.0 `crates/contract/src/primitives/ckd.rs` (MIT).
const MINUS_G2: [u8; 192] = [
    19, 224, 43, 96, 82, 113, 159, 96, 125, 172, 211, 160, 136, 39, 79, 101, 89, 107, 208, 208,
    153, 32, 182, 26, 181, 218, 97, 187, 220, 127, 80, 73, 51, 76, 241, 18, 19, 148, 93, 87, 229,
    172, 125, 5, 93, 4, 43, 126, 2, 74, 162, 178, 240, 143, 10, 145, 38, 8, 5, 39, 45, 197, 16, 81,
    198, 228, 122, 212, 250, 64, 59, 2, 180, 81, 11, 100, 122, 227, 209, 119, 11, 172, 3, 38, 168,
    5, 187, 239, 212, 128, 86, 200, 193, 33, 189, 184, 19, 250, 77, 74, 10, 216, 177, 206, 24, 110,
    213, 6, 23, 137, 33, 61, 153, 57, 35, 6, 109, 221, 175, 16, 64, 188, 63, 245, 159, 130, 92,
    120, 223, 116, 242, 215, 84, 103, 226, 94, 15, 85, 248, 160, 15, 160, 48, 237, 13, 27, 60, 194,
    199, 2, 120, 136, 190, 81, 217, 239, 105, 29, 119, 188, 182, 121, 175, 218, 102, 199, 63, 23,
    249, 238, 56, 55, 165, 80, 36, 247, 140, 113, 54, 50, 117, 167, 93, 117, 216, 107, 171, 121,
    247, 71, 130, 170,
];

fn geq_p(r: &[u64; 6]) -> bool {
    for i in (0..6).rev() {
        if r[i] != P[i] {
            return r[i] > P[i];
        }
    }
    true
}

fn sub_p(r: &mut [u64; 6]) {
    let mut borrow = 0u64;
    for (limb, p) in r.iter_mut().zip(P) {
        let (d, b1) = limb.overflowing_sub(p);
        let (d, b2) = d.overflowing_sub(borrow);
        *limb = d;
        borrow = u64::from(b1 | b2);
    }
}

/// Big-endian bytes mod p, as 48 big-endian bytes (bit-serial shift-subtract).
pub fn reduce_mod_p(x: &[u8]) -> [u8; 48] {
    let mut r = [0u64; 6];
    for byte in x {
        for bit in (0..8).rev() {
            let mut carry = u64::from((byte >> bit) & 1);
            for limb in r.iter_mut() {
                let next = *limb >> 63;
                *limb = (*limb << 1) | carry;
                carry = next;
            }
            // r < p < 2^381 before the shift, so 2r + 1 < 2p fits in 384 bits and one
            // subtraction is enough.
            if geq_p(&r) {
                sub_p(&mut r);
            }
        }
    }
    let mut out = [0u8; 48];
    for (i, limb) in r.iter().enumerate() {
        out[40 - 8 * i..48 - 8 * i].copy_from_slice(&limb.to_be_bytes());
    }
    out
}

/// RFC 9380 `expand_message_xmd` with SHA-256, 128 bytes (two field elements of 64 bytes).
fn expand_xmd_128(msg: &[u8]) -> [u8; 128] {
    let mut dst_prime = DST.to_vec();
    dst_prime.push(DST.len() as u8);
    let mut m0 = vec![0u8; 64];
    m0.extend_from_slice(msg);
    m0.extend_from_slice(&[0, 128, 0]);
    m0.extend_from_slice(&dst_prime);
    let b0 = env::sha256_array(&m0);
    let mut out = [0u8; 128];
    let mut prev = [0u8; 32];
    for i in 1..=4u8 {
        let mut m = Vec::with_capacity(33 + dst_prime.len());
        if i == 1 {
            m.extend_from_slice(&b0);
        } else {
            m.extend(b0.iter().zip(prev.iter()).map(|(a, b)| a ^ b));
        }
        m.push(i);
        m.extend_from_slice(&dst_prime);
        prev = env::sha256_array(&m);
        let at = 32 * usize::from(i - 1);
        out[at..at + 32].copy_from_slice(&prev);
    }
    out
}

/// `hash_to_curve(msg)` in G1, uncompressed (96 bytes). The host's `map_fp_to_g1` clears the
/// cofactor, so `map(u0) + map(u1)` is the RFC 9380 result.
pub fn hash_to_g1(msg: &[u8]) -> Option<Vec<u8>> {
    let u = expand_xmd_128(msg);
    let mut fps = Vec::with_capacity(96);
    fps.extend_from_slice(&reduce_mod_p(&u[..64]));
    fps.extend_from_slice(&reduce_mod_p(&u[64..]));
    let q = env::bls12381_map_fp_to_g1(&fps)?;
    let mut sum = Vec::with_capacity(194);
    sum.push(0);
    sum.extend_from_slice(q.get(..96)?);
    sum.push(0);
    sum.extend_from_slice(q.get(96..192)?);
    env::bls12381_p1_sum(&sum)
}

/// near/mpc `derive_app_id(account, path)`.
pub fn app_id(account: &str, path: &str) -> [u8; 32] {
    env::sha3_256(format!("{APP_ID_PREFIX}{account},{path}").as_bytes())
}

/// `prefix` + base58 of exactly `len` bytes.
pub fn decode_point(s: &str, prefix: &str, len: usize) -> Option<Vec<u8>> {
    s.strip_prefix(prefix)
        .and_then(|b| near_sdk::bs58::decode(b).into_vec().ok())
        .filter(|v| v.len() == len)
}

/// A compressed G2 point in the subgroup and not the point at infinity.
pub fn g2_ok(mpk: &[u8]) -> bool {
    mpk.len() == G2_BYTES
        && mpk[0] & 0x40 == 0
        && env::bls12381_p2_decompress(mpk).is_some_and(|p| p.len() == 2 * G2_BYTES)
}

/// `S = big_c` (identity) or `S = big_c − big_y` (generator, plain) is the key for `mpk` and
/// `app_id`. All inputs compressed. False for S at infinity or any bad point.
pub fn key_ok(identity: bool, big_y: &[u8], big_c: &[u8], mpk: &[u8], app_id: &[u8; 32]) -> bool {
    let check = || -> Option<bool> {
        let s = if identity {
            env::bls12381_p1_decompress(big_c)?
        } else {
            let cy = env::bls12381_p1_decompress([big_c, big_y].concat())?;
            let mut sum = Vec::with_capacity(194);
            sum.push(0);
            sum.extend_from_slice(cy.get(..96)?);
            sum.push(1);
            sum.extend_from_slice(cy.get(96..192)?);
            env::bls12381_p1_sum(&sum)?
        };
        // Uncompressed encoding: 0x40 in the first byte marks the point at infinity.
        if s.first()? & 0x40 != 0 {
            return Some(false);
        }
        let pk = env::bls12381_p2_decompress(mpk)?;
        let h = hash_to_g1(&[mpk, app_id.as_slice()].concat())?;
        env::bls12381_pairing_check([s.as_slice(), &MINUS_G2, &h, &pk].concat())
    };
    check().unwrap_or(false)
}
