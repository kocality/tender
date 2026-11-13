import { describe, expect, test } from 'vitest';
import { parseUnits, priceToP, priceUnitLabel } from '../lib/amounts';

describe('parseUnits', () => {
  test('exact decimal text, no floats', () => {
    expect(parseUnits('3.6', 6)).toBe(3_600_000n);
    expect(parseUnits('1', 6)).toBe(1_000_000n);
    expect(parseUnits('.5', 6)).toBe(500_000n);
    expect(parseUnits('0.000001', 6)).toBe(1n);
    expect(parseUnits('3.', 6)).toBe(3_000_000n);
  });
  test('more fraction digits than the token has is an error, never rounded', () => {
    expect(() => parseUnits('0.0000001', 6)).toThrow();
  });
  test('rejects text that is not a plain decimal', () => {
    for (const bad of ['', ' ', 'abc', '1e6', '-1', '1.2.3', '0x10', ',']) expect(() => parseUnits(bad, 6)).toThrow();
  });
});

describe('parseUnits with a decimal comma (QA-05)', () => {
  test('a single comma and no dot is the decimal point', () => {
    expect(parseUnits('3,6', 6)).toBe(3_600_000n);
    expect(parseUnits('0,174', 6)).toBe(174_000n);
    expect(parseUnits(',5', 6)).toBe(500_000n);
    expect(parseUnits(' 12,25 ', 6)).toBe(12_250_000n);
  });
  test('mixed separators and repeated commas stay errors', () => {
    expect(() => parseUnits('1.234,5', 6)).toThrow();
    expect(() => parseUnits('1,234.5', 6)).toThrow();
    expect(() => parseUnits('1,2,3', 6)).toThrow();
  });
  test('a comma that may be a thousands separator is refused, not read as 1.000', () => {
    expect(() => parseUnits('1,000', 6)).toThrow(/dot/);
    expect(() => parseUnits('10,500', 6)).toThrow(/dot/);
  });
  test('every amount path takes it: price, and the whole bid form', () => {
    expect(priceToP('3,60', 0)).toBe(3_600_000n);
  });
});

describe('priceToP', () => {
  test('micro-USDC per lot', () => {
    expect(priceToP('0.174', 3)).toBe(174_000n);
    expect(priceToP('3.60', 0)).toBe(3_600_000n);
  });
  test('zero and absurdly large prices are errors', () => {
    expect(() => priceToP('0', 0)).toThrow();
    expect(() => priceToP('99999999999999999999', 0)).toThrow();
  });
  test('label names the lot', () => {
    expect(priceUnitLabel('JAMBO', 3)).toBe('USDC per 1,000 JAMBO');
    expect(priceUnitLabel('wrap.near', 0)).toBe('USDC per wrap.near');
  });
});

describe('formatRounded (display at size; the exact value sits in a title)', () => {
  test('half up to two places, never more places than the token has', async () => {
    const { formatRounded } = await import('../lib/format');
    expect(formatRounded(1_800_001n, 6)).toBe('1.80');
    expect(formatRounded(2_199_999n, 6)).toBe('2.20');
    expect(formatRounded(277_777_777_777_777_777_777_777n, 24, 4)).toBe('0.2778');
    expect(formatRounded(5n, 1)).toBe('0.5');
  });
});
