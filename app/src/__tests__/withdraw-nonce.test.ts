import { describe, expect, test } from 'vitest';
import { decodeVersionedNonce } from '@tender/intents';
import { buildWithdrawPayload, withdrawVerdict } from '../lib/withdrawFlow';

// DOUBLE-PLAN step 7, row 22: a withdrawal's nonce belongs to its 1Click quote, so a second signature of the same quote repeats it
// and intents.near refuses the second transfer to a deposit address that is already filled.
const T0 = 1_800_000_000_000;
const quoteDeadlineMs = T0 + 30 * 60_000;
const base = { signerId: '0xabc', depositAddress: 'dep-1', tokenId: 'nep141:x', amountIn: 5_000_000n, saltHex: '252812b3', quoteDeadlineMs };

describe('the withdraw nonce is tied to the quote', () => {
  test('a quote re-signed 12 minutes later keeps its nonce and gets another payload deadline', async () => {
    const a = await buildWithdrawPayload({ ...base, nowMs: T0 });
    const b = await buildWithdrawPayload({ ...base, nowMs: T0 + 12 * 60_000 });
    expect(b.nonce).toBe(a.nonce);
    expect(b.deadline).not.toBe(a.deadline);
  });
  test('another deposit address, amount, token or signer is another nonce', async () => {
    const a = await buildWithdrawPayload({ ...base, nowMs: T0 });
    for (const d of [{ depositAddress: 'dep-2' }, { amountIn: 5_000_001n }, { tokenId: 'nep141:y' }, { signerId: '0xdef' }]) {
      expect((await buildWithdrawPayload({ ...base, ...d, nowMs: T0 })).nonce).not.toBe(a.nonce);
    }
  });
  test('the payload never outlives the quote nor its own nonce', async () => {
    const p = await buildWithdrawPayload({ ...base, nowMs: quoteDeadlineMs - 120_000 });
    expect(Date.parse(p.deadline)).toBeLessThanOrEqual(quoteDeadlineMs);
    expect(BigInt(Date.parse(p.deadline)) * 1_000_000n <= decodeVersionedNonce(p.nonce).deadlineNs).toBe(true);
  });
  test('a quote that has expired is not signed', async () => {
    await expect(buildWithdrawPayload({ ...base, nowMs: quoteDeadlineMs + 1000 })).rejects.toThrow(/expired/);
  });
  test('a quote without a deadline keeps the random nonce of before (nothing to tie it to)', async () => {
    const { quoteDeadlineMs: _drop, ...noDeadline } = base;
    const a = await buildWithdrawPayload({ ...noDeadline, nowMs: T0 });
    const b = await buildWithdrawPayload({ ...noDeadline, nowMs: T0 });
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('withdrawVerdict: what the chain says about a signed withdrawal', () => {
  const deadlineMs = T0 + 600_000;
  test('nonce used: it ran, follow 1Click', () => expect(withdrawVerdict({ used: true, nowMs: T0, deadlineMs })).toEqual({ kind: 'ran' }));
  test('not used before the deadline: it may still land', () => expect(withdrawVerdict({ used: false, nowMs: T0, deadlineMs })).toEqual({ kind: 'pending', untilMs: deadlineMs }));
  test('not used after the deadline: it can never run, a new quote is safe', () => expect(withdrawVerdict({ used: false, nowMs: deadlineMs + 1, deadlineMs })).toEqual({ kind: 'dead' }));
  test('a failed read proves nothing', () => expect(withdrawVerdict({ used: null, nowMs: T0, deadlineMs })).toEqual({ kind: 'unknown' }));
});
