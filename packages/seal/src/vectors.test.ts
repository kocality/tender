// The 4 official near/mpc CKD vectors (fixtures/ckd_test_vectors.json, byte-identical to near/mpc 3.17.0 and 3.18.0).
import { readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkKey, decrypt, encrypt, g1ToString, keyFromCkdScalar } from './index.js';

const FILE = new URL('../../../fixtures/ckd_test_vectors.json', import.meta.url);
const SHA256 = 'a6305d0f5179ac38591bd20efc1ec46a50c84f95e279d981f143d88c72e5b6b5';
const G1 = bls.G1.Point;

interface Vector {
  a: string;
  app_id: string;
  big_c: string;
  big_y: string;
  pk: string;
  sig: string;
}

let vectors: Vector[] = [];

beforeAll(() => {
  const raw = readFileSync(FILE);
  expect(bytesToHex(sha256(raw))).toBe(SHA256);
  vectors = (JSON.parse(raw.toString('utf8')) as { vectors: Vector[] }).vectors;
  expect(vectors).toHaveLength(4);
});

const g1 = (hex: string) => g1ToString(G1.fromBytes(hexToBytes(hex)));

describe('near/mpc ckd_test_vectors', () => {
  for (const i of [0, 1, 2, 3]) {
    it(`vector ${i}`, () => {
      const v = vectors[i]!;
      const pk = hexToBytes(v.pk);
      const appId = hexToBytes(v.app_id);
      const S = keyFromCkdScalar({ big_y: g1(v.big_y), big_c: g1(v.big_c) }, BigInt('0x' + v.a));
      expect(bytesToHex(S.toBytes(true))).toBe(v.sig);
      expect(checkKey(S, pk, appId)).toBe(true);
      const m = randomBytes(32);
      const ct = encrypt(pk, appId, m);
      expect(ct).toHaveLength(160);
      expect(bytesToHex(decrypt(S, ct))).toBe(bytesToHex(m));
      expect(() => decrypt(S.add(G1.BASE), ct)).toThrow('FO check failed');
    });
  }
});
