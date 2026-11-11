import { afterEach, describe, expect, test, vi } from 'vitest';
import { bidNonce, fromBase64 } from '@tender/intents';
import { TENDER_WAIT_MS, isFinal, offers, preSign, routeFailure, settle, type BidRow, type SettleIO } from '../lib/settle';
import { claimTicket, clearTicket, loadTicket, saveTicket, ticketKey, ticketNonceB64, type Ticket } from '../lib/ticket';
import { recoveryFor } from '../lib/bidFlow';

const CM = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
const t0: Ticket = {
  v: 1, network: 'testnet', contract: 'v1.tenderseal.near', sale: '7', saleCreatedNs: '1790000000000000000', signer: 'alice.testnet', cms: [CM], ct: 'ff', B: '5000000', origin: 'near',
  intentsSalt: '0a0b0c0d', seq: 0, closeNs: '1800000000000000000', sent: true, payloadDeadlineMs: 1_000_000, txHashes: [], relayer: null, usedSeenMs: null,
};
const io = (o: { ts: number; bids?: BidRow[]; used?: boolean; throws?: boolean; txs?: SettleIO['txOutcomes'] }): SettleIO => ({
  finalBlock: async () => {
    if (o.throws) throw new Error('rpc');
    return { height: 1, tsMs: o.ts };
  },
  bids: async () => o.bids ?? [],
  nonceUsed: async () => o.used ?? false,
  txOutcomes: o.txs ?? (async () => []),
});

describe('settle: what became of the bid, read at one final block', () => {
  test('stored needs a row with one of the plan commitments, and wins over a refund event for the same plan', async () => {
    const row = { idx: 3, bidder: 'alice.testnet', cm: CM };
    expect((await settle(io({ ts: 2e6, used: true, bids: [row] }), t0)).verdict).toEqual({ kind: 'stored', idx: 3, cm: CM });
    const refundEvent = async () => [{ kind: 'refunded' as const, reason: 'max_bids' }];
    expect((await settle(io({ ts: 2e6, used: true, bids: [row], txs: refundEvent }), t0)).verdict).toEqual({ kind: 'stored', idx: 3, cm: CM });
  });
  test('a row of another account with this cm, or of this account with another cm, is not "stored"', async () => {
    const v = (bids: BidRow[]) => settle(io({ ts: 500, used: true, bids }), t0).then((r) => r.verdict.kind);
    expect(await v([{ idx: 0, bidder: 'mallory.testnet', cm: CM }])).toBe('executed');
    expect(await v([{ idx: 0, bidder: 'alice.testnet', cm: OTHER }])).toBe('refunded'); // slot taken (below)
  });
  test('nonce used and no row yet is "executed", never "refunded", for 90 s of chain time', async () => {
    const r = await settle(io({ ts: 5_000, used: true }), t0);
    expect(r.verdict).toEqual({ kind: 'executed', sinceMs: 5_000 });
    expect(r.usedSeenMs).toBe(5_000);
    const later = { ...t0, usedSeenMs: 5_000 };
    expect((await settle(io({ ts: 5_000 + TENDER_WAIT_MS, used: true }), later)).verdict.kind).toBe('executed');
    expect((await settle(io({ ts: 5_001 + TENDER_WAIT_MS, used: true }), later)).verdict).toEqual({ kind: 'refunded', why: 'other' });
  });
  test('rows above seq without our cm mean another bid of the account took the slot: bid_seq, not stored', async () => {
    const mine = [{ idx: 4, bidder: 'alice.testnet', cm: OTHER }];
    expect((await settle(io({ ts: 500, used: true, bids: mine }), t0)).verdict).toEqual({ kind: 'refunded', why: 'bid_seq', other: [4] });
  });
  test('a Tender refund event names the reason', async () => {
    const txs = async () => [{ kind: 'refunded' as const, reason: 'closed' }];
    expect((await settle(io({ ts: 500, used: true, txs }), { ...t0, txHashes: ['H'], relayer: 'relayer.near' })).verdict).toEqual({ kind: 'refunded', why: 'closed' });
  });
  test('a dup_bid refund that names the stored copy is not a final "refunded": the row decides once the final block shows it', async () => {
    const t = { ...t0, txHashes: ['H'], relayer: 'relayer.near' };
    const txs = async () => [{ kind: 'refunded' as const, reason: 'dup_bid', cm: CM, have: 1, idx: 3 }];
    const lag = await settle(io({ ts: 500, used: true, txs }), t); // the tx outcome is ahead of the final block: no row yet
    expect(lag.verdict).toEqual({ kind: 'executed', sinceMs: 500 });
    expect(isFinal(lag.verdict)).toBe(false);
    expect((await settle(io({ ts: 600, used: true, txs, bids: [{ idx: 3, bidder: 'alice.testnet', cm: CM }] }), t)).verdict).toEqual({ kind: 'stored', idx: 3, cm: CM });
  });
  test('not used before the payload deadline: pending; after it: dead; a transaction still running: executed', async () => {
    expect((await settle(io({ ts: 999_999 }), t0)).verdict).toEqual({ kind: 'pending', untilMs: 1_000_000 });
    expect((await settle(io({ ts: 1_000_001 }), t0)).verdict).toEqual({ kind: 'dead' });
    expect((await settle(io({ ts: 1_000_001, txs: async () => [{ kind: 'running' as const }] }), t0)).verdict.kind).toBe('executed');
  });
  test('a failed read is unknown, which proves nothing', async () => {
    expect((await settle(io({ ts: 0, throws: true }), t0)).verdict).toEqual({ kind: 'unknown' });
  });
  test('a re-sealed plan (two commitments) finds either one stored', async () => {
    const t = { ...t0, cms: [OTHER, CM] };
    expect((await settle(io({ ts: 5, bids: [{ idx: 2, bidder: 'alice.testnet', cm: OTHER }] }), t)).verdict).toEqual({ kind: 'stored', idx: 2, cm: OTHER });
  });
});

describe('what the page may offer (the gate)', () => {
  test('unclear verdicts offer only Sign (same nonce) and the chain check: no Fund, Seal or another bid', () => {
    for (const v of [{ kind: 'pending', untilMs: 1 }, { kind: 'executed', sinceMs: 1 }, { kind: 'unknown' }] as const) {
      expect(offers(v)).toEqual({ sign: true, fund: false, seal: false, another: false });
      expect(isFinal(v)).toBe(false);
    }
  });
  test('stored offers another bid; refunded offers Seal again, never Sign again; dead frees Fund', () => {
    expect(offers({ kind: 'stored', idx: 0, cm: CM })).toEqual({ sign: false, fund: false, seal: false, another: true });
    expect(offers({ kind: 'refunded', why: 'x' })).toMatchObject({ sign: false, seal: true });
    expect(offers({ kind: 'dead' })).toMatchObject({ sign: true, fund: true, seal: false });
  });
});

describe('routeFailure', () => {
  test('after a payload was sent no answer except busy goes to Fund or Sign again; it asks the chain', () => {
    for (const k of ['insufficient_balance', 'deadline_expired', 'invalid_salt', 'nonce_expired', 'nonce_used', 'unavailable', 'other']) expect(routeFailure(k, true)).toBe('settle');
    expect(routeFailure('busy', true)).toBe('retry');
  });
  test('regression guard: on the first send insufficient_balance still goes to Fund and an expired deadline to Sign again', () => {
    expect(routeFailure('insufficient_balance', false)).toBe('fund');
    expect(routeFailure('deadline_expired', false)).toBe('sign_again');
    expect(routeFailure('nonce_used', false)).toBe('settle');
    expect(routeFailure('execute_unknown', false)).toBe('settle');
  });
  test('the old recovery map still sends deadline_expired to Sign again (it is only reached for a plan that has not sent)', () => {
    expect(recoveryFor('deadline_expired', '', 'erc191').to).toBe('sign_again');
  });
});

describe('preSign', () => {
  const other = { idx: 4, bidder: 'alice.testnet', cm: OTHER };
  test('nothing in the way: sign', () => expect(preSign({ bids: [], used: false }, t0)).toEqual({ ok: true }));
  test('the same cm is stored: no wallet prompt', () => expect(preSign({ bids: [{ ...other, cm: CM }], used: true }, t0)).toEqual({ stored: 4, cm: CM }));
  test('nonce used, no row: the resolver decides', () => expect(preSign({ bids: [], used: true }, t0)).toEqual({ settle: true }));
  test('the account has more bids than the plan seq: name them', () => expect(preSign({ bids: [other], used: false }, t0)).toEqual({ stale: [4] }));
  test('a plan made with seq 1 for an account with one bid signs', () => expect(preSign({ bids: [other], used: false }, { ...t0, seq: 1 })).toEqual({ ok: true }));
  test('a failed read: a plan that was never sent fails closed, a sent one may sign (same nonce)', () => {
    expect(preSign(null, { ...t0, sent: false })).toEqual({ retry: true, signAnyway: false });
    expect(preSign(null, t0)).toEqual({ retry: true, signAnyway: true });
  });
});

describe('ticket', () => {
  const mem = () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    return m;
  };
  afterEach(() => vi.unstubAllGlobals());

  test('survives a reload and gives the nonce of its bid without any stored signature', () => {
    mem();
    expect(saveTicket(t0)).toBe(true);
    const back = loadTicket(t0)!;
    expect(ticketNonceB64(back)).toBe(ticketNonceB64(t0));
    expect(fromBase64(ticketNonceB64(t0))).toEqual(bidNonce({ saltHex: '0a0b0c0d', closeNs: 1800000000000000000n, contract: t0.contract, sale: '7', signer: t0.signer, cm: CM }));
    clearTicket(t0);
    expect(loadTicket(t0)).toBeNull();
  });
  test('holds no price, size, commitment salt, signature or key', () => {
    const m = mem();
    saveTicket(t0);
    const text = [...m.values()].join('');
    expect(text).not.toMatch(/"(p|q|salt|signature|secret|key)"/);
  });
  test('keyed by network, contract, sale, the sale creation time and signer', () => {
    mem();
    saveTicket(t0);
    for (const d of [{ sale: '8' }, { signer: 'bob.testnet' }, { saleCreatedNs: '1790000000000000001' }, { contract: 'x.near' }, { network: 'mainnet' }]) expect(loadTicket({ ...t0, ...d })).toBeNull();
    expect(ticketKey(t0)).toBe('tender:ticket:v1:testnet:v1.tenderseal.near:7:1790000000000000000:alice.testnet');
  });
  test('a second tab never overwrites a live ticket: it gets the first tab bid back', () => {
    mem();
    saveTicket(t0);
    const second = claimTicket({ ...t0, cms: [OTHER], ct: 'ee', sent: false }, false);
    expect(second.restored).toBe(true);
    expect(second.ticket.cms).toEqual([CM]);
    expect(loadTicket(t0)!.cms).toEqual([CM]);
    // the owner re-sealing (after a refund) replaces its own ticket
    const mine = claimTicket({ ...t0, cms: [CM, OTHER], ct: 'ee' }, true);
    expect(mine.restored).toBe(false);
    expect(loadTicket(t0)!.cms).toEqual([CM, OTHER]);
  });
  test('blocked storage: save is false, load is null, nothing throws', () => {
    const bad = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: bad, setItem: bad, removeItem: bad });
    expect(saveTicket(t0)).toBe(false);
    expect(loadTicket(t0)).toBeNull();
    expect(() => clearTicket(t0)).not.toThrow();
    expect(claimTicket(t0, false).saved).toBe(false);
  });
});
