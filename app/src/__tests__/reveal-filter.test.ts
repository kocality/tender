import { describe, expect, test } from 'vitest';
import type { DecryptResult } from '../lib/decrypt';
import { batches, revealWindowOpen, revealable, unrevealable } from '../lib/revealFilter';

const row = (idx: number, status: 'ok' | 'invalid_ct' | 'cm_mismatch') => ({ idx, status, p: 3_000_000n, q: 1_000_000n, salt: '11'.repeat(16) });
const bid = (idx: number, state: 'Sealed' | 'Revealed' | 'Penalized' = 'Sealed') => ({ idx, state, bidder: `b${idx}` });

describe('revealable', () => {
  test('invalid_ct, cm_mismatch and already Revealed bids never enter a batch', () => {
    const decrypted: DecryptResult = { keyOk: true, rows: [row(0, 'ok'), row(1, 'invalid_ct'), row(2, 'cm_mismatch'), row(3, 'ok'), row(4, 'ok')] };
    const bids = [bid(0), bid(1), bid(2), bid(3, 'Revealed'), bid(4)];
    expect(revealable(decrypted, bids).map((i) => i.idx)).toEqual([0, 4]);
    expect(unrevealable(decrypted, bids)).toEqual([1, 2]);
  });
  test('items carry decimal strings and the 32 hex salt', () => {
    const [item] = revealable({ keyOk: true, rows: [row(0, 'ok')] }, [bid(0)]);
    expect(item).toMatchObject({ idx: 0, p: '3000000', q: '1000000', salt: '11'.repeat(16) });
  });
  test('a failed key check reveals nothing', () => {
    expect(revealable({ keyOk: false, rows: [row(0, 'ok')] }, [bid(0)])).toEqual([]);
    expect(revealable(null, [bid(0)])).toEqual([]);
  });
  test('17 valid bids go out as 8 + 8 + 1', () => {
    const idxs = Array.from({ length: 17 }, (_, i) => i);
    const items = revealable({ keyOk: true, rows: idxs.map((i) => row(i, 'ok')) }, idxs.map((i) => bid(i)));
    expect(batches(items).map((b) => b.length)).toEqual([8, 8, 1]);
  });
});

describe('revealWindowOpen', () => {
  const sale = { state: 'Keyed' as const, revealDeadlineNs: 1_000n };
  test('open only while Keyed and before the deadline, on chain time', () => {
    expect(revealWindowOpen(sale, 999n)).toBe(true);
    expect(revealWindowOpen(sale, 1_000n)).toBe(false);
    expect(revealWindowOpen({ ...sale, state: 'Finalized' }, 1n)).toBe(false);
    expect(revealWindowOpen({ ...sale, revealDeadlineNs: null }, 1n)).toBe(false);
  });
});
