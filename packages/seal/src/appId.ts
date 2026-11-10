import { sha3_256 } from '@noble/hashes/sha3.js';
import { APP_ID_PREFIX } from './constants.js';

/**
 * MPC app_id for a CKD request. `account` is the predecessor that calls the MPC:
 * the contract for sales, an EOA for spikes (a key derived for the wrong account does not open the sale).
 */
export function appId(account: string, path: string): Uint8Array {
  return sha3_256(new TextEncoder().encode(`${APP_ID_PREFIX}${account},${path}`));
}
