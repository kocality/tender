/// <reference types="node" />
import { describe, expect, test } from 'vitest';
import {
  b58decode,
  currentSalt,
  decodeVersionedNonce,
  fromBase64,
  fromHex,
  payloadString,
  rawEd25519FromWallet,
  simulateIntents,
  solanaSignerId,
  toHex,
  utf8,
} from '@tender/intents';
import { buildTryBid } from '../lib/bidPayload';
import { config } from '../config';
import { humanError } from '../lib/errors';
import { interpretSimulation } from '../lib/tryResult';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

// Random ed25519 key through WebCrypto (PKCS#8 = fixed DER prefix ‖ 32-byte seed), standing in for Phantom.
async function ed25519Wallet() {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pkcs8 = new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pk32 = fromBase64(jwk.x!.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const sign = async (msg: Uint8Array) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(msg)));
  return { pk32, sign };
}

describe('buildTryBid', () => {
  test('is a realistic bid: msg shape, sizes, nonce and payload deadline agree', async () => {
    const { pk32 } = await ed25519Wallet();
    const signerId = solanaSignerId(pk32);
    const p = await buildTryBid({ signerId, receiverId: 'spike.tenderseal.near', quoteToken: USDC, origin: 'sol', saltHex: '252812b3', nowMs: 1_800_000_000_000 });
    expect(p.signer_id).toBe(signerId);
    expect(p.verifying_contract).toBe(config.intentsContractId);
    const intent = p.intents[0]!;
    expect(intent).toMatchObject({ intent: 'transfer', receiver_id: 'spike.tenderseal.near', tokens: { [USDC]: '1000000' }, min_gas: '30000000000000' });
    const msg = JSON.parse(intent.msg!) as { op: string; sale: string; ct: string; cm: string; origin: string };
    expect(Object.keys(msg)).toEqual(['op', 'sale', 'ct', 'cm', 'origin']);
    expect(msg).toMatchObject({ op: 'bid', sale: '18446744073709551615', origin: 'sol' });
    expect(fromBase64(msg.ct)).toHaveLength(160);
    expect(msg.cm).toMatch(/^[0-9a-f]{64}$/);
    const nonce = decodeVersionedNonce(p.nonce);
    expect(nonce.saltHex).toBe('252812b3');
    expect(nonce.deadlineNs).toBe(BigInt(Date.parse(p.deadline)) * 1_000_000n);
  });
});

describe('interpretSimulation', () => {
  test('insufficient balance and unregistered key both prove a valid signature', () => {
    expect(interpretSimulation({ ok: false, kind: 'insufficient_balance', message: 'insufficient balance or overflow' })).toMatchObject({
      tone: 'ok',
      text: 'signature valid · insufficient balance (simulation only, nothing was sent)',
    });
    expect(interpretSimulation({ ok: false, kind: 'public_key_not_registered', message: "public key 'x' doesn't exist for account 'y'" })).toMatchObject({
      tone: 'warn',
    });
  });

  test('funded account, stale salt and everything else', () => {
    expect(interpretSimulation({ ok: true, report: {} })).toMatchObject({ tone: 'ok', kind: 'ok' });
    expect(interpretSimulation({ ok: false, kind: 'invalid_salt', message: 'invalid salt' })).toMatchObject({ tone: 'bad', signAgain: true });
    const bad = interpretSimulation({ ok: false, kind: 'invalid_signature', message: 'invalid signature' });
    expect(bad).toMatchObject({ tone: 'bad', text: humanError('invalid_signature'), signAgain: false });
    expect(bad.text).toContain('Sign again');
  });
});

describe('raw_ed25519 try bid (stands in for Phantom)', () => {
  test('local: the wrapped signature verifies over the payload string', async () => {
    const { pk32, sign } = await ed25519Wallet();
    const p = await buildTryBid({ signerId: solanaSignerId(pk32), receiverId: config.tryReceiver, quoteToken: USDC, origin: 'sol', saltHex: '252812b3' });
    const str = payloadString(p);
    const mp = rawEd25519FromWallet(str, pk32, await sign(utf8(str)));
    if (mp.standard !== 'raw_ed25519') throw new Error('wrong standard');
    const key = await crypto.subtle.importKey('raw', new Uint8Array(b58decode(mp.public_key.slice('ed25519:'.length))), { name: 'Ed25519' }, false, ['verify']);
    const sig = b58decode(mp.signature.slice('ed25519:'.length));
    expect(await crypto.subtle.verify('Ed25519', key, new Uint8Array(sig), new Uint8Array(utf8(mp.payload)))).toBe(true);
    expect(toHex(pk32)).toBe(p.signer_id);
  });

  // LIVE=1 pnpm --filter @tender/app exec vitest run src/__tests__/try.test.ts  (free simulate_intents view, nothing is sent)
  test.skipIf(!process.env.LIVE)('LIVE: simulate_intents answers insufficient_balance', async () => {
    const { pk32, sign } = await ed25519Wallet();
    const salt = await currentSalt(config.rpcUrls, config.intentsContractId);
    const p = await buildTryBid({ signerId: solanaSignerId(pk32), receiverId: config.tryReceiver, quoteToken: USDC, origin: 'sol', saltHex: salt });
    const str = payloadString(p);
    const mp = rawEd25519FromWallet(str, pk32, await sign(utf8(str)));
    const sim = await simulateIntents(config.rpcUrls, config.intentsContractId, [mp]);
    expect(sim).toMatchObject({ ok: false, kind: 'insufficient_balance' });
  }, 60_000);
});

describe('a not-registered panic means a different account for EVM and Solana (X12A-02)', () => {
  const sim = { ok: false as const, kind: 'public_key_not_registered' as const, message: "public key 'secp256k1:x' doesn't exist for account '0xabc'" };
  test('nep413 keeps the register hint; erc191 and raw_ed25519 are told another account signed', () => {
    expect(interpretSimulation(sim, 'nep413')).toMatchObject({ tone: 'warn' });
    for (const standard of ['erc191', 'raw_ed25519'] as const) {
      const out = interpretSimulation(sim, standard);
      expect(out.tone).toBe('bad');
      expect(out.text).toMatch(/different account/);
      expect(out.text).not.toMatch(/not registered/);
    }
  });
});
