import { describe, expect, test } from 'vitest';
import { bidsOf, fundDecision, recoveryFor, validateBid } from '../lib/bidFlow';

const sale = { state: 'Open' as const, closeNs: 2_000n, reserve: 3_000_000n, lotExp: 0 };
const base = { priceText: '3.60', sizeText: '3', escrowText: '3', sale, nowNs: 1_000n };

describe('validateBid', () => {
  test('a valid bid gives p, q, B', () => {
    const r = validateBid(base);
    expect(r).toMatchObject({ ok: true, p: 3_600_000n, q: 3_000_000n, B: 3_000_000n, warnings: [] });
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
    expect(fundDecision(3_000_000n, 3_000_000n)).toEqual({ skip: true });
  });
  test('short balance: deposit covers the gap plus the buffer', () => {
    expect(fundDecision(1_000_000n, 3_000_000n)).toEqual({ skip: false, gap: 2_000_000n, deposit: 2_070_000n });
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
