// C9/C10 layouts against fixtures/seal/commitment.json (Python hashlib reference, shared with the Rust contract).
import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { commitment, commitmentHex, commitmentPreimage, decodePlaintext, encodePlaintext } from './index.js';

interface Case {
  name: string;
  sale: string;
  bidder: string;
  B: string;
  p: string;
  q: string;
  salt_hex: string;
  preimage_hex: string;
  cm_hex: string;
  plaintext_hex: string;
}

const { cases } = JSON.parse(readFileSync(new URL('../../../fixtures/seal/commitment.json', import.meta.url), 'utf8')) as {
  cases: Case[];
};

describe('commitment', () => {
  it('has 3 cases', () => expect(cases).toHaveLength(3));
  for (const c of cases) {
    it(`case ${c.name}`, () => {
      const input = { sale: BigInt(c.sale), bidder: c.bidder, B: BigInt(c.B), p: BigInt(c.p), q: BigInt(c.q), salt: hexToBytes(c.salt_hex) };
      expect(bytesToHex(commitmentPreimage(input))).toBe(c.preimage_hex);
      expect(bytesToHex(commitment(input))).toBe(c.cm_hex);
      expect(commitmentHex(input)).toBe(c.cm_hex);
      const pt = encodePlaintext(input.p, input.q, input.salt);
      expect(bytesToHex(pt)).toBe(c.plaintext_hex);
      const back = decodePlaintext(pt);
      expect(back.p).toBe(input.p);
      expect(back.q).toBe(input.q);
      expect(bytesToHex(back.salt)).toBe(c.salt_hex);
    });
  }

  it('rejects a 65-byte bidder and out-of-range values', () => {
    const base = { sale: 1n, bidder: 'a'.repeat(64), B: 1n, p: 1n, q: 1n, salt: new Uint8Array(16) };
    expect(() => commitmentPreimage(base)).not.toThrow();
    expect(() => commitmentPreimage({ ...base, bidder: 'a'.repeat(65) })).toThrow('bidder');
    expect(() => commitmentPreimage({ ...base, p: 1n << 64n })).toThrow('p out of range');
    expect(() => commitmentPreimage({ ...base, B: 1n << 128n })).toThrow('B out of range');
    expect(() => commitmentPreimage({ ...base, sale: -1n })).toThrow('sale out of range');
    expect(() => encodePlaintext(1n, 1n, new Uint8Array(15))).toThrow('salt');
    expect(() => decodePlaintext(new Uint8Array(31))).toThrow('plaintext');
  });
});
