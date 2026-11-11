import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, test, vi } from 'vitest';
import {
  bidMsg,
  bidNonce,
  bidNonceDeadlineMs,
  decodeVersionedNonce,
  fromBase64,
  fromHex,
  isNonceUsed,
  isValidSalt,
  makeDeadline,
  toBase64,
  withdrawNonce,
} from '../src/index.js';
import { readFileSync } from 'node:fs';
import vectors from './vectors/bid-nonce.json';

// The vector file the CLI owner published for every implementation (fixtures/intents/bid-nonce.json).
const shared = JSON.parse(readFileSync(new URL('../../../fixtures/intents/bid-nonce.json', import.meta.url), 'utf8')) as {
  cases: { name: string; intents_salt: string; close_ns: string; contract: string; sale: string; signer: string; cm: string; nonce_b64: string }[];
};

const T0 = 1_800_000_000_000;
const CLOSE_NS = BigInt(T0 + 3 * 3_600_000) * 1_000_000n;
const base = { saltHex: '252812b3', closeNs: CLOSE_NS, contract: 'v1.tenderseal.near', sale: 7n, signer: '0xabc', cm: 'aa'.repeat(32) };

describe('one nonce per sealed bid (DOUBLE-PLAN layer 2)', () => {
  test('the same sealed bid gives the same 32 bytes whenever it is built; the tail is sha256 of the documented preimage', () => {
    const a = bidNonce(base);
    expect(toBase64(bidNonce({ ...base }))).toBe(toBase64(a));
    expect(a).toHaveLength(32);
    const te = new TextEncoder();
    const sale = new Uint8Array(8);
    new DataView(sale.buffer).setBigUint64(0, 7n, true);
    const c = te.encode(base.contract);
    const s = te.encode(base.signer);
    const pre = new Uint8Array([...te.encode('tender/bid-nonce/v1'), c.length, ...c, ...sale, s.length, ...s, ...fromHex(base.cm)]);
    expect(Array.from(a.subarray(17))).toEqual(Array.from(sha256(pre).subarray(0, 15)));
  });
  test('golden vectors', () => {
    for (const v of vectors.cases) {
      const n = bidNonce({ saltHex: v.salt_hex, closeNs: BigInt(v.close_ns), contract: v.contract, sale: BigInt(v.sale), signer: v.signer, cm: v.cm });
      expect(toBase64(n)).toBe(v.nonce_b64);
    }
  });
  test('the shared fixtures/intents/bid-nonce.json vectors (Python hashlib, also used by the CLI and the Rust sandbox)', () => {
    expect(shared.cases.length).toBeGreaterThanOrEqual(3);
    for (const v of shared.cases) {
      const n = bidNonce({ saltHex: v.intents_salt, closeNs: BigInt(v.close_ns), contract: v.contract, sale: v.sale, signer: v.signer, cm: v.cm });
      expect(toBase64(n), v.name).toBe(v.nonce_b64);
    }
  });
  test('any other salt, sale, signer, cm or contract gives another nonce', () => {
    const n = toBase64(bidNonce(base));
    for (const d of [{ saltHex: '252812b4' }, { sale: 8n }, { signer: '0xabd' }, { cm: 'ab'.repeat(32) }, { contract: 'rc3.tenderseal.testnet' }]) {
      expect(toBase64(bidNonce({ ...base, ...d }))).not.toBe(n);
    }
  });
  test('the nonce deadline is close - 60 s in whole seconds, and every payload deadline the app signs is at or before it', () => {
    const d = decodeVersionedNonce(toBase64(bidNonce(base)));
    expect(d.deadlineNs).toBe(BigInt(bidNonceDeadlineMs(CLOSE_NS)) * 1_000_000n);
    expect(bidNonceDeadlineMs(CLOSE_NS + 999_000_000n)).toBe(bidNonceDeadlineMs(CLOSE_NS)); // sub-second part is dropped
    const notAfter = Number((CLOSE_NS - 60_000_000_000n) / 1_000_000n);
    for (const now of [T0, T0 + 3 * 3_600_000 - 61_000, T0 + 3 * 3_600_000 - 600_500]) {
      expect(BigInt(makeDeadline(now, 600_000, notAfter).deadlineMs) * 1_000_000n <= d.deadlineNs).toBe(true);
    }
  });
  test('the intents salt is part of the nonce, so a pinned salt is what makes a re-sign repeat it', () => {
    expect(decodeVersionedNonce(toBase64(bidNonce(base))).saltHex).toBe('252812b3');
  });
});

describe('seq in the bid message (contract RC3)', () => {
  test('seq is a JSON number after origin; without it the message is unchanged', () => {
    expect(bidMsg({ sale: 1n, ct: 'AAAA', cm: 'ab', origin: 'base' })).toBe('{"op":"bid","sale":"1","ct":"AAAA","cm":"ab","origin":"base"}');
    expect(bidMsg({ sale: 1n, ct: 'AAAA', cm: 'ab', origin: 'base', seq: 2 })).toBe('{"op":"bid","sale":"1","ct":"AAAA","cm":"ab","origin":"base","seq":2}');
    expect(bidMsg({ sale: 1n, ct: 'AAAA', cm: 'ab', seq: 0 })).toBe('{"op":"bid","sale":"1","ct":"AAAA","cm":"ab","seq":0}');
  });
  test('seq must be a u16', () => {
    for (const bad of [-1, 65_536, 1.5, Number.NaN]) expect(() => bidMsg({ sale: 1n, ct: 'AAAA', cm: 'ab', seq: bad })).toThrow(/seq/);
  });
});

describe('a withdraw nonce is tied to its quote', () => {
  const w = { saltHex: '252812b3', deadlineMs: T0 + 1_800_000, signer: '0xabc', depositAddress: 'dd'.repeat(32), tokenId: 'nep141:usdc', amount: 1_234_567n };
  test('same quote, same nonce, however late it is signed; the deadline is the quote deadline in whole seconds', () => {
    const a = withdrawNonce(w);
    expect(toBase64(withdrawNonce({ ...w }))).toBe(toBase64(a));
    expect(decodeVersionedNonce(toBase64(withdrawNonce({ ...w, deadlineMs: w.deadlineMs + 999 }))).deadlineNs).toBe(BigInt(w.deadlineMs) * 1_000_000n);
  });
  test('another deposit address, amount, token or signer is another nonce', () => {
    const n = toBase64(withdrawNonce(w));
    for (const d of [{ depositAddress: 'ee'.repeat(32) }, { amount: 1_234_568n }, { tokenId: 'nep141:x' }, { signer: '0xabd' }]) {
      expect(toBase64(withdrawNonce({ ...w, ...d }))).not.toBe(n);
    }
  });
  test('a bid nonce and a withdraw nonce never collide', () => {
    expect(toBase64(withdrawNonce(w))).not.toBe(toBase64(bidNonce(base)));
  });
});

describe('intents.near views for the resolver', () => {
  const answer = (v: unknown) => vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 't', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(v))) } }));
  const bodyOf = (f: ReturnType<typeof vi.fn>) => JSON.parse(((f.mock.calls[0] as unknown[])[1] as { body: string }).body) as { params: Record<string, unknown> };
  const argsOf = (f: ReturnType<typeof vi.fn>) => JSON.parse(new TextDecoder().decode(fromBase64(bodyOf(f).params.args_base64 as string))) as Record<string, unknown>;

  test('isNonceUsed asks is_nonce_used(account_id, nonce) at the given block', async () => {
    const f = answer(true);
    vi.stubGlobal('fetch', f);
    expect(await isNonceUsed(['http://one.invalid'], 'intents.near', '0xabc', 'AAAA', { blockId: 99 })).toBe(true);
    expect(bodyOf(f).params).toMatchObject({ method_name: 'is_nonce_used', account_id: 'intents.near', block_id: 99 });
    expect(argsOf(f)).toEqual({ account_id: '0xabc', nonce: 'AAAA' });
    vi.unstubAllGlobals();
  });
  test('isValidSalt asks is_valid_salt(salt)', async () => {
    const f = answer(false);
    vi.stubGlobal('fetch', f);
    expect(await isValidSalt(['http://one.invalid'], 'intents.near', '252812b3')).toBe(false);
    expect(argsOf(f)).toEqual({ salt: '252812b3' });
    vi.unstubAllGlobals();
  });
});
