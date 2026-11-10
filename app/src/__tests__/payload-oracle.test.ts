/// <reference types="node" />
// Our hand-built payloads vs @defuse-protocol/intents-sdk 0.95.0 (dev-only oracle: production code builds its own payloads).
// The SDK's ESM build fails to load in Node, so it is loaded through its CJS build.
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  b58encode,
  buildPayload,
  buildVersionedNonce,
  bidMsg,
  erc191FromWallet,
  evmSignerId,
  fromBase64,
  fromHex,
  intentHash,
  nep413FromWallet,
  nep413Prehash,
  nep413Message,
  payloadString,
  rawEd25519FromWallet,
  toBase64,
  transferIntent,
  utf8,
  type DefusePayload,
  type MultiPayload,
} from '@tender/intents';

const sdk = createRequire(import.meta.url)('@defuse-protocol/intents-sdk');

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const SALT = '252812b3';
const DEADLINE_ISO = '2026-11-13T02:10:00.000Z';
const RANDOM15 = new Uint8Array(15).fill(7);
const NONCE = buildVersionedNonce({ saltHex: SALT, deadlineMs: Date.parse(DEADLINE_ISO), random15: RANDOM15 });

function bidPayload(signerId: string): DefusePayload {
  return buildPayload({
    signerId,
    verifyingContract: 'intents.near',
    deadlineIso: DEADLINE_ISO,
    nonce: NONCE,
    intents: [
      transferIntent({
        receiverId: 'v1.tenderseal.near',
        tokenId: USDC,
        amount: 5_000_000n,
        msg: bidMsg({ sale: '1', ct: toBase64(new Uint8Array(160).fill(1)), cm: 'cd'.repeat(32), origin: 'arb' }),
      }),
    ],
  });
}

// Fixed ed25519 key through WebCrypto (PKCS#8 = fixed DER prefix ‖ 32-byte seed); ed25519 signatures are deterministic.
async function ed25519Key(seedByte: number) {
  const pkcs8 = new Uint8Array([...fromHex('302e020100300506032b657004220420'), ...new Uint8Array(32).fill(seedByte)]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pk = fromBase64(jwk.x!.replace(/-/g, '+').replace(/_/g, '/') + '=');
  const sign = async (msg: Uint8Array) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, new Uint8Array(msg)));
  return { pk, publicKey: `ed25519:${b58encode(pk)}`, sign };
}

async function erc191Pair(): Promise<{ ours: MultiPayload; theirs: MultiPayload; address: string }> {
  const acct = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const p = bidPayload(evmSignerId(acct.address));
  const theirs = (await sdk.createIntentSignerViem({ signer: acct }).signIntent(p)) as MultiPayload;
  const ours = erc191FromWallet(payloadString(p), await acct.signMessage({ message: payloadString(p) }));
  return { ours, theirs, address: acct.address.toLowerCase() };
}

async function nep413Pair(): Promise<{ ours: MultiPayload; theirs: MultiPayload; sdkHash: Uint8Array; ourHash: Uint8Array }> {
  const k = await ed25519Key(0x22);
  const p = bidPayload('bidder.tenderseal.near');
  let sdkHash = new Uint8Array();
  const signer = sdk.createIntentSignerNEP413({
    signMessage: async (_payload: unknown, hash: Uint8Array) => {
      sdkHash = new Uint8Array(hash);
      return { publicKey: k.publicKey, signature: toBase64(await k.sign(hash)) };
    },
    accountId: 'bidder.tenderseal.near',
  });
  const theirs = (await signer.signIntent(p)) as MultiPayload;
  const ourHash = nep413Prehash({ message: nep413Message(p), nonce32: NONCE, recipient: 'intents.near' });
  const ours = nep413FromWallet({ payload: p, nonce32: NONCE, publicKey: k.publicKey, signature: toBase64(await k.sign(ourHash)) });
  return { ours, theirs, sdkHash, ourHash };
}

describe('intents-sdk 0.95.0 oracle', () => {
  test('oracle_nonce', () => {
    const theirs = sdk.VersionedNonceBuilder.encodeNonce(fromHex(SALT), new Date(DEADLINE_ISO), RANDOM15);
    expect(toBase64(NONCE)).toBe(theirs);
    expect(theirs).toBe('Vij2xgAlKBKzALC4X8145xgHBwcHBwcHBwcHBwcHBwc=');
  });

  test('oracle_erc191_full_multipayload', async () => {
    const { ours, theirs, address } = await erc191Pair();
    expect(address).toBe('0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a');
    expect(JSON.stringify(ours)).toBe(JSON.stringify(theirs));
  });

  test('oracle_nep413_full_multipayload', async () => {
    const { ours, theirs, sdkHash, ourHash } = await nep413Pair();
    expect(sdkHash).toEqual(ourHash);
    expect(ours).toEqual(theirs);
    expect(JSON.stringify(ours)).toBe(JSON.stringify(theirs));
  });

  test('oracle_intent_hash', async () => {
    const k = await ed25519Key(0x33);
    const p = bidPayload(Array.from(k.pk, (b) => b.toString(16).padStart(2, '0')).join(''));
    const raw = rawEd25519FromWallet(payloadString(p), k.pk, await k.sign(utf8(payloadString(p))));
    const mps: MultiPayload[] = [(await erc191Pair()).ours, (await nep413Pair()).ours, raw];
    for (const mp of mps) expect(intentHash(mp)).toBe(await sdk.computeIntentHash(mp));
  });
});
