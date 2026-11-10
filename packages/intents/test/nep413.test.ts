import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, test } from 'vitest';
import {
  b58decode,
  buildPayload,
  fromHex,
  makeDeadline,
  nep413Borsh,
  nep413FromWallet,
  nep413Prehash,
  toBase64,
  transferIntent,
} from '../src/index.js';
import vectors from './vectors/near-intents-16d04f6e.json';

describe('nep413', () => {
  test('borsh_layout', () => {
    const b = nep413Borsh({ message: 'hi', nonce32: new Uint8Array(32), recipient: 'intents.near' });
    expect(Array.from(b.subarray(0, 4))).toEqual([0x9d, 0x01, 0x00, 0x80]);
    expect(Array.from(b.subarray(4, 10))).toEqual([2, 0, 0, 0, 0x68, 0x69]);
    expect(b[b.length - 1]).toBe(0);
    expect(b.length).toBe(4 + 6 + 32 + 4 + 12 + 1);
    const withCb = nep413Borsh({ message: 'hi', nonce32: new Uint8Array(32), recipient: 'intents.near', callbackUrl: 'u' });
    expect(Array.from(withCb.subarray(-6))).toEqual([1, 1, 0, 0, 0, 0x75]);
  });

  test('upstream_verify_vector', () => {
    const v = vectors.nep413_verify;
    const hash = nep413Prehash({ message: v.message, nonce32: fromHex(v.nonce_hex), recipient: v.recipient });
    expect(ed25519.verify(fromHex(v.signature_hex), hash, fromHex(v.public_key_hex))).toBe(true);
  });

  test('wraps_base64_wallet_signature', () => {
    const sk = new Uint8Array(32).fill(5);
    const nonce32 = new Uint8Array(32).fill(9);
    const { deadlineIso } = makeDeadline(0);
    const payload = buildPayload({
      signerId: 'bidder.tenderseal.near',
      verifyingContract: 'intents.near',
      deadlineIso,
      nonce: nonce32,
      intents: [transferIntent({ receiverId: 'v1.tenderseal.near', tokenId: 'nep141:t', amount: 1n })],
    });
    const message = JSON.stringify({ deadline: deadlineIso, intents: payload.intents, signer_id: 'bidder.tenderseal.near' });
    const sig = ed25519.sign(nep413Prehash({ message, nonce32, recipient: 'intents.near' }), sk);
    const mp = nep413FromWallet({ payload, nonce32, publicKey: 'ed25519:pk', signature: toBase64(sig) });
    if (mp.standard !== 'nep413') throw new Error('wrong standard');
    expect(mp.payload).toEqual({ message, nonce: toBase64(nonce32), recipient: 'intents.near' });
    expect(b58decode(mp.signature.slice('ed25519:'.length))).toEqual(sig);
    expect(nep413FromWallet({ payload, nonce32, publicKey: 'p', signature: 'ed25519:abc' }).signature).toBe('ed25519:abc');
    expect(() => nep413FromWallet({ payload, nonce32: new Uint8Array(32), publicKey: 'p', signature: 's' })).toThrow('nonce');
  });
});
