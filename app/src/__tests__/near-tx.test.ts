import { describe, expect, test } from 'vitest';
import { outcomeFailure, txHashOf } from '../lib/near-tx';

describe('a failed transaction is not "submitted" (QA-19)', () => {
  const ok = { status: { SuccessValue: '' }, transaction: { hash: 'H1' } };
  const failed = { status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: x' } } } } }, transaction: { hash: 'H2' } };
  test('a Failure status is reported', () => {
    expect(outcomeFailure(failed)).toContain('panicked');
    expect(outcomeFailure(ok)).toBeNull();
  });
  test('wallets that return no outcome object are not treated as failures', () => {
    expect(outcomeFailure(undefined)).toBeNull();
    expect(outcomeFailure({ txHash: 'H3' })).toBeNull();
    expect(txHashOf({ txHash: 'H3' })).toBe('H3');
  });
});
