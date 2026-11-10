import { sha256 } from '@noble/hashes/sha2.js';
import { b58encode, fromBase64, utf8 } from './encoding.js';
import { erc191Prehash } from './erc191.js';
import { nep413Prehash } from './nep413.js';
import type { MultiPayload } from './types.js';

/** Intent hash as intents.near computes it (MultiPayload::hash), base58. */
export function intentHash(mp: MultiPayload): string {
  switch (mp.standard) {
    case 'erc191':
      return b58encode(erc191Prehash(mp.payload));
    case 'raw_ed25519':
      return b58encode(sha256(utf8(mp.payload)));
    case 'nep413':
      return b58encode(
        nep413Prehash({
          message: mp.payload.message,
          nonce32: fromBase64(mp.payload.nonce),
          recipient: mp.payload.recipient,
          callbackUrl: mp.payload.callbackUrl,
        }),
      );
  }
}
