import { describe, expect, test } from 'vitest';
import { buildVersionedNonce, decodeVersionedNonce, fromHex, makeDeadline, toBase64 } from '../src/index.js';
import vectors from './vectors/near-intents-16d04f6e.json';

describe('versioned nonce', () => {
  test('golden_nonce_matches_sdk_vector', () => {
    const v = vectors.versioned_nonce;
    const n = buildVersionedNonce({
      saltHex: v.salt_hex,
      deadlineMs: Date.parse(v.deadline_iso),
      random15: fromHex(v.random15_hex),
    });
    expect(toBase64(n)).toBe(v.nonce_b64);
  });

  test('nonce_deadline_equals_payload_deadline', () => {
    const { deadlineMs, deadlineIso } = makeDeadline();
    const n = toBase64(buildVersionedNonce({ saltHex: '252812b3', deadlineMs }));
    const d = decodeVersionedNonce(n);
    expect(d.deadlineNs).toBe(BigInt(Date.parse(deadlineIso)) * 1_000_000n);
    expect(d.saltHex).toBe('252812b3');
    expect(d.random.length).toBe(15);
  });

  test('deadline_whole_second', () => {
    const { deadlineMs, deadlineIso } = makeDeadline(1731463800123);
    expect(deadlineIso.endsWith('.000Z')).toBe(true);
    expect(deadlineMs % 1000).toBe(0);
    expect(deadlineMs).toBe(1731464400000);
  });

  test('rejects_bad_salt_and_random', () => {
    expect(() => buildVersionedNonce({ saltHex: '2528', deadlineMs: 0 })).toThrow('salt must be 4 bytes');
    expect(() => buildVersionedNonce({ saltHex: '252812b3', deadlineMs: 0, random15: new Uint8Array(14) })).toThrow('15 bytes');
    expect(() => decodeVersionedNonce(toBase64(new Uint8Array(32)))).toThrow('magic');
  });
});
