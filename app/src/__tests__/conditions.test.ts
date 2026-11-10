import { describe, expect, test } from 'vitest';
import saleCancelled from '../__fixtures__/views/sale-0-cancelled.json';
import saleKeyed from '../__fixtures__/views/sale-1-keyed.json';
import { openConditions, keyStatusLabel } from '../lib/conditions';
import { parseSale, type Sale } from '../lib/views';

const NS = 1_000_000_000n;
const open = (over: Record<string, unknown>) => parseSale({ ...saleKeyed, state: 'Open', key: null, key_requests: 0, ...over });
const CLOSE = parseSale(saleKeyed).closeNs;
const AFTER = CLOSE + 10n * NS;

describe('openConditions (C13 / C19)', () => {
  test('before close: nothing is available', () => {
    const c = openConditions(open({}), CLOSE - 1n);
    expect(c).toMatchObject({ closed: false, escrowOk: true, biddersOk: true, canOpen: false, canCancel: false, cancelReason: null });
  });

  test('all conditions hold after close: open, no cancel', () => {
    const c = openConditions(open({}), AFTER);
    expect(c).toMatchObject({ closed: true, canOpen: true, canCancel: false });
  });

  test('escrow short: cancel, no open', () => {
    const c = openConditions(open({ escrow_total: '49999999' }), AFTER);
    expect(c).toMatchObject({ escrowOk: false, biddersOk: true, canOpen: false, canCancel: true, cancelReason: 'conditions_not_met' });
  });

  test('bidders short: cancel, no open', () => {
    const c = openConditions(open({ bidders: 2 }), AFTER);
    expect(c).toMatchObject({ escrowOk: true, biddersOk: false, canOpen: false, canCancel: true, cancelReason: 'conditions_not_met' });
  });

  test('request in flight: neither open nor cancel', () => {
    const c = openConditions(open({ in_flight: true }), AFTER);
    expect(c).toMatchObject({ canOpen: false, canCancel: false });
  });

  test('key already present: neither open nor cancel', () => {
    const c = openConditions(parseSale({ ...saleKeyed, state: 'Open' }), AFTER);
    expect(c.canOpen).toBe(false);
    expect(c.canCancel).toBe(false);
  });

  test('failed key request leaves the sale Open: cancel only after close + 24 h', () => {
    const failed = open({ key_requests: 1 });
    expect(openConditions(failed, CLOSE + 86_399n * NS).canCancel).toBe(false);
    expect(openConditions(failed, CLOSE + 86_400n * NS)).toMatchObject({ canOpen: true, canCancel: true, cancelReason: 'no_key_after_24h' });
  });

  test('a failed-conditions sale with prior key requests cannot use the early cancel', () => {
    const c = openConditions(open({ escrow_total: '1', key_requests: 1 }), AFTER);
    expect(c.canCancel).toBe(false);
  });

  test('terminal states offer nothing', () => {
    expect(openConditions(parseSale(saleCancelled), CLOSE + 100_000n * NS)).toMatchObject({ canOpen: false, canCancel: false });
  });
});

describe('keyStatusLabel', () => {
  const label = (s: Sale) => keyStatusLabel(s);
  test('Cancelled with 0 key requests: never requested', () => {
    expect(label(parseSale(saleCancelled))).toBe('Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)');
  });
  test('Cancelled with 2 key requests: may be decryptable', () => {
    expect(label(parseSale({ ...saleCancelled, key_requests: 2 }))).toBe('Cancelled after 2 key requests · may be decryptable');
  });
  test('any other state: no label', () => {
    expect(label(parseSale(saleKeyed))).toBeNull();
    expect(label(open({}))).toBeNull();
  });
});
