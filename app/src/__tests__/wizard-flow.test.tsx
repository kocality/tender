import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { rt, runEffects, settle, textOf, walk } from './helpers/shallow';
import { MPC_DOMAIN2_PK } from '@tender/seal';
import type { MultiPayload } from '@tender/intents';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';

// The bid wizard driven without a DOM through the shallow renderer in helpers/shallow.ts.
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
}));
vi.mock('@tender/intents', async (orig) => ({
  ...(await orig<typeof import('@tender/intents')>()),
  simulateIntents: m.simulate,
  mtBalanceOf: m.balance,
}));
vi.mock('../lib/relay', async (orig) => ({ ...(await orig<typeof import('../lib/relay')>()), relay: m.relay, confirmBid: vi.fn(async () => null) }));
vi.mock('../lib/oneclick', async (orig) => ({ ...(await orig<typeof import('../lib/oneclick')>()), quoteDeposit: m.quote, getStatus: vi.fn() }));
vi.mock('../lib/bidPayload', () => ({ buildBidPayload: vi.fn(async () => ({ signer_id: 'x' })) }));
vi.mock('../lib/views', async (orig) => ({
  ...(await orig<typeof import('../lib/views')>()),
  getConfig: vi.fn(async () => ({ mpcPublicKey: MPC_DOMAIN2_PK.mainnet })),
}));
vi.mock('../components/WalletPicker', () => ({ WalletPicker: () => null }));

import { RelayError } from '../lib/relay';
import { parseBid, parseSale } from '../lib/views';
import { Wizard } from '../pages/Bid';
import { BidForm } from '../components/BidForm';
import { DepositBox } from '../components/DepositBox';
import { PasteSealedBid } from '../components/PasteSealedBid';
import { WalletPicker } from '../components/WalletPicker';
import type { IntentSigner } from '../wallets/types';

const NS = 1_000_000_000n;
const NOW = 1_800_000_000n * NS;
const sale = { ...parseSale(sale1), state: 'Open' as const, key: null, bids: 0, bidders: 0, escrowTotal: 0n, maxBids: 16, closeNs: NOW + 3600n * NS };
const bids = bids1.map(parseBid);

const signer = (id: string): IntentSigner => ({
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
  await settle();
};
const connect = async (s: IntentSigner) => {
  child<{ onConnect: (s: IntentSigner) => void }>(WalletPicker)!.props.onConnect(s);
  await settle();
};
const submitForm = async (B = 5_000_000n) => {
  child<{ onSubmit: (v: { p: bigint; q: bigint; B: bigint }) => void }>(BidForm)!.props.onSubmit({ p: 3_600_000n, q: 3_000_000n, B });
  await settle();
};
const alertText = () =>
  [...walk(render())]
    .filter((e) => (e.props as { role?: string }).role === 'alert')
    .map((e) => textOf(e))
    .join(' ');

beforeEach(() => {
  rt.slots = [];
  props = { id: '1', sale, bids, nowNs: NOW, synced: true, fundOnly: false };
  m.simulate.mockReset().mockResolvedValue({ ok: true, report: {} });
  m.balance.mockReset().mockResolvedValue(10_000_000n); // already funded: the wizard goes to Seal
  m.relay.mockReset().mockRejectedValue(new RelayError('The relayer is not reachable.', 'unavailable'));
  m.quote.mockReset();
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

/** Connect, fill the form, seal and sign: the relay then fails. */
async function reachRelayFailure(s: IntentSigner) {
  await connect(s);
  await submitForm();
  await click('Seal in this browser');
  await click('Sign with wallet');
}

describe('relay failure leaves a way out (QA-04)', () => {
  test('an unreachable relayer puts the wizard back at Sign with a retry button, not a dead end at "relay"', async () => {
    await reachRelayFailure(signer('0xaaa'));
    expect(has('Try the relayer again')).toBe(true);
    expect(has('Sign with wallet')).toBe(true); // the step is Sign again, not stuck at Relay
    expect(alertText()).toMatch(/not reachable/);
  });
});

describe('a used nonce means this signed bid already ran: no second signature for the same sealed bid', () => {
  test('the relayer answers nonce_used (an earlier relay landed): the wizard goes to the result, Sign is not offered', async () => {
    m.relay.mockRejectedValue(new RelayError('Smart contract panicked: nonce was already used', 'nonce_used'));
    await reachRelayFailure(signer('0xaaa'));
    expect(has('Sign with wallet')).toBe(false);
    expect(has('Sign again')).toBe(false);
    expect(has('Place another bid')).toBe(true);
  });
  test('the pre-flight simulation sees the nonce used: the same, and nothing is relayed', async () => {
    m.simulate.mockResolvedValue({ ok: false, kind: 'nonce_used', message: 'nonce was already used' });
    await reachRelayFailure(signer('0xaaa'));
    expect(has('Sign with wallet')).toBe(false);
    expect(has('Place another bid')).toBe(true);
    expect(m.relay).not.toHaveBeenCalled();
  });
});

describe('reconnecting starts over (QA-13)', () => {
  test("the old account's signed payload, retry and error are gone after another wallet connects", async () => {
    await reachRelayFailure(signer('0xaaa'));
    expect(has('Try the relayer again')).toBe(true);
    await connect(signer('0xbbb'));
    expect(has('Try the relayer again')).toBe(false);
    expect(has('Sign with wallet')).toBe(false);
    expect(alertText()).toBe('');
    expect([...walk(render())].some((e) => e.type === 'details')).toBe(false); // no stale "Signed payload"
    expect(child(BidForm)).toBeDefined(); // back at the form
  });
  test('a finished bid offers "Place another bid", which returns to the form', async () => {
    m.relay.mockResolvedValue({ txHash: 'H1' });
    await reachRelayFailure(signer('0xaaa'));
    expect(has('Place another bid')).toBe(true);
    await click('Place another bid');
    expect(child(BidForm)).toBeDefined();
    expect(has('Place another bid')).toBe(false);
  });
});

describe('a bid is only started while the sale can take it (QA-03, X12-02 time, X12-04 tabs)', () => {
  test('a form submitted 30 s before close does not leave the bid step', async () => {
    props = { ...props, nowNs: sale.closeNs - 30n * NS };
    await connect(signer('0xaaa'));
    await submitForm();
    expect(alertText()).toMatch(/under 60 seconds/);
    expect(child(BidForm)).toBeDefined();
    expect(m.balance).not.toHaveBeenCalled();
  });
  test('a pasted bid for a sale that is full is refused before any deposit', async () => {
    props = { ...props, sale: { ...sale, bids: 16 } };
    await connect(signer('0xaaa'));
    await click('Paste a sealed bid');
    child<{ onSubmit: (b: unknown) => void }>(PasteSealedBid)!.props.onSubmit({ ct: 'c', cm: 'd', escrow: 5_000_000n, origin: 'base', saltIgnored: false, signer: '0xaaa' });
    await settle();
    expect(alertText()).toMatch(/maximum of 16/);
    expect(m.balance).not.toHaveBeenCalled();
  });
  test('the Seal button is disabled once the sale is about to close', async () => {
    await connect(signer('0xaaa'));
    await submitForm();
    expect((button('Seal in this browser')!.props as { disabled: boolean }).disabled).toBe(false);
    props = { ...props, nowNs: sale.closeNs - 20n * NS }; // the clock ticks on
    expect((button('Seal in this browser')!.props as { disabled: boolean }).disabled).toBe(true);
  });
});

describe('a sale that closes while the bid is under way (QA-03)', () => {
  test('the result of a finished bid stays on screen when the sale is opened; a fresh visit sees only the note', async () => {
    m.relay.mockResolvedValue({ txHash: 'H1' });
    await reachRelayFailure(signer('0xaaa'));
    expect(has('Place another bid')).toBe(true);
    props = { ...props, sale: { ...sale, state: 'Keyed' } };
    expect(has('Place another bid')).toBe(true);
    await click('Place another bid'); // back at the bid step: nothing left to do on a Keyed sale
    expect(textOf(render())).toContain('no longer takes bids');
    expect(child(BidForm)).toBeUndefined();
  });
});

describe('the first quote failing is not a dead end (QA-09)', () => {
  test('after a failed quote, "Get a deposit address" asks again and leads to the deposit box', async () => {
    m.balance.mockResolvedValue(0n);
    m.quote
      .mockRejectedValueOnce(new Error('1Click 429'))
      .mockResolvedValueOnce({ quote: { depositAddress: 'dep-1', amountIn: '5100000', amountOut: '5000000', minAmountOut: '5000000' } });
    await connect(signer('0xaaa'));
    await submitForm();
    expect(has('Get a deposit address')).toBe(true);
    expect(child(DepositBox)).toBeUndefined();
    await click('Get a deposit address');
    expect(child<{ quote: { quote: { depositAddress: string } } }>(DepositBox)!.props.quote.quote.depositAddress).toBe('dep-1');
    expect(m.quote).toHaveBeenCalledTimes(2);
  });
});

describe('the funding poll does not walk into a bid that cannot be sent (X12-04 tabs)', () => {
  const funding = async () => {
    const oneclick = await import('../lib/oneclick');
    vi.mocked(oneclick.getStatus).mockResolvedValue({ status: 'PENDING_DEPOSIT' });
    m.balance.mockResolvedValue(0n);
    m.quote.mockResolvedValue({ quote: { depositAddress: 'dep-1', amountIn: '5100000', amountOut: '5000000', minAmountOut: '5000000' } });
    await connect(signer('0xaaa'));
    await submitForm();
    expect(child(DepositBox)).toBeDefined(); // step: fund
    m.balance.mockResolvedValue(10_000_000n); // the deposit lands
  };
  const poll = async () => {
    render();
    const cleanups = runEffects();
    await settle();
    cleanups.forEach((c) => typeof c === 'function' && c());
  };

  test('a deposit that lands while the sale is open advances to Seal', async () => {
    await funding();
    await poll();
    expect(has('Seal in this browser')).toBe(true);
  });
  test('a deposit that lands after the sale stopped taking bids stays at Fund, with the reason shown', async () => {
    await funding();
    props = { ...props, nowNs: sale.closeNs + 120n * NS };
    await poll();
    expect(has('Seal in this browser')).toBe(false);
    expect(textOf(render())).toContain('closed');
  });
});

describe('a reload during funding keeps the deposit address (QA-10)', () => {
  test('after a remount the stored quote is shown and 1Click is not asked for a second address', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    m.balance.mockResolvedValue(0n);
    m.quote.mockResolvedValue({ quote: { depositAddress: 'dep-1', amountIn: '5110000', amountOut: '5000000', minAmountOut: '5000000', deadline: new Date(Date.now() + 3_600_000).toISOString() } });
    await connect(signer('0xaaa'));
    await submitForm();
    expect(m.quote).toHaveBeenCalledTimes(1);
    // the tab reloads: a fresh wizard, the same account and bid
    rt.slots = [];
    await connect(signer('0xaaa'));
    await submitForm();
    expect(m.quote).toHaveBeenCalledTimes(1);
    expect(child<{ quote: { quote: { depositAddress: string } } }>(DepositBox)!.props.quote.quote.depositAddress).toBe('dep-1');
  });
  test('a quote whose swap has ended is never paid into again: the next bid asks for a new address', async () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    m.balance.mockResolvedValue(0n);
    m.quote.mockResolvedValue({ quote: { depositAddress: 'dep-1', amountIn: '5100000', amountOut: '5000000', minAmountOut: '5000000', deadline: new Date(Date.now() + 3_600_000).toISOString() } });
    await connect(signer('0xaaa'));
    await submitForm();
    mem.clear(); // what the status poll does when the swap reaches a final status
    rt.slots = [];
    await connect(signer('0xaaa'));
    await submitForm();
    expect(m.quote).toHaveBeenCalledTimes(2);
  });
});

describe('the browser seals only to the pinned key (QA-01)', () => {
  test('a get_config that reports another key stops Seal: nothing is sealed, the user sees why', async () => {
    const views = await import('../lib/views');
    vi.mocked(views.getConfig).mockResolvedValueOnce({ mpcPublicKey: 'bls12381g2:Attacker' } as never);
    await connect(signer('0xaaa'));
    await submitForm();
    await click('Seal in this browser');
    expect(alertText()).toMatch(/not the pinned/);
    expect(has('Sign with wallet')).toBe(false);
  });
});

describe('focus, announcements and leaving the page (X12A-01, QA-18, QA-10)', () => {
  const focused: string[] = [];
  const fakeRoot = () => {
    const slot = rt.slots.find((x) => typeof x === 'object' && x !== null && 'current' in x && (x as { current: unknown }).current === null) as { current: unknown };
    slot.current = {
      querySelector: (sel: string) => ({
        focus: () => void focused.push(sel),
      }),
    };
  };

  test('a step change moves focus to the new section heading, but the first mount does not', async () => {
    focused.length = 0;
    render();
    fakeRoot();
    runEffects(); // mount
    expect(focused).toEqual([]);
    await connect(signer('0xaaa'));
    render();
    runEffects(); // step: bid
    await submitForm();
    render();
    runEffects(); // step: seal
    expect(focused.at(-1)).toBe('[data-step="seal"] h2');
    await click('Seal in this browser');
    render();
    runEffects();
    expect(focused.at(-1)).toBe('[data-step="sign"] h2');
  });

  test('the error appears inside the section of the step that failed, next to its button', async () => {
    await reachRelayFailure(signer('0xaaa'));
    const sign = [...walk(render())].find((e) => (e.props as { 'data-step'?: string })['data-step'] === 'sign')!;
    expect([...walk(sign)].some((e) => (e.props as { role?: string }).role === 'alert')).toBe(true);
  });

  test('a status region is always present and says what happens', async () => {
    const live = () => [...walk(render())].find((e) => (e.props as { role?: string }).role === 'status' && e.type === 'div')!;
    expect(textOf(live())).toBe('');
    await connect(signer('0xaaa'));
    await submitForm();
    expect(textOf(live())).toContain('Seal');
  });

  test('reload protection is armed from the funding step on, and only then', async () => {
    const added: string[] = [];
    vi.stubGlobal('window', { addEventListener: (t: string) => added.push(t), removeEventListener: () => {} });
    await connect(signer('0xaaa'));
    render();
    runEffects();
    expect(added).not.toContain('beforeunload'); // the bid form
    await submitForm();
    await click('Seal in this browser');
    render();
    runEffects(); // step: sign
    expect(added).toContain('beforeunload');
  });
});
