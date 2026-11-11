import { readFileSync } from 'node:fs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { bidNonce, toBase64 } from '@tender/intents';
import { describe, expect, it } from 'vitest';
import { fixturePath } from '../../src/lib/paths.js';

interface Case { name: string; intents_salt: string; close_ns: string; contract: string; sale: string; signer: string; cm: string; nonce_hex: string; nonce_b64: string }
const { cases } = JSON.parse(readFileSync(fixturePath('intents/bid-nonce.json'), 'utf8')) as { cases: Case[] };
const args = (c: Case) => ({ saltHex: c.intents_salt, closeNs: BigInt(c.close_ns), contract: c.contract, sale: BigInt(c.sale), signer: c.signer, cm: c.cm });

// seal:bid signs with @tender/intents bidNonce: it must equal the shared vector the app, scripts and Rust use.
describe('bidNonce (fixtures/intents/bid-nonce.json)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const n = bidNonce(args(c));
    expect(bytesToHex(n)).toBe(c.nonce_hex);
    expect(toBase64(n)).toBe(c.nonce_b64);
  });

  it('another cm, sale, signer, contract or salt gives another nonce', () => {
    const c = args(cases[0]!);
    const base = bytesToHex(bidNonce(c));
    for (const patch of [{ cm: 'ef'.repeat(32) }, { sale: 4n }, { signer: 'bob.near' }, { contract: 'v2.tenderseal.near' }, { saltHex: '01020304' }]) {
      expect(bytesToHex(bidNonce({ ...c, ...patch }))).not.toBe(base);
    }
  });
});
