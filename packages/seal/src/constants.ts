// Fixed values shared by the browser app, keeper, CLI and verify.

export type AppPkMode = 'identity' | 'generator' | 'plain';

/** Hash-to-G1 domain separation tag used by NEAR's MPC CKD. */
export const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';

/** app_id = sha3_256(utf8(APP_ID_PREFIX + account + "," + path)), FIPS SHA3 (not keccak). */
export const APP_ID_PREFIX = 'near-mpc v0.1.0 app_id derivation:';

/** Domain-2 (CKD) public key of the MPC network, v1.signer / v1.signer-prod.testnet 3.18.0. */
export const MPC_DOMAIN2_PK: Record<'mainnet' | 'testnet', string> = {
  mainnet:
    'bls12381g2:24mhN4RnB2CbiUkAfukyh4s1CT6dUNd9Pc8kRnL4LvAP3tcxhUupbphmfbmwHSi66aFCiZkMgiH2KqXWJLD7JUeAFhoLS3WQbzWcpUzhERLqxyocwT9Xrd4WNvEuKavxmXdR',
  testnet:
    'bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj',
};

/** Identity-PV app key: both points are the group identity, so the MPC returns C = S. */
export const IDENTITY_PK1 = 'bls12381g1:83VnBdpeT9ioHuUTBD2zcitXg7JqNiebUs5yxDaYaLgZYDLLk2gayHrJKNyRt4vBQB';
export const IDENTITY_PK2 =
  'bls12381g2:2995BcogDeU9PQxbssLWhG9J76ubezYVpjbceWnwcmRs9ypA2vYDikf8mpuzankQX6WMsDockieKarmDerS2xTPzR1dktiHiGkjvPpRYpDip6unu4WgtPqeCPtxqppMzuGwy';

/** Generator-PV app key (a = 1): the MPC returns C = S + Y, so S = C - Y. */
export const GENERATOR_PK1 = 'bls12381g1:6aGxBiDyBZxEL9RKJz8W2h7VQUUKv9BPqHbC2DNWKExVRM7GWtLk6mTQBYXbpgRHwp';
export const GENERATOR_PK2 =
  'bls12381g2:swVJmkrgSeVKhyDHqRXbDhToeQtR2JPTTnD6fp9Jty9jfLDqDh7sAhgbHBZTfXDFh3kvZxMCwe5w4R7FXbHNt6PUkyJEsuvJ8bsqFocwyuygsJMpjaFYB8914BoaiNFsUiK';

/** `app_public_key` argument of `request_app_private_key` per mode (same JSON as the contract and keeper). */
export const APP_PK_JSON: Record<AppPkMode, object> = {
  identity: { AppPublicKeyPV: { pk1: IDENTITY_PK1, pk2: IDENTITY_PK2 } },
  generator: { AppPublicKeyPV: { pk1: GENERATOR_PK1, pk2: GENERATOR_PK2 } },
  plain: { AppPublicKey: GENERATOR_PK1 },
};

/** Ciphertext bytes for a 32-byte plaintext: U (96, compressed G2) || V (32) || W (32). */
export const CT_LEN = 160;
/** Plaintext bytes: u64_le(p) || u64_le(q) || salt16. */
export const PLAINTEXT_LEN = 32;
