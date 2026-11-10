import { describe, expect, test, vi } from 'vitest';
import type { DecryptResult } from '../lib/decrypt';
import { batches, revealWindowOpen, revealable, sendRevealBatches, unrevealable } from '../lib/revealFilter';

const row = (idx: number, status: 'ok' | 'invalid_ct' | 'cm_mismatch') => ({ idx, status, p: 3_000_000n, q: 1_000_000n, salt: '11'.repeat(16) });
const bid = (idx: number, state: 'Sealed' | 'Revealed' | 'Penalized' = 'Sealed', escrow = 3_000_000n) => ({ idx, state, bidder: `b${idx}`, escrow });

describe('revealable', () => {
  test('invalid_ct, cm_mismatch and already Revealed bids never enter a batch', () => {
    const decrypted: DecryptResult = { keyOk: true, rows: [row(0, 'ok'), row(1, 'invalid_ct'), row(2, 'cm_mismatch'), row(3, 'ok'), row(4, 'ok')] };
    const bids = [bid(0), bid(1), bid(2), bid(3, 'Revealed'), bid(4)];
    expect(revealable(decrypted, bids).map((i) => i.idx)).toEqual([0, 4]);
    expect(unrevealable(decrypted, bids)).toEqual([1, 2]);
  });
  test('q = 0 or q above the escrow never enters a batch (CRYPTO-03, S-02)', () => {
    const rows = [row(0, 'ok'), { ...row(1, 'ok'), q: 0n }, { ...row(2, 'ok'), q: 3_000_001n }, { ...row(3, 'ok'), q: 3_000_000n }, { ...row(4, 'ok'), q: 1n }];
    const bids = [0, 1, 2, 3, 4].map((i) => bid(i));
    expect(revealable({ keyOk: true, rows }, bids).map((i) => i.idx)).toEqual([0, 3, 4]);
    expect(unrevealable({ keyOk: true, rows }, bids)).toEqual([1, 2]);
    // the escrow on chain decides, not the row: the same q is fine with a bigger escrow
    expect(revealable({ keyOk: true, rows: [row(0, 'ok')] }, [bid(0, 'Sealed', 999_999n)])).toEqual([]);
    expect(revealable({ keyOk: true, rows: [row(0, 'ok')] }, [bid(0, 'Sealed', 1_000_000n)]).map((i) => i.idx)).toEqual([0]);
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

describe('sendRevealBatches (X12-01 tabs)', () => {
  const item = (idx: number) => ({ idx, p: '3000000', q: '1000000', salt: '11'.repeat(16) });
  const idxs = Array.from({ length: 12 }, (_, i) => i);
  const groups = batches(idxs.map(item)); // 8 + 4
  const state = (revealed: number[]) => idxs.map((idx) => ({ idx, state: revealed.includes(idx) ? ('Revealed' as const) : ('Sealed' as const) }));

  test('bids revealed elsewhere while batch 1 waited for the wallet are left out of batch 2, and a batch with nothing left is skipped', async () => {
    const sent: number[][] = [];
    const skipped: number[] = [];
    let reads = 0;
    await sendRevealBatches({
      saleId: '1',
      groups,
      load: async () => (++reads === 1 ? state([]) : state([8, 9])), // the keeper revealed 8 and 9 during batch 1
      send: async (_id, items) => {
        sent.push(items.map((i) => i.idx));
        return `H${sent.length}`;
      },
      onSkipped: (i) => skipped.push(i),
    });
    expect(sent).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [10, 11]]);
    expect(skipped).toEqual([]);

    const sent2: number[][] = [];
    await sendRevealBatches({
      saleId: '1',
      groups,
      load: async () => state([8, 9, 10, 11]),
      send: async (_id, items) => (sent2.push(items.map((i) => i.idx)), null),
      onSkipped: (i) => skipped.push(i),
    });
    expect(sent2).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    expect(skipped).toEqual([1]);
  });

  test('a failed read or send stops the loop; nothing is sent blind', async () => {
    const send = vi.fn(async () => 'H');
    await expect(sendRevealBatches({ saleId: '1', groups, load: async () => Promise.reject(new Error('rpc down')), send })).rejects.toThrow('rpc down');
    expect(send).not.toHaveBeenCalled();
    const failing = vi.fn(async () => Promise.reject(new Error('The transaction failed on chain: panicked')));
    await expect(sendRevealBatches({ saleId: '1', groups, load: async () => state([]), send: failing })).rejects.toThrow('failed on chain');
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
