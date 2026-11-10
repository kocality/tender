/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { b58encode, fromHex } from '@tender/intents';
import { MPC_DOMAIN2_PK, appId, simulateCkdResponse } from '@tender/seal';
import { assertPinnedMpk, sealForSale, sealWithConfig } from '../lib/sealBid';
import { decryptSale } from '../lib/decrypt';

afterEach(() => vi.unstubAllGlobals());

const root = new URL('../../../fixtures/', import.meta.url);
const vectors = (JSON.parse(readFileSync(new URL('ckd_test_vectors.json', root), 'utf8')) as { vectors: { msk: string; pk: string }[] }).vectors;
// A key whose master secret is public (a test vector): every bid sealed to it can be opened by anyone.
const foreignMpk = `bls12381g2:${b58encode(fromHex(vectors[0]!.pk))}`;
const contractId = 'v1.tenderseal.near';
const path = 'tender/1/00112233445566778899aabbccddeeff';
const input = { contractId, sale: 1n, path, bidder: 'bidder.near', B: 3_000_000n, p: 3_600_000n, q: 3_000_000n };

describe('the browser seals only to the pinned MPC key (QA-01, CRYPTO-05)', () => {
  test('a foreign bls12381g2 key is refused, the pinned one is accepted', () => {
    expect(() => assertPinnedMpk(foreignMpk, 'mainnet')).toThrow(/pinned mainnet key/);
    expect(() => assertPinnedMpk(MPC_DOMAIN2_PK.mainnet, 'mainnet')).not.toThrow();
    expect(() => assertPinnedMpk(MPC_DOMAIN2_PK.mainnet, 'testnet')).toThrow(); // the other network's key is foreign too
  });
  test('sealing with the key from get_config() refuses a foreign key and produces nothing', () => {
    expect(() => sealWithConfig({ ...input, mpk: foreignMpk }, 'mainnet')).toThrow(/Refusing to seal/);
  });
  test('the pinned key seals', () => {
    const out = sealWithConfig({ ...input, mpk: MPC_DOMAIN2_PK.mainnet }, 'mainnet');
    expect(out.ct).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(out.cm).toMatch(/^[0-9a-f]{64}$/);
  });
  test('decrypting also checks the sale key against the pinned key, not the one the contract reports', async () => {
    const r = simulateCkdResponse(vectors[0]!.msk, foreignMpk, appId(contractId, path), 'identity');
    const sale = { id: '1', path, key: { bigY: r.big_y, bigC: r.big_c, block: 1n, ns: 1n } };
    // default: pinned mainnet key -> the foreign key in get_config() fails, however well the key matches it
    const out = await decryptSale({ config: { appPkMode: 'identity', mpcPublicKey: foreignMpk }, sale, bids: [], contractId });
    expect(out.keyOk).toBe(false);
    expect(out.keyError).toMatch(/pinned/);
    // with the key supplied as the expectation (tests only) the same key passes
    expect((await decryptSale({ config: { appPkMode: 'identity', mpcPublicKey: foreignMpk }, sale, bids: [], contractId, expectedMpk: foreignMpk })).keyOk).toBe(true);
  });
});

describe('the salt is not a user secret (X12-03)', () => {
  test('sealing writes nothing to browser storage: no ct, cm or salt reaches localStorage, sessionStorage or IndexedDB', () => {
    const store = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    const idb = { open: vi.fn() };
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('sessionStorage', store);
    vi.stubGlobal('indexedDB', idb);
    sealForSale({ ...input, mpk: MPC_DOMAIN2_PK.mainnet });
    expect(store.setItem).not.toHaveBeenCalled();
    expect(idb.open).not.toHaveBeenCalled();
  });
  test('the code comment no longer tells users to keep the salt', () => {
    const src = readFileSync(new URL('../lib/sealBid.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/only the user may keep it|The reveal needs it/);
    expect(src).toMatch(/inside `ct`/);
  });
  test('a bid whose salt was thrown away is still revealed: decryption returns the salt from the ciphertext', async () => {
    const msk = vectors[0]!.msk;
    const sealed = sealForSale({ ...input, mpk: foreignMpk });
    const saltHex = Buffer.from(sealed.salt).toString('hex');
    sealed.salt.fill(0); // the user kept nothing
    const r = simulateCkdResponse(msk, foreignMpk, appId(contractId, path), 'identity');
    const out = await decryptSale({
      config: { appPkMode: 'identity', mpcPublicKey: foreignMpk },
      sale: { id: '1', path, key: { bigY: r.big_y, bigC: r.big_c, block: 1n, ns: 1n } },
      bids: [{ idx: 0, bidder: input.bidder, escrow: input.B, ct: sealed.ct, cm: sealed.cm }],
      contractId,
      expectedMpk: foreignMpk,
    });
    expect(out.rows[0]).toMatchObject({ status: 'ok', p: input.p, q: input.q, salt: saltHex });
  });
});
