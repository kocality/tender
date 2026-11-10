// @tender/seal: encrypt bids now to a NEAR contract's future MPC CKD key; decrypt after the contract requests it.
export { appId } from './appId.js';
export { hashIdentity, encrypt, decrypt } from './ibe.js';
export { keyFromCkd, keyFromCkdScalar, checkKey } from './ckd.js';
export type { CkdResponse } from './ckd.js';
export {
  parseG1,
  parseG2,
  g1ToString,
  g2ToString,
  ctToBase64,
  ctFromBase64,
  bytesToB64,
  b64ToBytes,
} from './codec.js';
export type { G1Point, G2Point } from './codec.js';
export { encodePlaintext, decodePlaintext, commitmentPreimage, commitment, commitmentHex } from './commitment.js';
export type { CommitmentInput } from './commitment.js';
export { sealBid, decryptBids } from './bids.js';
export type { SealBidInput, SealedBid, BidToDecrypt, DecryptedBid } from './bids.js';
export { simulateCkdKey, simulateCkdResponse } from './sim.js';
export {
  DST,
  APP_ID_PREFIX,
  MPC_DOMAIN2_PK,
  APP_PK_JSON,
  IDENTITY_PK1,
  IDENTITY_PK2,
  GENERATOR_PK1,
  GENERATOR_PK2,
  CT_LEN,
  PLAINTEXT_LEN,
} from './constants.js';
export type { AppPkMode } from './constants.js';
