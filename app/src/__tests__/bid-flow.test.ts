import { describe, expect, test } from 'vitest';
import {
  CLOSE_MARGIN_NS,
  announcementFor,
  bidsOf,
  biddingBlock,
  canRegisterKey,
  fieldOfError,
  fundDecision,
  isFunded,
  nearFundCommand,
  problemSection,
  recoveryFor,
  stepAfterRelayFailure,
  submitDecision,
  validateBid,
} from '../lib/bidFlow';
import { buildPayload, buildVersionedNonce, nep413Message, transferIntent, type MultiPayload } from '@tender/intents';

const sale = { state: 'Open' as const, closeNs: 2_000n, reserve: 3_000_000n, lotExp: 0 };
const base = { priceText: '3.60', sizeText: '3', escrowText: '3', sale, nowNs: 1_000n };

describe('validateBid', () => {
  test('a valid bid gives p, q, B', () => {
    const r = validateBid({ ...base, escrowText: '5' });
    expect(r).toMatchObject({ ok: true, p: 3_600_000n, q: 3_000_000n, B: 5_000_000n, warnings: [] });
  });
  test('escrow below 1 USDC, size above escrow, price zero are errors', () => {
    expect(validateBid({ ...base, escrowText: '0.5', sizeText: '0.5' }).ok).toBe(false);
    expect(validateBid({ ...base, sizeText: '4' }).ok).toBe(false);
    expect(validateBid({ ...base, priceText: '0' }).ok).toBe(false);
  });
  test('closed or non-open sale is an error, judged on chain time', () => {
    expect(validateBid({ ...base, nowNs: 2_000n }).ok).toBe(false);
    expect(validateBid({ ...base, sale: { ...sale, state: 'Keyed' } }).ok).toBe(false);
  });
  test('below reserve warns but is allowed', () => {
    const r = validateBid({ ...base, priceText: '2.5' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings[0]).toContain('Below reserve');
  });
});

describe('wizard step decisions', () => {
  test('already funded: the deposit step is skipped', () => {
    expect(fundDecision(5_000_000n, 3_000_000n)).toEqual({ skip: true });
    expect(fundDecision(3_000_001n, 3_000_000n)).toEqual({ skip: true });
  });
  test('short balance: deposit covers the gap plus the buffer', () => {
    expect(fundDecision(1_000_000n, 3_000_000n)).toEqual({ skip: false, gap: 2_000_001n, deposit: 2_080_000n });
  });
  test('the gap is what is missing for the escrow plus the self-reveal reserve', () => {
    expect(fundDecision(999_999n, 1_000_000n)).toMatchObject({ gap: 2n });
    expect(fundDecision(1_000_000n, 1_000_000n)).toMatchObject({ gap: 1n });
    expect(fundDecision(0n, 1_000_000n)).toMatchObject({ gap: 1_000_001n });
  });
  test('an unregistered NEAR key shows the Register button', () => {
    expect(recoveryFor('public_key_not_registered', "public key 'x' doesn't exist for account 'y'").to).toBe('register_key');
  });
  test('relay 400 insufficient balance goes back to Fund', () => {
    expect(recoveryFor('insufficient_balance', 'insufficient balance or overflow').to).toBe('fund');
  });
  test('a stale salt or expired deadline means sign again, never automatic', () => {
    expect(recoveryFor('invalid_salt', 'invalid salt').to).toBe('sign_again');
    expect(recoveryFor('deadline_expired', 'deadline has expired').to).toBe('sign_again');
  });
  test('a bad signature is a hard failure and a busy relayer is a retry', () => {
    expect(recoveryFor('invalid_signature', 'invalid signature').to).toBe('fail');
    expect(recoveryFor('busy', 'Relayer busy, retry in 30 s').to).toBe('retry');
  });
  test('counts existing bids of the signer', () => {
    expect(bidsOf([{ bidder: 'a' }, { bidder: 'b' }, { bidder: 'a' }], 'a')).toBe(2);
  });
});

describe('size is public when escrow equals size (CRYPTO-06, X12P-03)', () => {
  test('q === B warns; q < B does not', () => {
    const same = validateBid({ ...base, sizeText: '3', escrowText: '3' });
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.warnings.join(' ')).toMatch(/size is public/);
    const room = validateBid({ ...base, sizeText: '3', escrowText: '5' });
    expect(room.ok && room.warnings).toEqual([]);
  });
});

describe('a warned bid needs a second click (QA-07)', () => {
  const warned = validateBid({ ...base, priceText: '2.5', escrowText: '5' }); // below reserve
  test('the first submit with warnings asks to confirm, the same values again go through', () => {
    const first = submitDecision(warned, null);
    expect(first.action).toBe('confirm');
    if (first.action === 'confirm') expect(submitDecision(warned, first.key)).toEqual({ action: 'submit' });
  });
  test('other values are warned about again, a clean bid goes straight through, errors reject', () => {
    const first = submitDecision(warned, null);
    const other = validateBid({ ...base, priceText: '2.4', escrowText: '5' });
    if (first.action === 'confirm') expect(submitDecision(other, first.key).action).toBe('confirm');
    expect(submitDecision(validateBid({ ...base, escrowText: '5' }), null)).toEqual({ action: 'submit' });
    expect(submitDecision(validateBid({ ...base, priceText: '' }), null)).toEqual({ action: 'reject' });
  });
  test('error messages point at their input', () => {
    expect(fieldOfError('Price: Enter a number such as 3.6')).toBe('price');
    expect(fieldOfError('Size cannot exceed the escrow.')).toBe('size');
    expect(fieldOfError('Escrow must be at least 1 USDC.')).toBe('escrow');
    expect(fieldOfError('This sale is closed.')).toBeNull();
  });
});

describe('funding keeps the self-reveal reserve (X12A-06)', () => {
  test('a balance exactly equal to the escrow is not funded: 1 micro-USDC would be left for nothing', () => {
    expect(isFunded(3_000_000n, 3_000_000n)).toBe(false);
    expect(isFunded(3_000_001n, 3_000_000n)).toBe(true);
    const d = fundDecision(3_000_000n, 3_000_000n);
    expect(d.skip).toBe(false);
    if (!d.skip) expect(d.gap).toBe(1n);
  });
});

describe('biddingBlock: the wizard re-checks the sale after the form (X12-02 time, X12-04 tabs, QA-03)', () => {
  const NS = 1_000_000_000n;
  const open = { state: 'Open' as const, inFlight: false, key: null, closeNs: 10_000n * NS, bids: 1, maxBids: 16, escrowTotal: 5_000_000n };
  test('an open sale well before close can take the bid', () => {
    expect(biddingBlock(open, 10_000n * NS - CLOSE_MARGIN_NS - NS, 3_000_000n)).toBeNull();
    expect(biddingBlock(open, 10_000n * NS - 120n * NS, 3_000_000n)).toBeNull();
  });
  test('the last 60 seconds and after close are blocked', () => {
    expect(biddingBlock(open, 10_000n * NS - 30n * NS)).toMatch(/under 60 seconds/);
    expect(biddingBlock(open, 10_000n * NS)).toMatch(/closed/);
  });
  test('a sale that is not Open, has a request in flight or a key is blocked', () => {
    expect(biddingBlock({ ...open, state: 'Cancelled' }, 0n)).toMatch(/Cancelled/);
    expect(biddingBlock({ ...open, state: 'Keyed' }, 0n)).toMatch(/Keyed/);
    expect(biddingBlock({ ...open, inFlight: true }, 0n)).toMatch(/key request/);
  });
  test('max_bids and the escrow cap are blocked', () => {
    expect(biddingBlock({ ...open, bids: 16 }, 0n)).toMatch(/maximum of 16/);
    expect(biddingBlock({ ...open, escrowTotal: 999_999_000_000n }, 0n, 2_000_000n)).toMatch(/escrow cap/);
  });
});

describe('relay failures leave the wizard a way out (QA-04)', () => {
  test('an unreachable, unconfigured or failing relayer is a retry, never a dead end', () => {
    expect(recoveryFor('unavailable', 'x').to).toBe('retry');
    expect(recoveryFor('unconfigured', 'x').to).toBe('retry');
  });
  test('after a failed relay the wizard is back at Sign, except when it re-enters funding', () => {
    expect(stepAfterRelayFailure(recoveryFor('unavailable', 'x'))).toBe('sign');
    expect(stepAfterRelayFailure(recoveryFor('invalid_signature', 'x'))).toBe('sign');
    expect(stepAfterRelayFailure(recoveryFor('insufficient_balance', 'x'))).toBe('fund');
  });
});

describe('a signature from the wrong account is not a key to register (X12A-02)', () => {
  const S8 = "public key 'secp256k1:abc' doesn't exist for account '0xabc'";
  test('only nep413 routes to Register; EVM and Solana fail with a different-account message', () => {
    expect(recoveryFor('public_key_not_registered', S8, 'nep413').to).toBe('register_key');
    const evm = recoveryFor('public_key_not_registered', S8, 'erc191');
    expect(evm.to).toBe('fail');
    expect(evm.message).toMatch(/different account/);
    expect(recoveryFor('public_key_not_registered', S8, 'raw_ed25519').to).toBe('fail');
  });
  const nep413 = (signerId: string): MultiPayload => {
    const pl = buildPayload({
      signerId,
      verifyingContract: 'intents.near',
      deadlineIso: '2026-11-13T02:10:00.000Z',
      nonce: buildVersionedNonce({ saltHex: '252812b3', deadlineMs: Date.parse('2026-11-13T02:10:00.000Z'), random15: new Uint8Array(15) }),
      intents: [transferIntent({ receiverId: 'v1.tenderseal.near', tokenId: 'nep141:x', amount: 1n })],
    });
    return { standard: 'nep413', payload: { message: nep413Message(pl), nonce: pl.nonce, recipient: 'intents.near' }, public_key: 'ed25519:k', signature: 'ed25519:s' };
  };
  test('registering needs a nep413 payload and the connected account to be its signer', () => {
    expect(canRegisterKey(nep413('alice.near'), 'alice.near')).toBe(true);
    expect(canRegisterKey(nep413('alice.near'), 'bob.near')).toBe(false);
    expect(canRegisterKey(nep413('alice.near'), undefined)).toBe(false);
    expect(canRegisterKey({ standard: 'erc191', payload: '{}', signature: 'secp256k1:x' }, '0xabc')).toBe(false);
  });
});

describe('what a screen reader hears (X12A-01)', () => {
  test('each step, the relay wait and every outcome have a sentence; the first step is silent', () => {
    expect(announcementFor('wallet', null, undefined)).toBe('');
    expect(announcementFor('seal', null, undefined)).toContain('Seal');
    expect(announcementFor('sign', 'relay', undefined)).toMatch(/relaying/);
    expect(announcementFor('sign', 'confirm', undefined)).toMatch(/confirm/);
    expect(announcementFor('done', null, null)).toMatch(/^Not stored/);
    expect(announcementFor('done', null, 'unknown')).toMatch(/Could not confirm/);
  });
  test('the error is shown in the section of the step it belongs to', () => {
    expect(problemSection('seal', true)).toBe('seal');
    expect(problemSection('relay', true)).toBe('sign');
    expect(problemSection('done', true)).toBe('result');
    expect(problemSection('wallet', false)).toBe('wallet');
    expect(problemSection('bid', true)).toBe('bid');
  });
});

describe('the NEAR funding command (X12A-06, QA-19)', () => {
  test('it is signed by the bidder, credits the bidder, and sends more than the gap', () => {
    const gap = 2_000_000n;
    const cmd = nearFundCommand({ amount: gap + 1n, quoteToken: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', signerId: 'bidder.tenderseal.near' });
    expect(cmd).toContain('sign-as bidder.tenderseal.near');
    expect(cmd).toContain('"msg":"bidder.tenderseal.near"');
    expect(cmd).not.toContain('<account>');
    expect(cmd).toContain('"amount":"2000001"');
  });
});
