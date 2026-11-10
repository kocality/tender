import type { DefusePayload, MultiPayload } from '@tender/intents';
import { humanError } from '../lib/errors';

export type Origin = 'base' | 'arb' | 'sol' | 'near';

/** A connected wallet that can sign one Intents payload. The payload's `signer_id` must already equal `signerId`. */
export interface IntentSigner {
  kind: 'evm' | 'phantom' | 'near';
  signerId: string;
  origin: Origin;
  publicKey?: string;
  sign(p: DefusePayload): Promise<MultiPayload>;
}

/** Wallet failures shown to the user as-is (rejected prompt, missing extension, ...). */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Wallet libraries throw strings, `{code, message}` objects or Errors; one sentence for the user (a rejected prompt is not an error). */
export function walletErrorMessage(e: unknown): string {
  return humanError(e);
}
