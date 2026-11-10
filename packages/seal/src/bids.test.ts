import { readFileSync } from 'node:fs';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { appId, bytesToB64, decryptBids, sealBid, simulateCkdKey } from './index.js';

const v0 = (
  JSON.parse(readFileSync(new URL('../../../fixtures/ckd_test_vectors.json', import.meta.url), 'utf8')) as {
    vectors: { msk: string; pk: string }[];
  }
).vectors[0]!;
const mpk = hexToBytes(v0.pk);
const contract = 'v1.tenderseal.near';
const path = 'tender/1/00112233445566778899aabbccddeeff';
const S = simulateCkdKey(v0.msk, mpk, appId(contract, path));

const honest = [
  { idx: 0, bidder: 'bidder.tenderseal.near', B: 5_000_000n, p: 3_900_000n, q: 4_000_000n },
  { idx: 1, bidder: '2c9d89ca154fc30f64726378a173008291b1ffe92f0eb617bb376b8de3043307', B: 5_000_000n, p: 3_800_000n, q: 3_000_000n },
  { idx: 2, bidder: '0xef3483ed23d94db653024753e5b9a5362e94e722', B: 3_000_000n, p: 3_700_000n, q: 3_000_000n },
];

describe('sealBid / decryptBids', () => {
  const sealed = honest.map((b) => ({ ...b, ...sealBid({ mpk, contract, path, sale: 1n, ...b }) }));

  it('3 honest bids decrypt with matching commitments', () => {
    const out = decryptBids({ S, contract, path, sale: 1n, bids: sealed.map((b) => ({ idx: b.idx, bidder: b.bidder, B: b.B, ct: b.ct_b64, cm: b.cm_hex })) });
    expect(out.filter((r) => r.ok && r.cmOk)).toHaveLength(3);
    for (const [i, r] of out.entries()) {
      expect(r.p).toBe(honest[i]!.p);
      expect(r.q).toBe(honest[i]!.q);
      expect(r.salt_hex).toBe(sealed[i]!.salt_hex);
    }
  });

  it('random 160 bytes fail without throwing', () => {
    const out = decryptBids({ S, contract, path, sale: 1n, bids: [{ idx: 9, bidder: 'x.near', B: 1n, ct: bytesToB64(randomBytes(160)), cm: '00'.repeat(32) }] });
    expect(out[0]!.ok).toBe(false);
    expect(['invalid U point', 'FO check failed']).toContain(out[0]!.reason);
  });

  it('malformed base64 or length fails without throwing', () => {
    const out = decryptBids({ S, contract, path, sale: 1n, bids: [{ idx: 0, bidder: 'x.near', B: 1n, ct: 'AAAA', cm: '' }] });
    expect(out[0]).toMatchObject({ idx: 0, ok: false, reason: 'ciphertext must be 160 bytes' });
  });

  it("a copy of A's ct+cm under bidder B decrypts but its commitment does not match", () => {
    const a = sealed[0]!;
    const out = decryptBids({ S, contract, path, sale: 1n, bids: [{ idx: 3, bidder: 'sol2.near', B: a.B, ct: a.ct_b64, cm: a.cm_hex }] });
    expect(out[0]).toMatchObject({ idx: 3, ok: true, cmOk: false, p: a.p, q: a.q });
  });

  it('q = 0 or q > B matches its commitment but is not revealable (contract rule 1 ≤ q ≤ B)', () => {
    const bidder = 'bidder.tenderseal.near';
    const B = 1_000_000n;
    const bids = [0n, B + 1n, B].map((q, idx) => {
      const s = sealBid({ mpk, contract, path, sale: 1n, bidder, B, p: 3_600_000n, q });
      return { idx, bidder, B, ct: s.ct_b64, cm: s.cm_hex };
    });
    const out = decryptBids({ S, contract, path, sale: 1n, bids });
    expect(out.map((r) => [r.ok, r.cmOk, r.revealable])).toEqual([
      [true, true, false],
      [true, true, false],
      [true, true, true],
    ]);
    expect(decryptBids({ S, contract, path, sale: 1n, bids: [{ ...bids[2]!, ct: 'AAAA' }] })[0]!.revealable).toBe(false);
  });

  it('a fixed salt is used as given', () => {
    const salt = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const r = sealBid({ mpk, contract, path, sale: 1n, bidder: 'bidder.tenderseal.near', B: 3_000_000n, p: 3_600_000n, q: 2_000_000n, salt });
    expect(r.salt_hex).toBe('000102030405060708090a0b0c0d0e0f');
    expect(r.cm_hex).toBe('9d63f0c855104b8681f8d7a65a6b899241303f8a9a96c390c021b3d36fcb07da');
  });
});
