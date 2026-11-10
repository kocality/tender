import { readFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { type AppPkMode, keyFromCkd, simulateCkdKey, simulateCkdResponse } from './index.js';

const v0 = (
  JSON.parse(readFileSync(new URL('../../../fixtures/ckd_test_vectors.json', import.meta.url), 'utf8')) as {
    vectors: { msk: string; pk: string; app_id: string; sig: string }[];
  }
).vectors[0]!;

describe('sim', () => {
  it('simulateCkdKey(vector 0 msk, app_id) = vector sig', () => {
    const S = simulateCkdKey(v0.msk, hexToBytes(v0.pk), hexToBytes(v0.app_id));
    expect(bytesToHex(S.toBytes(true))).toBe(v0.sig);
  });

  it('simulateCkdResponse + keyFromCkd give the same S in all three modes', () => {
    const appId = hexToBytes(v0.app_id);
    for (const mode of ['identity', 'generator', 'plain'] as AppPkMode[]) {
      const K = keyFromCkd(simulateCkdResponse(v0.msk, hexToBytes(v0.pk), appId, mode), mode);
      expect(bytesToHex(K.toBytes(true))).toBe(v0.sig);
    }
  });
});
