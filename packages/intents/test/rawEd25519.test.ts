import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, test } from 'vitest';
import { b58decode, intentHash, rawEd25519FromWallet, solanaSignerId, utf8, type MultiPayload } from '../src/index.js';
import vectors from './vectors/near-intents-16d04f6e.json';

describe('raw_ed25519', () => {
  test('upstream_hash_vector', () => {
    const v = vectors.raw_ed25519;
    const mp: MultiPayload = {
      standard: 'raw_ed25519',
      payload: v.payload,
      public_key: v.public_key,
      signature: `ed25519:${v.signature_b58}`,
    };
    expect(intentHash(mp)).toBe(v.intent_hash_b58);
    const pk = b58decode(mp.public_key.slice('ed25519:'.length));
    const sig = b58decode(mp.signature.slice('ed25519:'.length));
    expect(ed25519.verify(sig, utf8(mp.payload), pk)).toBe(true);
  });

  test('wraps_wallet_signature', () => {
    const sk = new Uint8Array(32).fill(3);
    const pk = ed25519.getPublicKey(sk);
    const payload = '{"signer_id":"x"}';
    const mp = rawEd25519FromWallet(payload, pk, ed25519.sign(utf8(payload), sk));
    if (mp.standard !== 'raw_ed25519') throw new Error('wrong standard');
    expect(ed25519.verify(b58decode(mp.signature.slice(8)), utf8(payload), b58decode(mp.public_key.slice(8)))).toBe(true);
    expect(solanaSignerId(pk)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => rawEd25519FromWallet(payload, pk, new Uint8Array(63))).toThrow('64 bytes');
  });
});
