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
    for (const bad of ['', ' ', 'abc', '1e6', '-1', '1,5', '1.2.3', '0x10']) expect(() => parseUnits(bad, 6)).toThrow();
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
