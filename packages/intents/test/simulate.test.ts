import { afterEach, describe, expect, test, vi } from 'vitest';
import { classifyIntentsError, simulateIntents, type IntentsErrorKind } from '../src/index.js';

const CASES: [string, IntentsErrorKind][] = [
  ['insufficient balance or overflow', 'insufficient_balance'],
  ['invalid signature', 'invalid_signature'],
  ['deadline has expired', 'deadline_expired'],
  ['deadline is greater than nonce', 'deadline_gt_nonce'],
  ['nonce was already used', 'nonce_used'],
  ['nonce was already expired', 'nonce_expired'],
  ['invalid nonce', 'invalid_nonce'],
  ['invalid salt', 'invalid_salt'],
  ['wrong verifying_contract', 'wrong_verifying_contract'],
  ["public key 'ed25519:8rVvtHWFr8hasdQGGD5WiQBTyr4iH2ruEPPVfj491RPN' doesn't exist for account 'bidder.tenderseal.near'", 'public_key_not_registered'],
  ['invalid intent', 'other'],
];

afterEach(() => vi.unstubAllGlobals());

describe('simulate', () => {
  test.each(CASES)('classifies %s', (msg, kind) => {
    expect(classifyIntentsError(msg)).toBe(kind);
  });

  test('simulate_parses_rpc_panic', async () => {
    const panic = "public key 'ed25519:abc' doesn't exist for account 'bidder.tenderseal.near'";
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          jsonrpc: '2.0',
          id: 'tender',
          result: { error: `wasm execution failed with error: HostError(GuestPanic { panic_msg: "${panic}" })`, logs: [] },
        }),
      ),
    );
    const r = await simulateIntents(['http://rpc.invalid'], 'intents.near', []);
    expect(r).toEqual({ ok: false, kind: 'public_key_not_registered', message: panic });
    expect(fetch).toHaveBeenCalledTimes(1); // panics are not retried
  });

  test('simulate_ok_returns_report', async () => {
    const report = { intents_executed: [], logs: [] };
    const bytes = Array.from(new TextEncoder().encode(JSON.stringify(report)));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 'tender', result: { result: bytes, logs: [] } })));
    expect(await simulateIntents(['http://rpc.invalid'], 'intents.near', [])).toEqual({ ok: true, report });
  });
});
