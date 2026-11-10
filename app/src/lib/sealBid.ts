import { sealBid } from '@tender/seal';

// The only module that touches a bid's price. p, q and the salt stay in memory: never logged, sent or stored.

export interface SealedForSale {
  /** base64 of the 160-byte ciphertext */
  ct: string;
  /** 64 lowercase hex */
  cm: string;
  /** 16-byte salt; only the user may keep it. The reveal needs it. */
  salt: Uint8Array;
}

export function sealForSale(o: {
  contractId: string;
  sale: bigint;
  mpk: string;
  path: string;
  bidder: string;
  B: bigint;
  p: bigint;
  q: bigint;
}): SealedForSale {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const sealed = sealBid({ mpk: o.mpk, contract: o.contractId, path: o.path, sale: o.sale, bidder: o.bidder, B: o.B, p: o.p, q: o.q, salt });
  return { ct: sealed.ct_b64, cm: sealed.cm_hex, salt };
}
