import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rt, settle as tick, textOf, walk } from './helpers/shallow';
import { MPC_DOMAIN2_PK } from '@tender/seal';
import type { MultiPayload } from '@tender/intents';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';

// DOUBLE-PLAN steps 4-6 on the bid wizard: the chain decides before the page funds, quotes, seals or signs again, a named
// confirmation precedes a deliberate second bid, and a saved ticket survives a reload. Driven without a DOM (helpers/shallow.ts).
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

const m = vi.hoisted(() => ({
  simulate: vi.fn(),
  relay: vi.fn(),
  quote: vi.fn(),
  balance: vi.fn(),
  payload: vi.fn(),
  readBids: vi.fn(),
  readForSign: vi.fn(),
  settle: vi.fn(),
}));
vi.mock('@tender/intents', async (orig) => ({
  ...(await orig<typeof import('@tender/intents')>()),
  simulateIntents: m.simulate,
  mtBalanceOf: m.balance,
  currentSalt: vi.fn(async () => '0a0b0c0d'),
}));
vi.mock('../lib/relay', async (orig) => ({ ...(await orig<typeof import('../lib/relay')>()), relay: m.relay }));
vi.mock('../lib/oneclick', async (orig) => ({ ...(await orig<typeof import('../lib/oneclick')>()), quoteDeposit: m.quote, getStatus: vi.fn() }));
vi.mock('../lib/bidPayload', () => ({ buildBidPayload: m.payload }));
vi.mock('../lib/settle', async (orig) => ({
  ...(await orig<typeof import('../lib/settle')>()),
  readBids: m.readBids,
  readForSign: m.readForSign,
  settle: m.settle,
  chainIO: vi.fn(() => ({})),
}));
vi.mock('../lib/views', async (orig) => ({
  ...(await orig<typeof import('../lib/views')>()),
  getConfig: vi.fn(async () => ({ mpcPublicKey: MPC_DOMAIN2_PK.mainnet })),
}));
vi.mock('../components/WalletPicker', () => ({ WalletPicker: () => null }));

import { config } from '../config';
import { RelayError } from '../lib/relay';
import { ticketKey, type Ticket } from '../lib/ticket';
import { parseSale } from '../lib/views';
import { Wizard } from '../pages/Bid';
import { BidForm } from '../components/BidForm';
import { DepositBox } from '../components/DepositBox';
import { PasteSealedBid } from '../components/PasteSealedBid';
import { WalletPicker } from '../components/WalletPicker';
import type { IntentSigner } from '../wallets/types';

const NS = 1_000_000_000n;
const NOW = 1_800_000_000n * NS;
const sale = { ...parseSale(sale1), state: 'Open' as const, key: null, bids: 0, bidders: 0, escrowTotal: 0n, maxBids: 16, closeNs: NOW + 3600n * NS };
const ME = '0xaaa';
const CM_OLD = 'ab'.repeat(32);
const pending = { verdict: { kind: 'pending', untilMs: Date.now() + 600_000 }, usedSeenMs: null };
const row = (idx: number, cm = CM_OLD) => ({ idx, bidder: ME, cm, escrow: 5_000_000n });

const signer = (id = ME): IntentSigner => ({
  kind: 'evm',
  signerId: id,
  origin: 'base',
  sign: vi.fn(async (): Promise<MultiPayload> => ({ standard: 'erc191', payload: '{}', signature: 'secp256k1:x' })),
});

type Props = Parameters<typeof Wizard>[0];
let props: Props;
const render = (): ReactElement => {
  rt.i = 0;
  rt.effects = [];
  return Wizard(props) as ReactElement;
};
const buttons = () => [...walk(render())].filter((e) => e.type === 'button');
const button = (label: string) => buttons().find((b) => textOf(b)?.includes(label));
const has = (label: string) => button(label) !== undefined;
const child = <P,>(type: unknown) => [...walk(render())].find((e) => e.type === type) as ReactElement<P> | undefined;
const click = async (label: string) => {
  const b = button(label);
  if (!b) throw new Error(`no button "${label}"; have: ${buttons().map((x) => textOf(x)).join(' | ')}`);
  await (b.props as { onClick: () => unknown }).onClick();
  await tick();
};
const connect = async (s: IntentSigner) => {
  child<{ onConnect: (s: IntentSigner) => void }>(WalletPicker)!.props.onConnect(s);
  await tick();
};
const submitForm = async (B = 5_000_000n) => {
  child<{ onSubmit: (v: { p: bigint; q: bigint; B: bigint }) => void }>(BidForm)!.props.onSubmit({ p: 3_600_000n, q: 3_000_000n, B });
  await tick();
};
const alertText = () =>
  [...walk(render())]
    .filter((e) => (e.props as { role?: string }).role === 'alert')
    .map((e) => textOf(e))
    .join(' ');
const pageText = () => textOf(render());

let mem: Map<string, string>;
const useStorage = () => {
  mem = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
};
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  v: 1, network: config.network, contract: config.tenderContractId, sale: '1', saleCreatedNs: String(sale.createdNs), signer: ME, cms: [CM_OLD], ct: 'Y3Q=', B: '5000000',
  origin: 'base', intentsSalt: '0a0b0c0d', seq: 0, closeNs: String(sale.closeNs), sent: true, payloadDeadlineMs: Date.now() + 600_000, txHashes: [], relayer: null, usedSeenMs: null, ...over,
});
const seed = (t: Ticket) => mem.set(ticketKey(t), JSON.stringify(t));

beforeEach(() => {
  useStorage();
  rt.slots = [];
  props = { id: '1', sale, bids: [], nowNs: NOW, synced: true, fundOnly: false };
  m.simulate.mockReset().mockResolvedValue({ ok: true, report: {} });
  m.balance.mockReset().mockResolvedValue(10_000_000n);
  m.relay.mockReset().mockRejectedValue(new RelayError('The relayer is not reachable.', 'unavailable'));
  m.quote.mockReset().mockResolvedValue({ quote: { depositAddress: 'dep-1', amountIn: '5100000', amountOut: '5000000', minAmountOut: '5000000' } });
  m.payload.mockReset().mockImplementation(async () => ({ signer_id: 'x', deadline: new Date(Date.now() + 600_000).toISOString() }));
  m.readBids.mockReset().mockResolvedValue({ height: 1, tsMs: Date.now(), bids: [] });
  m.readForSign.mockReset().mockResolvedValue({ bids: [], used: false });
  m.settle.mockReset().mockResolvedValue(pending);
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

/** Connect, fill the form, seal and sign once: the relay then fails with the mocked error. */
async function reachSign(s = signer()) {
  await connect(s);
  await submitForm();
  await click('Seal in this browser');
  await click('Sign with wallet');
  return s;
}

describe('step 4: after a send the chain decides, never "Sign again" or Fund', () => {
  test('relay unavailable, then insufficient_balance on the second signature: the resolver runs, no Fund, no quote', async () => {
    await reachSign();
    m.settle.mockClear();
    m.simulate.mockResolvedValue({ ok: false, kind: 'insufficient_balance', message: 'insufficient balance' });
    await click('Sign with wallet');
    expect(m.settle).toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    expect(child(DepositBox)).toBeUndefined();
    expect(has('Get a deposit address')).toBe(false);
  });
  test('a 202 execute_unknown whose bid the chain then shows stored goes to the result: no Sign, no Fund', async () => {
    m.relay.mockRejectedValue(new RelayError('lost', 'execute_unknown', 'H1', { txHashes: ['H1'], sender: 'relayer.near', untilMs: Date.now() + 1000 }));
    m.settle.mockResolvedValue({ verdict: { kind: 'stored', idx: 4, cm: CM_OLD }, usedSeenMs: null });
    await reachSign();
    expect(pageText()).toContain('Bid #4 stored');
    expect(has('Sign with wallet')).toBe(false);
    expect(has('Seal in this browser')).toBe(false);
  });
  test('deadline_expired after a send goes to the resolver, not to "Sign again"', async () => {
    await reachSign();
    m.settle.mockClear();
    m.simulate.mockResolvedValue({ ok: false, kind: 'deadline_expired', message: 'deadline has expired' });
    await click('Sign with wallet');
    expect(m.settle).toHaveBeenCalled();
    expect(has('Sign again')).toBe(false);
  });
  test('nonce used and no row yet is "executed", never "Not stored"', async () => {
    m.relay.mockRejectedValue(new RelayError('nonce was already used', 'nonce_used'));
    m.settle.mockResolvedValue({ verdict: { kind: 'executed', sinceMs: 1 }, usedSeenMs: 1 });
    await reachSign();
    expect(pageText()).not.toContain('Not stored');
    expect(has('Seal in this browser')).toBe(false);
    expect(has('Place another bid')).toBe(false);
    expect(has('Sign with wallet')).toBe(true); // harmless: the same nonce
  });
  test('bid_seq: another bid of yours took the slot; no Sign again, no Seal again', async () => {
    m.relay.mockRejectedValue(new RelayError('refused', 'bid_seq'));
    m.settle.mockResolvedValue({ verdict: { kind: 'refunded', why: 'bid_seq', other: [2] }, usedSeenMs: null });
    await reachSign();
    expect(alertText()).toMatch(/another bid of yours \(#2\) took this slot/);
    expect(has('Sign with wallet')).toBe(false);
    expect(has('Seal again')).toBe(false);
  });
  test('a relayer 409 already_stored with no matching row on chain is not shown as stored', async () => {
    m.relay.mockRejectedValue(new RelayError('already stored', 'already_stored'));
    m.settle.mockResolvedValue({ verdict: { kind: 'executed', sinceMs: 1 }, usedSeenMs: 1 });
    await reachSign();
    expect(pageText()).not.toMatch(/Bid #\d+ stored/);
  });
  test('regression guard: the first send with insufficient_balance still goes to Fund', async () => {
    m.simulate.mockResolvedValue({ ok: false, kind: 'insufficient_balance', message: 'insufficient balance' });
    m.balance.mockResolvedValueOnce(10_000_000n).mockResolvedValue(0n); // funded at first, the balance is gone when the simulation looks
    await reachSign();
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.quote).toHaveBeenCalled();
  });
  test('a refund (reason closed) shows Not stored with the reason and offers Seal again for a bid sealed here', async () => {
    m.relay.mockResolvedValue({ txHash: 'H1' });
    m.settle.mockResolvedValue({ verdict: { kind: 'refunded', why: 'closed' }, usedSeenMs: null });
    await reachSign();
    expect(alertText()).toMatch(/^Not stored.*reason closed/);
    expect(has('Seal again')).toBe(true);
    expect(has('Sign with wallet')).toBe(false);
  });
});

describe('step 5: the chain is read before Fund, and a second bid is named first', () => {
  test('an account with a stored bid: the first click names it and asks for no quote; the second click signs seq = 1', async () => {
    m.readBids.mockResolvedValue({ height: 1, tsMs: 1, bids: [row(0)] });
    await connect(signer());
    await submitForm();
    expect(pageText()).toContain('You already have bid #0');
    expect(pageText()).toContain('This will be an additional bid');
    expect(m.balance).not.toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
    await click('Place an additional bid');
    await click('Seal in this browser');
    await click('Sign with wallet');
    expect(m.payload.mock.calls.at(-1)![0]).toMatchObject({ seq: 1, saltHex: '0a0b0c0d' });
  });
  test('no stored bid: seq is 0 and no confirmation is asked', async () => {
    await connect(signer());
    await submitForm();
    expect(pageText()).not.toContain('additional bid');
    await click('Seal in this browser');
    await click('Sign with wallet');
    expect(m.payload.mock.calls.at(-1)![0]).toMatchObject({ seq: 0 });
  });
  test('a failed chain read requests no quote and offers "Check again"', async () => {
    m.readBids.mockResolvedValue(null);
    m.balance.mockResolvedValue(0n);
    await connect(signer());
    await submitForm();
    expect(alertText()).toMatch(/could not be read/);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.balance).not.toHaveBeenCalled();
    m.readBids.mockResolvedValue({ height: 1, tsMs: 1, bids: [] });
    await click('Check again');
    expect(m.balance).toHaveBeenCalled();
  });
  test('the reload case: a stored bid, the balance spent, a new plan: named confirmation before any quote', async () => {
    m.readBids.mockResolvedValue({ height: 1, tsMs: 1, bids: [row(0)] });
    m.balance.mockResolvedValue(0n); // the escrow was spent by the stored bid
    await connect(signer());
    await submitForm();
    expect(m.quote).not.toHaveBeenCalled();
    expect(pageText()).toContain('You already have bid #0');
  });
  test('a pasted file sealed for seq 0 while the account has one bid stops before Fund and the wallet', async () => {
    m.readBids.mockResolvedValue({ height: 1, tsMs: 1, bids: [row(0)] });
    const s = signer();
    await connect(s);
    await click('Paste a sealed bid');
    child<{ onSubmit: (b: unknown) => void }>(PasteSealedBid)!.props.onSubmit({ ct: 'c', cm: 'cd'.repeat(32), escrow: 5_000_000n, origin: 'base', saltIgnored: false, signer: ME, seq: 0, intentsSalt: '0a0b0c0d' });
    await tick();
    expect(alertText()).toMatch(/sealed when you had 0 bid/);
    expect(m.balance).not.toHaveBeenCalled();
    expect(s.sign).not.toHaveBeenCalled();
  });
  test('a pasted file whose seq matches signs with that seq and the file salt', async () => {
    m.readBids.mockResolvedValue({ height: 1, tsMs: 1, bids: [row(0)] });
    await connect(signer());
    await click('Paste a sealed bid');
    child<{ onSubmit: (b: unknown) => void }>(PasteSealedBid)!.props.onSubmit({ ct: 'Y3Q=', cm: 'cd'.repeat(32), escrow: 5_000_000n, origin: 'base', saltIgnored: false, signer: ME, seq: 1, intentsSalt: 'deadbeef' });
    await tick();
    await click('Continue to signing');
    await click('Sign with wallet');
    expect(m.payload.mock.calls.at(-1)![0]).toMatchObject({ seq: 1, saltHex: 'deadbeef', cm: 'cd'.repeat(32) });
  });
});

describe('step 5: the read just before the wallet prompt', () => {
  test('the same sealed bid is already stored: shown, no wallet prompt', async () => {
    const s = signer();
    await connect(s);
    await submitForm();
    await click('Seal in this browser');
    const cm = (m.payload.mock.calls.at(-1)?.[0] as { cm?: string } | undefined)?.cm; // none yet; read the sealed cm from the page state through the read mock
    expect(cm).toBeUndefined();
    m.readForSign.mockImplementation(async () => ({ bids: [{ idx: 3, bidder: ME, cm: JSON.parse(mem.get(ticketKey(ticket()))!).cms[0] }], used: true }));
    await click('Sign with wallet');
    expect(s.sign).not.toHaveBeenCalled();
    expect(pageText()).toContain('Bid #3 stored');
  });
  test('the account has more bids than the plan seq: they are named and the wallet is not asked', async () => {
    const s = signer();
    await connect(s);
    await submitForm();
    await click('Seal in this browser');
    m.readForSign.mockResolvedValue({ bids: [row(2)], used: false });
    await click('Sign with wallet');
    expect(s.sign).not.toHaveBeenCalled();
    expect(pageText()).toContain('#2');
    expect(has('Make this an additional bid')).toBe(true);
    expect(has('Keep #2')).toBe(true);
  });
  test('a failed read on the first signature requests no prompt', async () => {
    const s = signer();
    await connect(s);
    await submitForm();
    await click('Seal in this browser');
    m.readForSign.mockResolvedValue(null);
    await click('Sign with wallet');
    expect(s.sign).not.toHaveBeenCalled();
    expect(alertText()).toMatch(/chain could not be read/i);
  });
});

describe('step 6: the saved ticket', () => {
  test('seal, sign, unavailable relay, remount and reconnect: the same bid at Sign, Fund and Seal hidden, the resolver running', async () => {
    await reachSign();
    expect([...mem.keys()].some((k) => k.startsWith('tender:ticket:v1:'))).toBe(true);
    m.settle.mockClear();
    rt.slots = []; // the tab reloads
    await connect(signer());
    expect(child(BidForm)).toBeUndefined();
    expect(has('Sign with wallet')).toBe(true);
    expect(has('Seal in this browser')).toBe(false);
    expect(has('Get a deposit address')).toBe(false);
    expect(m.settle).toHaveBeenCalled();
    expect(m.quote).not.toHaveBeenCalled();
  });
  test('the ticket holds no price, size, commitment salt or signature', async () => {
    await reachSign();
    const text = [...mem.values()].join('');
    expect(text).toContain('"cms"');
    expect(text).not.toMatch(/"(p|q|salt|signature|secret)":|"3600000"|"3000000"|secp256k1/);
  });
  test('a second wizard sharing the storage restores the first bid and offers no Seal', async () => {
    await reachSign();
    rt.slots = [];
    await connect(signer());
    expect(has('Seal in this browser')).toBe(false);
    expect(pageText()).toContain('Sign one transfer');
  });
  test('a second tab that already filled the form does not overwrite a live ticket: it shows the first tab bid', async () => {
    await connect(signer());
    await submitForm(); // tab 2 is at Seal, no ticket yet
    const first = ticket({ cms: ['cd'.repeat(32)], sent: false });
    seed(first); // tab 1 sealed and saved meanwhile
    await click('Seal in this browser');
    expect(JSON.parse(mem.get(ticketKey(first))!).cms).toEqual(['cd'.repeat(32)]);
    expect(has('Seal in this browser')).toBe(false);
    expect(has('Sign with wallet')).toBe(true);
  });
  test('a refunded bid found after a reload is cleared and does not lock the page: start over is offered', async () => {
    seed(ticket());
    m.settle.mockResolvedValue({ verdict: { kind: 'refunded', why: 'other' }, usedSeenMs: 1 });
    await connect(signer());
    expect(alertText()).toMatch(/^Not stored/);
    expect(mem.size).toBe(0);
    expect(has('Start over')).toBe(true);
    await click('Start over');
    expect(child(BidForm)).toBeDefined();
  });
  test('a signature that can never run (dead) frees Sign again and Start over', async () => {
    seed(ticket());
    m.settle.mockResolvedValue({ verdict: { kind: 'dead' }, usedSeenMs: null });
    await connect(signer());
    expect(has('Sign with wallet')).toBe(true);
    expect(pageText()).toContain('expired without running');
    expect(mem.size).toBe(0);
    await click('Start over');
    expect(child(BidForm)).toBeDefined();
  });
  test('a ticket of a sale with another creation time is not restored', async () => {
    seed(ticket({ saleCreatedNs: '1' }));
    await connect(signer());
    expect(child(BidForm)).toBeDefined();
    expect(m.settle).not.toHaveBeenCalled();
  });
  test('blocked storage: the page says it will not remember the bid, and everything else still works', async () => {
    const bad = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: bad, setItem: bad, removeItem: bad });
    await reachSign();
    expect(pageText()).toMatch(/will not keep this bid/);
    expect(has('Try the relayer again')).toBe(true);
  });
});
