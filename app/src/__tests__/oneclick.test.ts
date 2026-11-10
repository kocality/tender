/// <reference types="node" />
import { describe, expect, test } from 'vitest';
import { ORIGIN_ASSET, TERMINAL, depositAmountFor, depositQuoteBody, isTerminal, quoteDeposit } from '../lib/oneclick';

const QUOTE_TOKEN = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

describe('depositAmountFor', () => {
  test('gap + 1 %, rounded up to 0.01 USDC, + 0.05 USDC', () => {
    expect(depositAmountFor(5_000_000n)).toBe(5_100_000n);
    expect(depositAmountFor(3_000_000n)).toBe(3_080_000n);
    expect(depositAmountFor(1_000_000n)).toBe(1_060_000n);
    expect(depositAmountFor(2_000_000n)).toBe(2_070_000n);
    expect(depositAmountFor(3_123_456n)).toBe(3_210_000n);
  });
  test('always covers the gap', () => {
    for (const gap of [1n, 999_999n, 1_000_001n, 7_654_321n]) expect(depositAmountFor(gap)).toBeGreaterThan(gap);
  });
});

describe('quote body', () => {
  const body = depositQuoteBody({
    origin: 'arb',
    amount: 3_080_000n,
    quoteToken: QUOTE_TOKEN,
    refundTo: '0xabc',
    recipient: '0xdef',
    dry: false,
    nowMs: Date.UTC(2026, 10, 13, 0, 0, 0),
  });
  test('has the required fields and no confidentiality', () => {
    expect(body).not.toHaveProperty('confidentiality');
    expect(body.recipientType).toBe('INTENTS');
    expect(body.depositType).toBe('ORIGIN_CHAIN');
    expect(body.swapType).toBe('EXACT_INPUT');
    expect(body.originAsset).toBe(ORIGIN_ASSET.arb);
    expect(body.destinationAsset).toBe(QUOTE_TOKEN);
    expect(body.amount).toBe('3080000');
    expect(body.refundType).toBe('ORIGIN_CHAIN');
  });
  test('deadline is an ISO time 30 minutes ahead', () => {
    expect(body.deadline).toBe('2026-11-13T00:30:00.000Z');
  });
});

test('terminal statuses', () => {
  expect(TERMINAL).toContain('SUCCESS');
  expect(isTerminal('PENDING_DEPOSIT')).toBe(false);
  expect(isTerminal('REFUNDED')).toBe(true);
});

// Free dry quote against the real 1Click API: the buffer must cover the escrow after the swap fee and slippage.
describe.skipIf(!process.env.LIVE)('live 1Click dry quote', () => {
  test('Arbitrum USDC for an escrow of 3 USDC: minAmountOut covers it', async () => {
    const amount = depositAmountFor(3_000_000n);
    const q = await quoteDeposit({
      origin: 'arb',
      amount,
      quoteToken: QUOTE_TOKEN,
      refundTo: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
      recipient: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
      dry: true,
    });
    expect(BigInt(q.quote.minAmountOut)).toBeGreaterThanOrEqual(3_000_000n);
  }, 30_000);
});
