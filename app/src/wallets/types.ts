import type { DefusePayload, MultiPayload } from '@tender/intents';

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

/** Wallet libraries throw strings, `{code, message}` objects or Errors; keep the readable part. */
export function walletErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return 'wallet request failed';
}
