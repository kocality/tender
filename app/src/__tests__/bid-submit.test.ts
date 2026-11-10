/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { b58encode, fromBase64, fromHex, payloadString, rawEd25519FromWallet, simulateIntents, solanaSignerId } from '@tender/intents';
import { appId, decryptBids, simulateCkdKey } from '@tender/seal';
import { config } from '../config';
import { buildBidPayload } from '../lib/bidPayload';
import { RelayError, confirmBid, relay } from '../lib/relay';
import { sealForSale } from '../lib/sealBid';
import { parseBid } from '../lib/views';
import bids1 from '../__fixtures__/views/bids-1.json';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const v0 = (JSON.parse(readFileSync(new URL('../../../fixtures/ckd_test_vectors.json', import.meta.url), 'utf8')) as { vectors: { msk: string; pk: string }[] }).vectors[0]!;
// get_config returns the network key as a tagged base58 string
const mpk = `bls12381g2:${b58encode(fromHex(v0.pk))}`;
const contractId = 'v1.tenderseal.near';
const path = 'tender/1/00112233445566778899aabbccddeeff';

async function ed25519Wallet() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pkcs8 = new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pk32 = fromBase64(jwk.x!.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const sign = async (msg: Uint8Array) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(msg)));
  return { pk32, sign };
}

describe('the sealed bid transfer', () => {
  test('seal in the browser module, build the transfer, and the sale key decrypts it with a matching commitment', async () => {
    const { pk32 } = await ed25519Wallet();
    const bidder = solanaSignerId(pk32);
    const sealed = sealForSale({ contractId, sale: 1n, mpk, path, bidder, B: 3_000_000n, p: 3_600_000n, q: 2_000_000n });
    expect(sealed.salt).toHaveLength(16);
    expect(fromBase64(sealed.ct)).toHaveLength(160);
    expect(sealed.cm).toMatch(/^[0-9a-f]{64}$/);

    const payload = await buildBidPayload({
      signerId: bidder, receiverId: contractId, quoteToken: USDC, amount: 3_000_000n, sale: '1', ct: sealed.ct, cm: sealed.cm, origin: 'sol', saltHex: '252812b3', nowMs: 1_800_000_000_000,
    });
    const intent = payload.intents[0]!;
    expect(intent.receiver_id).toBe(contractId);
    expect(intent.tokens).toEqual({ [USDC]: '3000000' });
    expect(intent.min_gas).toBe('30000000000000');
    expect(JSON.parse(intent.msg!)).toEqual({ op: 'bid', sale: '1', ct: sealed.ct, cm: sealed.cm, origin: 'sol' });
    // price and size never appear in the payload that is signed and sent
    expect(payloadString(payload)).not.toContain('3600000');

    const S = simulateCkdKey(v0.msk, mpk, appId(contractId, path));
    const [row] = decryptBids({ S, contract: contractId, path, sale: 1n, bids: [{ idx: 0, bidder, B: 3_000_000n, ct: sealed.ct, cm: sealed.cm }] });
    expect(row).toMatchObject({ ok: true, p: 3_600_000n, q: 2_000_000n, cmOk: true });
  });

  // Free: the real intents.near accepts the signature, then fails on the empty balance.
  test.skipIf(!process.env.LIVE)('live: a signed wizard bid passes simulate_intents up to the balance check', async () => {
    const { pk32, sign } = await ed25519Wallet();
    const bidder = solanaSignerId(pk32);
    const sealed = sealForSale({ contractId, sale: 1n, mpk, path, bidder, B: 3_000_000n, p: 3_600_000n, q: 2_000_000n });
    const payload = await buildBidPayload({ signerId: bidder, receiverId: contractId, quoteToken: USDC, amount: 3_000_000n, sale: '1', ct: sealed.ct, cm: sealed.cm, origin: 'sol' });
    const str = payloadString(payload);
    const mp = rawEd25519FromWallet(str, pk32, await sign(new TextEncoder().encode(str)));
    const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [mp]);
    expect(sim).toMatchObject({ ok: false, kind: 'insufficient_balance' });
  }, 30_000);
});

describe('relay', () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const mp = { standard: 'erc191' as const, payload: '{}', signature: 'secp256k1:x' };
  const URL = 'http://localhost:8787/relay';

  test('200 returns the tx hash and posts {signed}', async () => {
    const f = reply(200, { txHash: 'H1' });
    vi.stubGlobal('fetch', f);
    await expect(relay([mp], URL)).resolves.toEqual({ txHash: 'H1' });
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ signed: [mp] });
  });
  test('400 simulate_failed is classified from the panic text in detail', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'simulate_failed', detail: 'insufficient balance or overflow' }));
    await expect(relay([mp], URL)).rejects.toMatchObject({ kind: 'insufficient_balance' });
  });
  test('429 means busy, an unreachable relayer or a missing URL are reported as such', async () => {
    vi.stubGlobal('fetch', reply(429, { error: 'rate_limited', detail: 'x' }));
    await expect(relay([mp], URL)).rejects.toMatchObject({ kind: 'busy' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(relay([mp], URL)).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(relay([mp], '')).rejects.toBeInstanceOf(RelayError);
    await expect(relay([mp], '')).rejects.toMatchObject({ kind: 'unconfigured' });
  });
});

describe('confirmBid', () => {
  const stored = bids1.map(parseBid);
  test('finds the bid of this signer with this commitment', async () => {
    const b = stored[0]!;
    const hit = await confirmBid({ sale: '1', bidder: b.bidder, cm: b.cm, timeoutMs: 50, intervalMs: 10, load: async () => stored });
    expect(hit?.idx).toBe(b.idx);
  });
  test('times out with null when the contract refunded the transfer', async () => {
    const hit = await confirmBid({ sale: '1', bidder: 'someone.near', cm: 'aa'.repeat(32), timeoutMs: 30, intervalMs: 10, load: async () => stored });
    expect(hit).toBeNull();
  });
});
