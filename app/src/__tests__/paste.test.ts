import { describe, expect, test } from 'vitest';
import { toBase64 } from '@tender/intents';
import { parsePastedBid, sealCommand } from '../lib/pasteSealed';

const ct = toBase64(new Uint8Array(160).fill(7));
const cm = 'ab'.repeat(32);
const valid = { sale: '1', contract: 'v1.tenderseal.near', network: 'mainnet', signer: '0xabc', ct, cm, escrow: '3000000', origin: 'base', msg: '{}', payload: null };

describe('parsePastedBid', () => {
  test('accepts the stdout JSON of seal:bid', () => {
    const r = parsePastedBid(JSON.stringify(valid), '1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bid.escrow).toBe(3_000_000n);
      expect(r.bid.origin).toBe('base');
      expect(r.bid.saltIgnored).toBe(false);
    }
  });
  test('a 159 byte ciphertext is rejected', () => {
    const r = parsePastedBid(JSON.stringify({ ...valid, ct: toBase64(new Uint8Array(159)) }), '1');
    expect(r.ok).toBe(false);
  });
  test('an upper case commitment is rejected', () => {
    expect(parsePastedBid(JSON.stringify({ ...valid, cm: cm.toUpperCase() }), '1').ok).toBe(false);
  });
  test('wrong sale, escrow below 1 USDC and bad JSON are rejected', () => {
    expect(parsePastedBid(JSON.stringify(valid), '2').ok).toBe(false);
    expect(parsePastedBid(JSON.stringify({ ...valid, escrow: '999999' }), '1').ok).toBe(false);
    expect(parsePastedBid('not json', '1').ok).toBe(false);
  });
  test('a salt in the JSON is ignored and flagged, never carried over', () => {
    const r = parsePastedBid(JSON.stringify({ ...valid, salt: '00'.repeat(16) }), '1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bid.saltIgnored).toBe(true);
      expect(Object.keys(r.bid)).not.toContain('salt');
    }
  });
});

test('the re-run command carries the connected signer id', () => {
  expect(sealCommand('1', '0xabc')).toContain('--signer 0xabc');
});
