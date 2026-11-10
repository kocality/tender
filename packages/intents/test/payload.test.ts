import { describe, expect, test } from 'vitest';
import {
  bidMsg,
  buildPayload,
  fromBase64,
  nep413Message,
  payloadString,
  revealMsg,
  transferIntent,
} from '../src/index.js';
import vectors from './vectors/near-intents-16d04f6e.json';

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const CM = 'ab'.repeat(32);

function fixedPayload() {
  return buildPayload({
    signerId: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a',
    verifyingContract: 'intents.near',
    deadlineIso: '2026-11-13T02:10:00.000Z',
    nonce: fromBase64(vectors.versioned_nonce.nonce_b64),
    intents: [
      transferIntent({
        receiverId: 'v1.tenderseal.near',
        tokenId: USDC,
        amount: 5_000_000n,
        msg: bidMsg({ sale: 1n, ct: 'AAAA', cm: CM, origin: 'base' }),
      }),
    ],
  });
}

describe('payload', () => {
  test('bid_payload_exact_string', () => {
    const expected =
      '{"signer_id":"0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a","verifying_contract":"intents.near",' +
      '"deadline":"2026-11-13T02:10:00.000Z","nonce":"Vij2xgAlKBKzALC4X8145xgHBwcHBwcHBwcHBwcHBwc=",' +
      '"intents":[{"intent":"transfer","receiver_id":"v1.tenderseal.near",' +
      '"tokens":{"nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1":"5000000"},' +
      `"msg":"{\\"op\\":\\"bid\\",\\"sale\\":\\"1\\",\\"ct\\":\\"AAAA\\",\\"cm\\":\\"${CM}\\",\\"origin\\":\\"base\\"}",` +
      '"min_gas":"30000000000000"}]}';
    expect(payloadString(fixedPayload())).toBe(expected);
  });

  test('nep413_message_has_only_deadline_intents_signer', () => {
    const m = JSON.parse(nep413Message(fixedPayload())) as Record<string, unknown>;
    expect(Object.keys(m)).toEqual(['deadline', 'intents', 'signer_id']);
  });

  test('bigint_amounts_never_number', () => {
    const t = transferIntent({ receiverId: 'x.near', tokenId: 'nep141:wrap.near', amount: 10n ** 24n });
    expect(t.tokens['nep141:wrap.near']).toBe('1000000000000000000000000');
    expect(t.msg).toBeUndefined();
    expect(t.min_gas).toBeUndefined();
    expect(() => transferIntent({ receiverId: 'x.near', tokenId: 't', amount: 0n })).toThrow('positive');
  });

  test('bid_msg_without_origin_and_reveal_msg', () => {
    expect(bidMsg({ sale: '7', ct: 'Q', cm: CM })).toBe(`{"op":"bid","sale":"7","ct":"Q","cm":"${CM}"}`);
    expect(revealMsg({ sale: 2n, items: [{ idx: 0, p: '150', q: '3000000', salt: '0f'.repeat(16) }] })).toBe(
      `{"op":"reveal","sale":"2","items":[{"idx":0,"p":"150","q":"3000000","salt":"${'0f'.repeat(16)}"}]}`,
    );
  });
});
