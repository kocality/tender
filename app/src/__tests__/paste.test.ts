import { describe, expect, test } from 'vitest';
import { toBase64 } from '@tender/intents';
import { parsePastedBid, sealCommand } from '../lib/pasteSealed';
import { buildPayload, buildVersionedNonce, bidMsg, nep413Message, payloadString, transferIntent } from '@tender/intents';

const ct = toBase64(new Uint8Array(160).fill(7));
const cm = 'ab'.repeat(32);
const target = { contract: 'v1.tenderseal.near', network: 'mainnet' } as const;
const valid = { sale: '1', contract: 'v1.tenderseal.near', network: 'mainnet', signer: '0xabc', ct, cm, escrow: '3000000', origin: 'base', msg: '{}', payload: null };

describe('parsePastedBid', () => {
  test('accepts the stdout JSON of seal:bid', () => {
    const r = parsePastedBid(JSON.stringify(valid), '1', target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bid.escrow).toBe(3_000_000n);
      expect(r.bid.origin).toBe('base');
      expect(r.bid.saltIgnored).toBe(false);
    }
  });
  test('a 159 byte ciphertext is rejected', () => {
    const r = parsePastedBid(JSON.stringify({ ...valid, ct: toBase64(new Uint8Array(159)) }), '1', target);
    expect(r.ok).toBe(false);
  });
  test('a ciphertext that atob accepts but the contract would refuse is rejected (X12-04 unicode)', () => {
    const lenient = [
      ct.replace(/=+$/, ''), // padding dropped
      `${ct.slice(0, 100)}\n${ct.slice(100)}`, // a line break
      ` ${ct}`, // leading space
      ct.replace(/\+/g, '-').replace(/\//g, '_') + (ct.includes('+') || ct.includes('/') ? '' : 'x'), // URL-safe alphabet (or a stray char)
    ];
    for (const bad of lenient) {
      const r = parsePastedBid(JSON.stringify({ ...valid, ct: bad }), '1', target);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const nonCanonicalTail = ct.slice(0, -3) + 'B==';
    expect(atob(nonCanonicalTail).length).toBe(160); // the lenient decoder is fine with spare bits in the last character
    expect(parsePastedBid(JSON.stringify({ ...valid, ct: nonCanonicalTail }), '1', target).ok).toBe(false);
  });
  test('an upper case commitment is rejected', () => {
    expect(parsePastedBid(JSON.stringify({ ...valid, cm: cm.toUpperCase() }), '1', target).ok).toBe(false);
  });
  test('wrong sale, escrow below 1 USDC and bad JSON are rejected', () => {
    expect(parsePastedBid(JSON.stringify(valid), '2', target).ok).toBe(false);
    expect(parsePastedBid(JSON.stringify({ ...valid, escrow: '999999' }), '1', target).ok).toBe(false);
    expect(parsePastedBid('not json', '1', target).ok).toBe(false);
  });
  test('a salt in the JSON is ignored and flagged, never carried over', () => {
    const r = parsePastedBid(JSON.stringify({ ...valid, salt: '00'.repeat(16) }), '1', target);
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

// seal:bid prints {sale, contract, network, signer, ct, cm, escrow, origin, msg, payload}; the ct only opens under the deployment it was sealed for.
describe('deployment checks (X12-01, QA-02)', () => {
  const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const payloadFor = (receiver: string, amount: bigint) =>
    payloadString(
      buildPayload({
        signerId: '0xabc',
        verifyingContract: 'intents.near',
        deadlineIso: '2026-11-13T02:10:00.000Z',
        nonce: buildVersionedNonce({ saltHex: '252812b3', deadlineMs: Date.parse('2026-11-13T02:10:00.000Z'), random15: new Uint8Array(15) }),
        intents: [transferIntent({ receiverId: receiver, tokenId: USDC, amount, msg: bidMsg({ sale: '1', ct, cm }) })],
      }),
    );

  test('a testnet seal:bid pasted into the mainnet app is rejected, with both deployments named', () => {
    const testnet = { ...valid, contract: 'v1.tender-09bdfe.testnet', network: 'testnet' };
    const r = parsePastedBid(JSON.stringify(testnet), '1', target);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('v1.tender-09bdfe.testnet');
      expect(r.error).toContain('v1.tenderseal.near');
      expect(r.error).toContain('seal:bid');
    }
  });
  test('the same JSON is accepted by the app of the deployment it names', () => {
    const testnet = { ...valid, contract: 'v1.tender-09bdfe.testnet', network: 'testnet' };
    expect(parsePastedBid(JSON.stringify(testnet), '1', { contract: 'v1.tender-09bdfe.testnet', network: 'testnet' }).ok).toBe(true);
  });
  test('another contract on the same network, or a missing contract / network field, is rejected', () => {
    expect(parsePastedBid(JSON.stringify({ ...valid, contract: 'rehearsal.tenderseal.near' }), '1', target).ok).toBe(false);
    expect(parsePastedBid(JSON.stringify({ ...valid, contract: undefined }), '1', target).ok).toBe(false);
    expect(parsePastedBid(JSON.stringify({ ...valid, network: undefined }), '1', target).ok).toBe(false);
  });
  test('the payload must move the pasted escrow to this contract', () => {
    const good = { ...valid, payload: payloadFor('v1.tenderseal.near', 3_000_000n) };
    expect(parsePastedBid(JSON.stringify(good), '1', target).ok).toBe(true);
    // an edited escrow no longer matches what the payload would transfer (the commitment binds B, so the bid could never be revealed)
    expect(parsePastedBid(JSON.stringify({ ...good, escrow: '9000000' }), '1', target).ok).toBe(false);
    expect(parsePastedBid(JSON.stringify({ ...valid, payload: payloadFor('attacker.near', 3_000_000n) }), '1', target).ok).toBe(false);
    expect(parsePastedBid(JSON.stringify({ ...valid, payload: 'not json' }), '1', target).ok).toBe(false);
  });
  test('a NEAR payload (the nep413 message) is checked the same way', () => {
    const pl = buildPayload({
      signerId: 'bidder.tenderseal.near',
      verifyingContract: 'intents.near',
      deadlineIso: '2026-11-13T02:10:00.000Z',
      nonce: buildVersionedNonce({ saltHex: '252812b3', deadlineMs: Date.parse('2026-11-13T02:10:00.000Z'), random15: new Uint8Array(15) }),
      intents: [transferIntent({ receiverId: 'v1.tenderseal.near', tokenId: USDC, amount: 3_000_000n })],
    });
    expect(parsePastedBid(JSON.stringify({ ...valid, payload: nep413Message(pl) }), '1', target).ok).toBe(true);
    expect(parsePastedBid(JSON.stringify({ ...valid, escrow: '4000000', payload: nep413Message(pl) }), '1', target).ok).toBe(false);
  });
});

describe('signer is required (SC-05)', () => {
  test('a blob without a signer is rejected: only output produced for your own account is accepted', () => {
    const r = parsePastedBid(JSON.stringify({ ...valid, signer: undefined }), '1', target);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('signer');
  });
});
