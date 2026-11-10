import { describe, expect, test } from 'vitest';
import { TRUST_LINE, originBadge } from '../copy';

describe('originBadge (X12-03 unicode)', () => {
  test('declared origins get their chain name', () => {
    expect(originBadge('base')).toBe('via Base (self-declared)');
    expect(originBadge('near')).toBe('via NEAR (self-declared)');
  });
  test.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty', '', 'BASE'])('%j is not declared', (origin) => {
    expect(originBadge(origin)).toBe('origin not declared');
  });
  test('no origin is not declared', () => {
    expect(originBadge(null)).toBe('origin not declared');
    expect(originBadge(undefined)).toBe('origin not declared');
  });
});

describe('TRUST_LINE', () => {
  test('names the resharing caveat next to the threshold (CRYPTO-04)', () => {
    expect(TRUST_LINE).toContain('11 of 16 nodes on 2026-11-10');
    expect(TRUST_LINE).toContain('Resharing does not revoke old shares');
    expect(TRUST_LINE).toContain('hold or ever held a share of the domain-2 key');
  });
});
