import { MPC_DOMAIN2_PK, sealBid } from '@tender/seal';
import { config } from '../config';

// The only module that touches a bid's price. p, q and the salt stay in memory: never logged, sent or stored.
// The salt is also inside the ciphertext, so decryption recovers it once the sale key is out: nobody has to keep it.

export interface SealedForSale {
  /** base64 of the 160-byte ciphertext */
  ct: string;
  /** 64 lowercase hex */
  cm: string;
  /** 16-byte salt, already inside `ct` (decryption recovers it): it is not shown, stored or needed again. */
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

/**
 * The MPC key a bid is sealed to must be the one this repo pins for the network. A key read from `get_config()` over an
 * untrusted RPC, or from a mis-set contract id, could belong to someone who then reads every bid before close.
 */
export function assertPinnedMpk(mpk: string, network: 'mainnet' | 'testnet' = config.network): void {
  if (mpk !== MPC_DOMAIN2_PK[network]) {
    throw new Error(`The contract reports an MPC public key that is not the pinned ${network} key. Refusing to seal; check the contract id and RPC.`);
  }
}

/** `sealForSale` for the key `get_config()` returned, after the pinned-key check. */
export function sealWithConfig(o: Parameters<typeof sealForSale>[0], network: 'mainnet' | 'testnet' = config.network): SealedForSale {
  assertPinnedMpk(o.mpk, network);
  return sealForSale(o);
}
