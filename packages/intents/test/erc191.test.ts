import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, test } from 'vitest';
import { b58decode, erc191FromWallet, erc191Prehash, evmSignerId, fromHex, toHex } from '../src/index.js';
import vectors from './vectors/near-intents-16d04f6e.json';

describe('erc191', () => {
  test('recovers_upstream_vector', () => {
    const v = vectors.erc191_recover;
    const sig = fromHex(v.signature_hex);
    const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64))
      .addRecoveryBit(sig[64]!)
      .recoverPublicKey(erc191Prehash(v.msg));
    expect(toHex(pub.toBytes(false).subarray(1))).toBe(v.public_key_uncompressed_hex);
  });

  test('normalizes_v', () => {
    const rs = '11'.repeat(64);
    const lastByte = (mp: ReturnType<typeof erc191FromWallet>) => {
      if (mp.standard !== 'erc191') throw new Error('wrong standard');
      expect(mp.signature.startsWith('secp256k1:')).toBe(true);
      return b58decode(mp.signature.slice('secp256k1:'.length))[64];
    };
    expect(lastByte(erc191FromWallet('p', `0x${rs}1b`))).toBe(0);
    expect(lastByte(erc191FromWallet('p', `0x${rs}1c`))).toBe(1);
    expect(lastByte(erc191FromWallet('p', `0x${rs}00`))).toBe(0);
    expect(lastByte(erc191FromWallet('p', `0x${rs}01`))).toBe(1);
    expect(() => erc191FromWallet('p', `0x${rs}1d`)).toThrow('recovery byte 29');
    expect(() => erc191FromWallet('p', `0x${rs}`)).toThrow('65 bytes');
  });

  test('lowercase_signer', () => {
    expect(evmSignerId('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
    expect(() => evmSignerId('0x1234')).toThrow('not an EVM address');
  });
});
