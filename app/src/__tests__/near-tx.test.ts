import { describe, expect, test, vi } from 'vitest';
import { cancelSale, finalizeSale, openSale, outcomeFailure, revealBatch, txHashOf } from '../lib/near-tx';

const call = vi.hoisted(() => vi.fn());
vi.mock('../wallets/near', () => ({ callFunction: call }));

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

describe('open, cancel, finalize and reveal reject a Failure outcome (X12-01 tabs)', () => {
  const failed = { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: reveal: bid 0 is not sealed' } } } } }, transaction: { hash: 'H2' } };
  test.each([
    ['openSale', () => openSale('1')],
    ['cancelSale', () => cancelSale('1')],
    ['finalizeSale', () => finalizeSale('1')],
    ['revealBatch', () => revealBatch('1', [])],
  ])('%s throws with the panic text instead of returning a hash', async (_name, run) => {
    call.mockResolvedValueOnce(failed);
    await expect(run()).rejects.toThrow('bid 0 is not sealed');
    call.mockResolvedValueOnce({ status: { SuccessValue: '' }, transaction: { hash: 'H1' } });
    expect(await run()).toBe('H1');
  });
});
