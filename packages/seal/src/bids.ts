import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { appId } from './appId.js';
import { type G1Point, ctFromBase64, ctToBase64, parseG1 } from './codec.js';
import { commitmentHex, decodePlaintext, encodePlaintext } from './commitment.js';
import { decrypt, encrypt } from './ibe.js';

export interface SealBidInput {
  mpk: Uint8Array | string;
  contract: string;
  path: string;
  sale: bigint;
  bidder: string;
  B: bigint;
  p: bigint;
  q: bigint;
  /** 16 bytes; random when omitted. Keep it secret until reveal: with the salt, p and q can be brute-forced from cm. */
  salt?: Uint8Array;
}

export interface SealedBid {
  ct_b64: string;
  cm_hex: string;
  salt_hex: string;
  plaintext: Uint8Array;
}

/** Seal (p, q, salt) to the sale identity app_id(contract, path) and commit to it for `bidder`. */
export function sealBid({ mpk, contract, path, sale, bidder, B, p, q, salt }: SealBidInput): SealedBid {
  const s = salt ?? randomBytes(16);
  const plaintext = encodePlaintext(p, q, s);
  const ct = encrypt(mpk, appId(contract, path), plaintext);
  return { ct_b64: ctToBase64(ct), cm_hex: commitmentHex({ sale, bidder, B, p, q, salt: s }), salt_hex: bytesToHex(s), plaintext };
}

export interface BidToDecrypt {
  idx: number;
  bidder: string;
  B: bigint;
  ct: string;
  cm: string;
}

export interface DecryptedBid {
  idx: number;
  ok: boolean;
  reason?: string;
  p?: bigint;
  q?: bigint;
  salt_hex?: string;
  cmOk?: boolean;
  /** The contract's reveal rule: decrypts, the commitment matches and 1 ≤ q ≤ B (else `reveal` panics the batch).
   * Always set by decryptBids; optional only so hand-built rows stay valid (absent = not revealable). */
  revealable?: boolean;
}

/**
 * Decrypt every bid with the sale key and recheck its commitment. Never throws: a malformed ciphertext gives
 * `{ok: false, reason}`, a copied ct+cm under another bidder decrypts but gives `cmOk: false`, and a bid sealed with
 * q = 0 or q > B matches its commitment but is not `revealable`.
 * `contract` and `path` name the sale; decryption itself needs only S.
 */
export function decryptBids({
  S,
  sale,
  bids,
}: {
  S: G1Point | string;
  contract: string;
  path: string;
  sale: bigint;
  bids: BidToDecrypt[];
}): DecryptedBid[] {
  let key: G1Point;
  try {
    key = typeof S === 'string' ? parseG1(S) : S;
  } catch (e) {
    return bids.map((b) => ({ idx: b.idx, ok: false, reason: `invalid key: ${(e as Error).message}`, revealable: false }));
  }
  return bids.map((b) => {
    let pt: Uint8Array;
    try {
      pt = decrypt(key, ctFromBase64(b.ct));
    } catch (e) {
      return { idx: b.idx, ok: false, reason: (e as Error).message, revealable: false };
    }
    const { p, q, salt } = decodePlaintext(pt);
    let cmOk = false;
    try {
      cmOk = commitmentHex({ sale, bidder: b.bidder, B: b.B, p, q, salt }) === b.cm.toLowerCase();
    } catch {
      cmOk = false;
    }
    return { idx: b.idx, ok: true, p, q, salt_hex: bytesToHex(salt), cmOk, revealable: cmOk && q >= 1n && q <= b.B };
  });
}
