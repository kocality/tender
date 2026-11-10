// Byte equality with ciphertexts produced by the prototype's own helpers (prototype/seal-golden.mjs).
import { readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { appId, ctToBase64, decrypt, encrypt, MPC_DOMAIN2_PK } from './index.js';

interface GoldenCase {
  name: string;
  mpk: string;
  account: string | null;
  path: string | null;
  app_id_hex: string;
  msg_hex: string;
  sigma_hex: string;
  U_hex: string;
  V_hex: string;
  W_hex: string;
  ct_b64: string;
  S_hex?: string;
}

const golden = JSON.parse(readFileSync(new URL('../../../fixtures/seal/ibe-golden.json', import.meta.url), 'utf8')) as {
  cases: GoldenCase[];
};
const byName = (n: string) => golden.cases.find((c) => c.name === n)!;

describe('golden', () => {
  it('mainnet-v1 encrypt is byte-identical', () => {
    const c = byName('mainnet-v1');
    expect(c.mpk).toBe(MPC_DOMAIN2_PK.mainnet);
    const id = appId('v1.tenderseal.near', c.path!);
    expect(bytesToHex(id)).toBe(c.app_id_hex);
    const ct = encrypt(c.mpk, id, hexToBytes(c.msg_hex), { sigma: hexToBytes(c.sigma_hex) });
    expect(bytesToHex(ct)).toBe(c.U_hex + c.V_hex + c.W_hex);
    expect(ctToBase64(ct)).toBe(c.ct_b64);
  });

  it('vector0 decrypts and rejects wrong key', () => {
    const c = byName('vector0-decrypt');
    const ct = encrypt(c.mpk, hexToBytes(c.app_id_hex), hexToBytes(c.msg_hex), { sigma: hexToBytes(c.sigma_hex) });
    expect(ctToBase64(ct)).toBe(c.ct_b64);
    const S = bls.G1.Point.fromBytes(hexToBytes(c.S_hex!));
    expect(bytesToHex(decrypt(S, ct))).toBe(c.msg_hex);
    expect(() => decrypt(S.add(bls.G1.Point.BASE), ct)).toThrow('FO check failed');
  });
});
