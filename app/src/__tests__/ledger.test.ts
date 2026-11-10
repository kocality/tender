import { afterEach, describe, expect, test, vi } from 'vitest';
import receiptsFixture from '../__fixtures__/views/nearblocks-receipts.json';
import keyLogFixture from '../__fixtures__/views/key-log.json';
import { fetchNearblocksReceipts, matchLedger, parseReceipts, receiptCheck, type Receipt } from '../lib/ledger';
import { parseKeyReq } from '../lib/views';

const entry = parseKeyReq(keyLogFixture[0]); // key request recorded at block 1500
const receiptAt = (height: number, id = `r${height}`): Receipt => ({
  receiptId: id,
  txHash: `tx${height}`,
  blockHeight: BigInt(height),
  predecessor: 'v1.tenderseal.near',
  receiver: 'v1.signer',
});

afterEach(() => vi.unstubAllGlobals());

describe('matchLedger', () => {
  test.each([1500, 1501, 1503])('receipt at block %i matches an entry at 1500', (h) => {
    const rows = matchLedger([entry], [receiptAt(h)]);
    expect(rows[0]?.receipt?.blockHeight).toBe(BigInt(h));
  });

  test.each([1499, 1504])('receipt at block %i does not match', (h) => {
    expect(matchLedger([entry], [receiptAt(h)])[0]?.receipt).toBeNull();
  });

  test('a receipt is used for one entry only', () => {
    const second = { ...entry, i: 1n, block: 1501n };
    const rows = matchLedger([entry, second], [receiptAt(1501)]);
    expect(rows.map((r) => r.receipt !== null)).toEqual([true, false]);
  });

  test('NearBlocks unavailable: entries stay, no receipts, check is "unavailable"', () => {
    const rows = matchLedger([entry], null);
    expect(rows).toEqual([{ entry, receipt: null }]);
    expect(receiptCheck(rows, null)).toBe('unavailable');
  });

  test('match / mismatch', () => {
    const ok = [receiptAt(1501)];
    expect(receiptCheck(matchLedger([entry], ok), ok)).toBe('match');
    const extra = [receiptAt(1501), receiptAt(1700)];
    expect(receiptCheck(matchLedger([entry], extra), extra)).toBe('mismatch');
    expect(receiptCheck(matchLedger([entry], []), [])).toBe('mismatch');
  });
});

describe('fetchNearblocksReceipts', () => {
  test('one request with the method filter, parsed', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(receiptsFixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const receipts = await fetchNearblocksReceipts('v1.tenderseal.near');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/accounts/v1.tenderseal.near/receipts?method=request_app_private_key&limit=100');
    expect(receipts?.[0]?.blockHeight).toBe(1501n);
  });

  test('receipts from strangers or to another receiver are not ledger receipts (X12-01)', async () => {
    const row = (id: string, height: number, predecessor: string, receiver: string) => ({
      receipt_id: id,
      transaction_hash: `tx${id}`,
      predecessor_account_id: predecessor,
      receiver_account_id: receiver,
      block: { block_height: height },
    });
    const body = {
      data: [
        row('spam', 1501, 'mallory.near', 'v1.tenderseal.near'), // incoming call on the contract
        row('spoof', 1500, 'mallory.near', 'v1.signer'), // a stranger's call on the MPC contract
        row('other', 1502, 'v1.tenderseal.near', 'burner.near'),
        row('real', 1503, 'v1.tenderseal.near', 'v1.signer'),
      ],
    };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }));
    const receipts = await fetchNearblocksReceipts('v1.tenderseal.near');
    expect(receipts?.map((r) => r.receiptId)).toEqual(['real']);
    const rows = matchLedger([entry], receipts);
    expect(rows[0]?.receipt?.receiptId).toBe('real');
    expect(receiptCheck(rows, receipts)).toBe('match');
  });

  test('rate limit (429) returns null', async () => {
    vi.stubGlobal('fetch', async () => new Response('slow down', { status: 429 }));
    expect(await fetchNearblocksReceipts('v1.tenderseal.near')).toBeNull();
  });

  test('network failure and unexpected body return null', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await fetchNearblocksReceipts('v1.tenderseal.near')).toBeNull();
    expect(parseReceipts({ nope: true })).toBeNull();
  });
});
