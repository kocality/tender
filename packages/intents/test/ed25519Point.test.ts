import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, test } from 'vitest';
import { b58decode, isEd25519Point } from '../src/index.js';

const noble = (b: Uint8Array): boolean => {
  try {
    ed25519.Point.fromBytes(b, true); // zip215: the edge encodings Solana's own is_on_curve accepts
    return true;
  } catch {
    return false;
  }
};

describe('isEd25519Point (X12A-04: Solana wallets are on the curve, PDAs are not)', () => {
  test('agrees with noble (zip215) on 3000 random 32-byte strings, both outcomes occur', () => {
    let on = 0;
    for (let i = 0; i < 3000; i++) {
      const b = crypto.getRandomValues(new Uint8Array(32));
      expect(isEd25519Point(b)).toBe(noble(b));
      if (noble(b)) on++;
    }
    expect(on).toBeGreaterThan(1000);
    expect(on).toBeLessThan(2000);
  });
  test('real public keys are on the curve', () => {
    for (let i = 0; i < 50; i++) expect(isEd25519Point(ed25519.getPublicKey(ed25519.utils.randomSecretKey()))).toBe(true);
  });
  test('edge encodings: the identity, y = p (non-canonical), sign bit on x = 0, and a length other than 32', () => {
    const id = new Uint8Array(32);
    id[0] = 1; // y = 1, x = 0
    expect(isEd25519Point(id)).toBe(noble(id));
    const signed = id.slice();
    signed[31] = 0x80;
    expect(isEd25519Point(signed)).toBe(noble(signed));
    const p = new Uint8Array(32).fill(0xff);
    p[0] = 0xed;
    p[31] = 0x7f; // y = 2^255 - 19 = p, reduces to 0
    expect(isEd25519Point(p)).toBe(noble(p));
    expect(isEd25519Point(new Uint8Array(31))).toBe(false);
    expect(isEd25519Point(new Uint8Array(33))).toBe(false);
  });
  test('a known program derived address is off the curve; the System Program (all zero) is not a valid point either way noble says', () => {
    // The ATA program id and the Token program id are program accounts: Solana lists them as off-curve.
    const ata = b58decode('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    expect(isEd25519Point(ata)).toBe(noble(ata));
  });
});
