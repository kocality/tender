// Mainnet simulate_intents with random keys (free view, nothing is signed for a real account).
// Run: LIVE=1 pnpm --filter @tender/intents exec vitest run test/live.test.ts
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, test } from 'vitest';
import {
  bidMsg,
  buildPayload,
  buildVersionedNonce,
  concatBytes,
  currentSalt,
  erc191FromWallet,
  erc191Prehash,
  evmSignerId,
  makeDeadline,
  nep413FromWallet,
  nep413Message,
  nep413Prehash,
  payloadString,
  rawEd25519FromWallet,
  simulateIntents,
  solanaSignerId,
  toBase64,
  toHex,
  transferIntent,
  utf8,
  b58encode,
  type MultiPayload,
} from '../src/index.js';

const RPC = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'];
const INTENTS = 'intents.near';
const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

async function bidPayload(signerId: string) {
  const salt = await currentSalt(RPC, INTENTS);
  const { deadlineMs, deadlineIso } = makeDeadline();
  const nonce = buildVersionedNonce({ saltHex: salt, deadlineMs });
  const msg = bidMsg({ sale: '1', ct: toBase64(new Uint8Array(160)), cm: '00'.repeat(32), origin: 'base' });
  const payload = buildPayload({
    signerId,
    verifyingContract: INTENTS,
    deadlineIso,
    nonce,
    intents: [transferIntent({ receiverId: 'v1.tenderseal.near', tokenId: USDC, amount: 5_000_000n, msg })],
  });
  return { payload, nonce };
}

async function rawEd25519Signed(tamper = false): Promise<MultiPayload> {
  const sk = ed25519.utils.randomSecretKey();
  const pk = ed25519.getPublicKey(sk);
  const { payload } = await bidPayload(solanaSignerId(pk));
  const s = payloadString(payload);
  const sig = ed25519.sign(utf8(s), sk);
  if (tamper) sig[0] = sig[0]! ^ 1;
  return rawEd25519FromWallet(s, pk, sig);
}

describe.skipIf(!process.env.LIVE)('live mainnet simulate_intents', () => {
  test('erc191_random_key_insufficient_balance', async () => {
    const sk = secp256k1.utils.randomSecretKey();
    const addr = '0x' + toHex(keccak_256(secp256k1.getPublicKey(sk, false).subarray(1)).subarray(12));
    const { payload } = await bidPayload(evmSignerId(addr));
    const s = payloadString(payload);
    const rec = secp256k1.sign(erc191Prehash(s), sk, { prehash: false, format: 'recovered' });
    const ethSig = concatBytes(rec.subarray(1), Uint8Array.of(rec[0]! + 27)); // r ‖ s ‖ v(27/28), as personal_sign returns
    const r = await simulateIntents(RPC, INTENTS, [erc191FromWallet(s, '0x' + toHex(ethSig))]);
    expect(r).toMatchObject({ ok: false, kind: 'insufficient_balance' });
  }, 60_000);

  test('raw_ed25519_random_key_insufficient_balance', async () => {
    const r = await simulateIntents(RPC, INTENTS, [await rawEd25519Signed()]);
    expect(r).toMatchObject({ ok: false, kind: 'insufficient_balance' });
  }, 60_000);

  test('nep413_implicit_account_insufficient_balance', async () => {
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const { payload, nonce } = await bidPayload(toHex(pk));
    const sig = ed25519.sign(nep413Prehash({ message: nep413Message(payload), nonce32: nonce, recipient: INTENTS }), sk);
    const mp = nep413FromWallet({ payload, nonce32: nonce, publicKey: `ed25519:${b58encode(pk)}`, signature: toBase64(sig) });
    const r = await simulateIntents(RPC, INTENTS, [mp]);
    expect(r).toMatchObject({ ok: false, kind: 'insufficient_balance' });
  }, 60_000);

  test('tampered_signature_invalid_signature', async () => {
    const r = await simulateIntents(RPC, INTENTS, [await rawEd25519Signed(true)]);
    expect(r).toMatchObject({ ok: false, kind: 'invalid_signature' });
  }, 60_000);
});
