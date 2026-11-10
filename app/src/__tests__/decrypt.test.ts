/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { b58encode, fromHex } from '@tender/intents';
import { appId, bytesToB64, sealBid, simulateCkdResponse, type AppPkMode } from '@tender/seal';
import { fromFixture } from '@tender/clearing';
import { decryptSale } from '../lib/decrypt';

const root = new URL('../../../fixtures/', import.meta.url);
const vectors = (JSON.parse(readFileSync(new URL('ckd_test_vectors.json', root), 'utf8')) as { vectors: { msk: string; pk: string }[] }).vectors;
const v0 = vectors[0]!;
const mpk = `bls12381g2:${b58encode(fromHex(v0.pk))}`;
const demo = fromFixture(JSON.parse(readFileSync(new URL('clearing/demo-sale-1.json', root), 'utf8')));
const contractId = 'v1.tenderseal.near';
const path = 'tender/1/00112233445566778899aabbccddeeff';
const bidders = ['0x0000000000000000000000000000000000001111', '2c9d89ca154fc30f64726378a173008291b1ffe92f0eb617bb376b8de3043307', 'bidder.tenderseal.near', '0xef3483ed23d94db653024753e5b9a5362e94e722', 'bidder2.tenderseal.near', '5d3f0d9f1c0a2b7e8a4c6e1f3b5d7a9c1e3f5a7b9d1c3e5f7a9b1d3f5c7e9a1b'];

// The spec's six demo bids, sealed to the sale identity, plus a random ciphertext and a copy of bid 0 under another bidder.
function sealedBids() {
  const honest = demo.bids.map((b, i) => {
    const s = sealBid({ mpk, contract: contractId, path, sale: 1n, bidder: bidders[i]!, B: b.B, p: b.p!, q: b.q! });
    return { idx: i, bidder: bidders[i]!, escrow: b.B, ct: s.ct_b64, cm: s.cm_hex };
  });
  const random = { idx: 6, bidder: 'mallory.near', escrow: 1_000_000n, ct: bytesToB64(crypto.getRandomValues(new Uint8Array(160))), cm: '00'.repeat(32) };
  const copy = { idx: 7, bidder: 'copycat.near', escrow: honest[0]!.escrow, ct: honest[0]!.ct, cm: honest[0]!.cm };
  return [...honest, random, copy];
}

function saleFor(mode: AppPkMode, msk = v0.msk) {
  const r = simulateCkdResponse(msk, mpk, appId(contractId, path), mode);
  return { cfg: { appPkMode: mode, mpcPublicKey: mpk }, sale: { id: '1', path, key: { bigY: r.big_y, bigC: r.big_c, block: 1n, ns: 1n } } };
}

describe.each(['identity', 'generator', 'plain'] as const)('decryptSale in %s mode', (mode) => {
  test('6 honest bids are ok, a random ciphertext is invalid_ct, a copied bid is cm_mismatch', async () => {
    const { cfg, sale } = saleFor(mode);
    const out = await decryptSale({ config: cfg, sale, bids: sealedBids(), contractId });
    expect(out.keyOk).toBe(true);
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'invalid_ct', 'cm_mismatch']);
    for (const [i, b] of demo.bids.entries()) {
      expect(out.rows[i]).toMatchObject({ p: b.p, q: b.q });
      expect(out.rows[i]!.salt).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('decryptSale key checks', () => {
  test('a key made with another master secret fails the key check and decrypts nothing', async () => {
    const { cfg, sale } = saleFor('identity', vectors[1]!.msk);
    const out = await decryptSale({ config: cfg, sale, bids: sealedBids(), contractId });
    expect(out.keyOk).toBe(false);
    expect(out.rows).toEqual([]);
  });
  test('a key for another sale path fails the key check', async () => {
    const { cfg, sale } = saleFor('generator');
    const out = await decryptSale({ config: cfg, sale: { ...sale, path: 'tender/2/00112233445566778899aabbccddeeff' }, bids: sealedBids(), contractId });
    expect(out.keyOk).toBe(false);
  });
  test('no key yet', async () => {
    const { cfg } = saleFor('identity');
    const out = await decryptSale({ config: cfg, sale: { id: '1', path, key: null }, bids: [], contractId });
    expect(out.keyOk).toBe(false);
  });
  test('the app mode matters: reading a generator-mode key as identity fails the check', async () => {
    const { sale } = saleFor('generator');
    const out = await decryptSale({ config: { appPkMode: 'identity', mpcPublicKey: mpk }, sale, bids: [], contractId });
    expect(out.keyOk).toBe(false);
  });
  test('reports progress and yields between chunks of four', async () => {
    const { cfg, sale } = saleFor('identity');
    const seen: number[] = [];
    await decryptSale({ config: cfg, sale, bids: sealedBids(), contractId, onProgress: (d) => seen.push(d) });
    expect(seen).toEqual([4, 8]);
  });
});
