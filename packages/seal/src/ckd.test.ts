import { existsSync, readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { type AppPkMode, appId, checkKey, keyFromCkd, MPC_DOMAIN2_PK, simulateCkdKey, simulateCkdResponse } from './index.js';

const vectors = JSON.parse(readFileSync(new URL('../../../fixtures/ckd_test_vectors.json', import.meta.url), 'utf8')) as {
  vectors: { msk: string; pk: string; app_id: string }[];
};
const v0 = vectors.vectors[0]!;
const pk = hexToBytes(v0.pk);
const MODES: AppPkMode[] = ['identity', 'generator', 'plain'];

describe('keyFromCkd and checkKey (vector 0 msk, simulated MPC, y = 7)', () => {
  const id = appId('v1.tenderseal.near', 'tender/1/00112233445566778899aabbccddeeff');
  const S = simulateCkdKey(v0.msk, pk, id);
  for (const mode of MODES) {
    it(`${mode}: key = S and checkKey true`, () => {
      const r = simulateCkdResponse(v0.msk, pk, id, mode, 7n);
      if (mode === 'identity') expect(r.big_c).not.toBe(r.big_y);
      const K = keyFromCkd(r, mode);
      expect(K.equals(S)).toBe(true);
      expect(checkKey(K, pk, id)).toBe(true);
      expect(checkKey(K, pk, appId('tenderseal.near', 'tender/1/00112233445566778899aabbccddeeff'))).toBe(false);
    });
  }
  it('wrong mode gives a key that fails checkKey', () => {
    const r = simulateCkdResponse(v0.msk, pk, id, 'generator', 7n);
    expect(checkKey(keyFromCkd(r, 'identity'), pk, id)).toBe(false);
  });
  it('checkKey(ZERO) is false and does not throw', () => {
    expect(checkKey(bls.G1.Point.ZERO, pk, id)).toBe(false);
  });
});

// Real mainnet S1 responses (evidence/spikes/s1-<mode>.json, written after H-S1). Skipped until G-S1.
describe('live S1 response (mainnet mpk)', () => {
  for (const mode of MODES) {
    const f = new URL(`../../../evidence/spikes/s1-${mode}.json`, import.meta.url);
    it.skipIf(!existsSync(f))(`s1-${mode}.json passes checkKey`, () => {
      const s1 = JSON.parse(readFileSync(f, 'utf8')) as {
        caller: string;
        path: string;
        response: { big_y: string; big_c: string };
      };
      const K = keyFromCkd(s1.response, mode);
      expect(checkKey(K, MPC_DOMAIN2_PK.mainnet, appId(s1.caller, s1.path))).toBe(true);
    });
  }
});

// Testnet S1 dry run (WS2-T01 step 0): real MPC responses from v1.signer-prod.testnet, all three modes.
describe('testnet S1 response (testnet mpk)', () => {
  for (const mode of MODES) {
    const f = new URL(`../../../evidence/spikes/s1-testnet-${mode}.json`, import.meta.url);
    it.skipIf(!existsSync(f))(`s1-testnet-${mode}.json passes checkKey`, () => {
      const s1 = JSON.parse(readFileSync(f, 'utf8')) as {
        caller: string;
        path: string;
        response: { big_y: string; big_c: string };
      };
      const K = keyFromCkd(s1.response, mode);
      expect(checkKey(K, MPC_DOMAIN2_PK.testnet, appId(s1.caller, s1.path))).toBe(true);
    });
  }
});
