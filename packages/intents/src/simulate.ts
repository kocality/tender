import { ViewPanic, viewCall } from './rpc.js';
import type { IntentsErrorKind, MultiPayload } from './types.js';

// Panic texts of intents.near 0.4.5 (near/intents @16d04f6e core/src/error.rs).
const KINDS: [string, IntentsErrorKind][] = [
  ['insufficient balance or overflow', 'insufficient_balance'],
  ['invalid signature', 'invalid_signature'],
  ["doesn't exist for account", 'public_key_not_registered'],
  ['deadline has expired', 'deadline_expired'],
  ['deadline is greater than nonce', 'deadline_gt_nonce'],
  ['nonce was already used', 'nonce_used'],
  ['nonce was already expired', 'nonce_expired'],
  ['invalid nonce', 'invalid_nonce'],
  ['invalid salt', 'invalid_salt'],
  ['wrong verifying_contract', 'wrong_verifying_contract'],
];

export function classifyIntentsError(msg: string): IntentsErrorKind {
  for (const [text, kind] of KINDS) if (msg.includes(text)) return kind;
  return 'other';
}

/** Free dry run of `execute_intents` via the `simulate_intents` view. Network failures throw. */
export async function simulateIntents(
  rpc: string[],
  intentsId: string,
  signed: MultiPayload[],
): Promise<{ ok: true; report: unknown } | { ok: false; kind: IntentsErrorKind; message: string }> {
  try {
    const report = await viewCall<unknown>(rpc, intentsId, 'simulate_intents', { signed });
    return { ok: true, report };
  } catch (e) {
    if (e instanceof ViewPanic) return { ok: false, kind: classifyIntentsError(e.panicMsg), message: e.panicMsg };
    throw e;
  }
}
