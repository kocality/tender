import { describe, expect, test } from 'vitest';
import { BID_NONCE_MARGIN_NS, bidNonce, decodeVersionedNonce, toBase64 } from '@tender/intents';
import { buildBidPayload } from '../lib/bidPayload';
import { CLOSE_MARGIN_NS } from '../lib/bidFlow';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const T0 = 1_800_000_000_000;
const closeNs = BigInt(T0 + 3 * 3_600_000) * 1_000_000n;
const CM = 'aa'.repeat(32);
const base = { signerId: '0xabc', receiverId: 'v1.tenderseal.near', quoteToken: USDC, amount: 5_000_000n, sale: '7', ct: 'Q1Q=', cm: CM, saltHex: '252812b3', closeNs };

describe('one nonce per sealed bid (DOUBLE-PLAN step 2, rows 2 and 3)', () => {
  test('a second signature of the same sealed bid, 11 minutes later, carries the same nonce and another deadline', async () => {
    const a = await buildBidPayload({ ...base, nowMs: T0 });
    const b = await buildBidPayload({ ...base, nowMs: T0 + 11 * 60_000 });
    expect(b.nonce).toBe(a.nonce);
    expect(b.deadline).not.toBe(a.deadline);
  });
  test('the nonce is the shared bidNonce of (salt, close, contract, sale, signer, cm), which the CLI derives too', async () => {
    const p = await buildBidPayload({ ...base, nowMs: T0 });
    expect(p.nonce).toBe(toBase64(bidNonce({ saltHex: '252812b3', closeNs, contract: 'v1.tenderseal.near', sale: '7', signer: '0xabc', cm: CM })));
  });
  test('the payload deadline never passes the nonce deadline (close - 60 s), even near close', async () => {
    for (const now of [T0, T0 + 3 * 3_600_000 - 61_000, T0 + 3 * 3_600_000 - 600_500]) {
      const p = await buildBidPayload({ ...base, nowMs: now });
      expect(BigInt(Date.parse(p.deadline)) * 1_000_000n <= decodeVersionedNonce(p.nonce).deadlineNs).toBe(true);
    }
  });
  test('seq travels in the bid message; the nonce does not depend on it', async () => {
    const a = await buildBidPayload({ ...base, nowMs: T0, seq: 0 });
    const b = await buildBidPayload({ ...base, nowMs: T0, seq: 3 });
    expect(JSON.parse(a.intents[0]!.msg!)).toMatchObject({ seq: 0 });
    expect(JSON.parse(b.intents[0]!.msg!)).toMatchObject({ seq: 3 });
    expect(a.nonce).toBe(b.nonce);
    expect(JSON.parse((await buildBidPayload({ ...base, nowMs: T0 })).intents[0]!.msg!)).not.toHaveProperty('seq');
  });
  test('the nonce margin and the wizard close margin are the same 60 s', () => {
    expect(CLOSE_MARGIN_NS).toBe(BID_NONCE_MARGIN_NS);
  });
});
