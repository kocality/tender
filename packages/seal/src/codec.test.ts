import { describe, expect, it } from 'vitest';
import {
  ctFromBase64,
  ctToBase64,
  bytesToB64,
  b64ToBytes,
  g1ToString,
  g2ToString,
  GENERATOR_PK1,
  GENERATOR_PK2,
  IDENTITY_PK1,
  IDENTITY_PK2,
  MPC_DOMAIN2_PK,
  parseG1,
  parseG2,
} from './index.js';

describe('codec', () => {
  it('identity and generator strings round trip', () => {
    expect(g1ToString(parseG1(IDENTITY_PK1))).toBe(IDENTITY_PK1);
    expect(g2ToString(parseG2(IDENTITY_PK2))).toBe(IDENTITY_PK2);
    expect(g1ToString(parseG1(GENERATOR_PK1))).toBe(GENERATOR_PK1);
    expect(g2ToString(parseG2(GENERATOR_PK2))).toBe(GENERATOR_PK2);
    expect(parseG1(IDENTITY_PK1).is0()).toBe(true);
  });

  it('parses the mainnet and testnet domain-2 keys', () => {
    expect(g2ToString(parseG2(MPC_DOMAIN2_PK.mainnet))).toBe(MPC_DOMAIN2_PK.mainnet);
    expect(g2ToString(parseG2(MPC_DOMAIN2_PK.testnet))).toBe(MPC_DOMAIN2_PK.testnet);
  });

  it('rejects wrong prefix and length', () => {
    expect(() => parseG1(GENERATOR_PK2)).toThrow();
    expect(() => parseG2(GENERATOR_PK1)).toThrow();
    expect(() => parseG1('bls12381g1:1111')).toThrow('48 bytes');
  });

  it('ciphertext base64 is exactly 160 bytes', () => {
    const ct = new Uint8Array(160).map((_, i) => i);
    const b64 = ctToBase64(ct);
    expect(b64).toHaveLength(216);
    expect(ctFromBase64(b64)).toEqual(ct);
    expect(() => ctFromBase64(bytesToB64(new Uint8Array(159)))).toThrow('ciphertext must be 160 bytes');
    expect(() => ctFromBase64(bytesToB64(new Uint8Array(161)))).toThrow('ciphertext must be 160 bytes');
    expect(() => ctFromBase64('not base64!')).toThrow('ciphertext must be 160 bytes');
  });

  it('base64 matches the standard alphabet with padding', () => {
    const b = Uint8Array.of(0xfb, 0xff, 0x00, 0x01);
    expect(bytesToB64(b)).toBe('+/8AAQ==');
    expect(b64ToBytes('+/8AAQ==')).toEqual(b);
  });
});
