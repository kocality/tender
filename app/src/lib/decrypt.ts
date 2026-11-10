import { MPC_DOMAIN2_PK, appId, checkKey, decryptBids, keyFromCkd } from '@tender/seal';
import { config as appConfig } from '../config';
import type { Bid, Config, Sale } from './views';

// Everything here runs in the browser. Decrypted prices are shown on screen and never sent anywhere.

export type DecryptStatus = 'ok' | 'invalid_ct' | 'cm_mismatch';

export interface DecryptRow {
  idx: number;
  status: DecryptStatus;
  reason?: string;
  p?: bigint;
  q?: bigint;
  /** 32 hex characters, ready for a reveal item */
  salt?: string;
}

export interface DecryptResult {
  /** `false` blocks every reveal: the key is not the sale's key (or there is none). */
  keyOk: boolean;
  keyError?: string;
  rows: DecryptRow[];
}

const CHUNK = 4;
const tick = () => new Promise<void>((r) => setTimeout(r));

/**
 * Derives the sale key from the MPC response, checks it against the network key and the sale's app id, then decrypts
 * every bid and rechecks its commitment for the bidder who submitted it. Works in all three app-key modes
 * (identity: S = big_c; generator and plain: S = big_c - big_y). Yields to the event loop every 4 bids.
 */
export async function decryptSale(o: {
  config: Pick<Config, 'appPkMode' | 'mpcPublicKey'>;
  sale: Pick<Sale, 'id' | 'path' | 'key'>;
  bids: Pick<Bid, 'idx' | 'bidder' | 'escrow' | 'ct' | 'cm'>[];
  contractId: string;
  /** The MPC key the sale key is checked against. Defaults to the key pinned for this app's network, never the one from get_config(). */
  expectedMpk?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<DecryptResult> {
  const { config, sale, bids, contractId } = o;
  const mpk = o.expectedMpk ?? MPC_DOMAIN2_PK[appConfig.network];
  if (!sale.key) return { keyOk: false, keyError: 'No key has been released for this sale yet.', rows: [] };
  let S;
  try {
    if (config.mpcPublicKey !== mpk) return { keyOk: false, keyError: 'Key check failed: the contract reports an MPC public key that is not the pinned one.', rows: [] };
    S = keyFromCkd({ big_y: sale.key.bigY, big_c: sale.key.bigC }, config.appPkMode);
    if (!checkKey(S, mpk, appId(contractId, sale.path))) {
      return { keyOk: false, keyError: 'Key check failed: this key does not belong to this sale.', rows: [] };
    }
  } catch (e) {
    return { keyOk: false, keyError: `Key check failed: ${(e as Error).message}`, rows: [] };
  }

  const rows: DecryptRow[] = [];
  for (let i = 0; i < bids.length; i += CHUNK) {
    const part = bids.slice(i, i + CHUNK);
    const out = decryptBids({
      S,
      contract: contractId,
      path: sale.path,
      sale: BigInt(sale.id),
      bids: part.map((b) => ({ idx: b.idx, bidder: b.bidder, B: b.escrow, ct: b.ct, cm: b.cm })),
    });
    for (const r of out) {
      if (!r.ok) rows.push({ idx: r.idx, status: 'invalid_ct', reason: r.reason });
      else if (!r.cmOk) rows.push({ idx: r.idx, status: 'cm_mismatch', reason: 'copy of another bid or wrong signer', p: r.p, q: r.q, salt: r.salt_hex });
      else rows.push({ idx: r.idx, status: 'ok', p: r.p, q: r.q, salt: r.salt_hex });
    }
    o.onProgress?.(Math.min(i + CHUNK, bids.length), bids.length);
    await tick();
  }
  return { keyOk: true, rows };
}
