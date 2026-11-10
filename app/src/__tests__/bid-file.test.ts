import { describe, expect, test } from 'vitest';
import { fromHex } from '@tender/intents';
import { commitmentHex } from '@tender/seal';
import { itemsFromBidFiles } from '../lib/bidFile';

// "Reveal from my bid file" (X12-02 storage): the file `pnpm seal:bid` saved, checked against the bid the contract holds.

const target = { saleId: '1', contract: 'v1.tenderseal.near', network: 'mainnet' } as const;
const salt = '0123456789abcdef0123456789abcdef';
const cmFor = (bidder: string, B: bigint, p: bigint, q: bigint, s = salt) => commitmentHex({ sale: 1n, bidder, B, p, q, salt: fromHex(s) });
const onChain = (idx: number, bidder: string, escrow: bigint, p: bigint, q: bigint, state: 'Sealed' | 'Revealed' = 'Sealed') => ({ idx, bidder, escrow, state, cm: cmFor(bidder, escrow, p, q) });
const file = (o: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({ sale: '1', contract: 'v1.tenderseal.near', network: 'mainnet', signer: '0xaaa', cm: cmFor('0xaaa', 5_000_000n, 3_600_000n, 3_000_000n), escrow: '5000000', origin: null, p: '3600000', q: '3000000', salt, ...o });

describe('itemsFromBidFiles', () => {
  const bids = [onChain(0, '0xbbb', 2_000_000n, 1n, 1n), onChain(1, '0xaaa', 5_000_000n, 3_600_000n, 3_000_000n)];

  test('a file whose commitment opens a Sealed bid becomes a reveal item for that bid', () => {
    const r = itemsFromBidFiles([file()], bids, target);
    expect(r.notes).toEqual([]);
    expect(r.items).toEqual([{ idx: 1, p: '3600000', q: '3000000', salt, bidder: '0xaaa' }]);
  });

  test('the commitment is recomputed with the bidder and escrow on chain: a file that lies about p, q or salt is refused', () => {
    for (const lie of [{ p: '3600001' }, { q: '2999999' }, { salt: 'ff'.repeat(16) }]) {
      const r = itemsFromBidFiles([file(lie)], bids, target);
      expect(r.items, JSON.stringify(lie)).toEqual([]);
      expect(r.notes[0]).toContain('do not open bid #1');
    }
  });

  test('another bidder or another escrow on chain under the same cm is refused (the file is not trusted for them)', () => {
    const swapped = [{ ...bids[1]!, bidder: '0xccc' }];
    expect(itemsFromBidFiles([file()], swapped, target).notes[0]).toContain('do not open bid #1');
    expect(itemsFromBidFiles([file()], [{ ...bids[1]!, escrow: 5_000_001n }], target).items).toEqual([]);
  });

  test('wrong sale, contract or network, unknown commitment, already revealed, size outside 1..escrow, malformed and duplicate files each give a note and no item', () => {
    const bigQ = onChain(2, '0xaaa', 1_000_000n, 3_600_000n, 2_000_000n);
    const zeroQ = onChain(3, '0xaaa', 1_000_000n, 3_600_000n, 0n);
    const cases: [string, string, Parameters<typeof itemsFromBidFiles>[1]][] = [
      [file({ sale: '2' }), 'is for sale 2', bids],
      [file({ contract: 'v1.tender-09bdfe.testnet' }), 'v1.tender-09bdfe.testnet', bids],
      [file({ network: 'testnet' }), 'on testnet', bids],
      [file({ cm: 'aa'.repeat(32) }), 'matches no bid', bids],
      [file(), 'already Revealed', [onChain(1, '0xaaa', 5_000_000n, 3_600_000n, 3_000_000n, 'Revealed')]],
      [file({ q: '2000000', cm: bigQ.cm }), 'outside 1..escrow', [bigQ]],
      [file({ q: '0', cm: zeroQ.cm }), 'outside 1..escrow', [zeroQ]],
      [file({ p: '-1' }), 'malformed', bids],
      [file({ salt: 'xyz' }), 'malformed', bids],
      ['not json', 'not a bid file', bids],
      ['[1,2]', 'not a bid file', bids],
    ];
    for (const [text, note, onchain] of cases) {
      const r = itemsFromBidFiles([text], onchain, target);
      expect(r.items, note).toEqual([]);
      expect(r.notes.join(' '), note).toContain(note);
    }
    const twice = itemsFromBidFiles([file(), file()], bids, target);
    expect(twice.items.length).toBe(1);
    expect(twice.notes[0]).toContain('already listed');
  });

  test('several files give several items, in file order', () => {
    const second = file({ signer: '0xbbb', cm: bids[0]!.cm, p: '1', q: '1', escrow: '2000000' });
    const r = itemsFromBidFiles([file(), second], bids, target);
    expect(r.items.map((i) => i.idx)).toEqual([1, 0]);
  });
});
