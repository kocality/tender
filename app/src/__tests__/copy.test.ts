import { describe, expect, test } from 'vitest';
import { HOME, MORE_LIMITS, TRUST_LINE, cancelledLabel, originBadge, timelineStage, twinVerdict } from '../copy';

describe('the hero says who asks for the key and when', () => {
  test('step 02: the locked sale contract asks, and only when the public conditions hold; the key network checks no conditions', () => {
    const step = HOME.steps[1];
    expect(step).toContain('The locked sale contract is the only account that can get that key');
    expect(step).toContain("it asks only after close, if the sale's public conditions hold");
    expect(step).not.toMatch(/network (gives|releases|hands)/i);
  });
  test('the caveat under the steps is plain, keeps both exceptions and former key holders, and is not worded as a threat', () => {
    expect(HOME.heroCaveat).toMatch(/^Two ways a price could leak:/);
    expect(HOME.howLead).toContain('your price is not, until the sale opens');
    expect(HOME.heroCaveat).toContain("11 of NEAR's key holders, past or present, working together");
    expect(HOME.heroCaveat).toContain('a tampered copy of this page');
    expect(HOME.heroCaveat).not.toMatch(/^Sealed unless/);
  });
});

describe('limits: plain words first, the technical wording one click behind', () => {
  const neverOpened = MORE_LIMITS.find((l) => l.title.startsWith('Bids in a sale that never opened'));
  test('the never-opened limit says it plainly and keeps the README wording as its technical detail', () => {
    expect(neverOpened?.text).toContain('its sealed bids are not erased');
    expect(neverOpened?.text).not.toMatch(/ciphertext|MPC|domain-2|threshold/);
    expect(neverOpened?.technical).toContain('so the MPC threshold still covers them');
    expect(neverOpened?.technical).toContain("a future compromise of NEAR's domain-2 master key would decrypt every stored bid");
  });
});

describe('originBadge (X12-03 unicode)', () => {
  test('declared origins get their chain name', () => {
    expect(originBadge('base')).toBe('via Base (self-declared)');
    expect(originBadge('near')).toBe('via NEAR (self-declared)');
  });
  test.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty', '', 'BASE'])('%j is not declared', (origin) => {
    expect(originBadge(origin)).toBe('origin not declared');
  });
  test('no origin is not declared', () => {
    expect(originBadge(null)).toBe('origin not declared');
    expect(originBadge(undefined)).toBe('origin not declared');
  });
});

describe('TRUST_LINE', () => {
  test('names the resharing caveat next to the threshold (CRYPTO-04)', () => {
    expect(TRUST_LINE).toContain('11 of 16 nodes on 2026-11-10');
    expect(TRUST_LINE).toContain('Resharing does not revoke old shares');
    expect(TRUST_LINE).toContain('hold or ever held a share of the domain-2 key');
  });
});

describe('twinVerdict and timelineStage (the twin card sentence and the sale timeline)', () => {
  const NS = 1_000_000_000n;
  const base = { closeNs: 100n * NS, escrowTotal: 9_000_000n, minEscrow: 2_000_000n, bidders: 2, minBidders: 2, keyRequests: 0, payoutsDone: 3, payoutsTotal: 3 };
  const before = 50n * NS;
  const after = 200n * NS;
  const NEVER = cancelledLabel('Cancelled', 0)!;

  test('each state gets its own sentence, read from the chain numbers', () => {
    expect(twinVerdict({ ...base, state: 'Open', escrowTotal: 1_000_000n, bidders: 1 }, before)).toBe(
      'Taking sealed bids. 1 USDC from 1 bidder so far; it needs 2 USDC and 2 bidders to open.',
    );
    expect(twinVerdict({ ...base, state: 'Open' }, after)).toContain('Closed and met both conditions: 9 USDC (needed 2) from 2 bidders (needed 2)');
    expect(twinVerdict({ ...base, state: 'Open', bidders: 1 }, after)).toBe('Closed below its conditions: 1 bidder, 2 needed. Anyone can cancel it; every bid is then refunded in full.');
    expect(twinVerdict({ ...base, state: 'Keyed', keyRequests: 1 }, after)).toBe('Met both conditions. Key requested 1 time; the bids can be opened by anyone.');
    const fin = twinVerdict({ ...base, state: 'Finalized', keyRequests: 2 }, after);
    expect(fin).toContain('Key requested 2 times; the key was released and one price was set');
    expect(fin).not.toContain('every bid'); // a bid sealed so the keeper cannot open it may never be revealed
  });

  test('a Cancelled sale with no key request never repeats the pinned label; one with requests never says "never"', () => {
    const zero = twinVerdict({ ...base, state: 'Cancelled', escrowTotal: 1_000_000n, minEscrow: 5_000_000n }, after);
    expect(zero).toBe('Missed its conditions: 1 USDC deposited, 5 needed. Its key was never asked for; every bid was refunded in full.');
    // only the conditions it missed are listed; refunds still going out are not called done
    const pending = twinVerdict({ ...base, state: 'Cancelled', escrowTotal: 1_000_000n, minEscrow: 5_000_000n, bidders: 1, payoutsDone: 1 }, after);
    expect(pending).toBe('Missed its conditions: 1 USDC deposited, 5 needed; 1 bidder, 2 needed. Its key was never asked for; every bid is being refunded in full.');
    // conditions met but nobody opened it within 24 h: cancelled without a key request
    expect(twinVerdict({ ...base, state: 'Cancelled' }, after)).toContain('nobody opened it within 24 hours of close');
    expect(zero).not.toContain(NEVER);
    expect(zero).not.toContain('never requested');
    const asked = twinVerdict({ ...base, state: 'Cancelled', keyRequests: 1 }, after);
    expect(asked).toContain('Cancelled after 1 key request');
    expect(asked).not.toMatch(/never/i);
  });

  test('no verdict uses the words the honest-claims rule forbids', () => {
    for (const state of ['Open', 'Opening', 'Keyed', 'Finalized', 'Cancelled'] as const) {
      for (const now of [before, after]) {
        expect(twinVerdict({ ...base, state }, now)).not.toMatch(/succeed|sealed forever|guarantee|nobody, including us/i);
      }
    }
  });

  test('timeline stages', () => {
    expect(timelineStage({ ...base, state: 'Open' }, before)).toEqual({ at: 0, branch: null });
    expect(timelineStage({ ...base, state: 'Open' }, after)).toEqual({ at: 1, branch: null });
    expect(timelineStage({ ...base, state: 'Opening' }, after).at).toBe(2);
    expect(timelineStage({ ...base, state: 'Keyed' }, after).at).toBe(3);
    expect(timelineStage({ ...base, state: 'Finalized' }, after).at).toBe(4);
    expect(timelineStage({ ...base, state: 'Cancelled' }, after)).toEqual({ at: 2, branch: 'Cancelled · key never requested' });
    const asked = timelineStage({ ...base, state: 'Cancelled', keyRequests: 3 }, after);
    expect(asked.branch).toBe('Cancelled after 3 key requests');
  });
});
