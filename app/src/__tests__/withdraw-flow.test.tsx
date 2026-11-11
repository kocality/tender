import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MultiPayload } from '@tender/intents';
import { rt, settle, textOf, walk } from './helpers/shallow';

// The withdraw page driven without a DOM through the shallow renderer in helpers/shallow.ts.
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const m = vi.hoisted(() => ({ simulate: vi.fn(), relay: vi.fn(), quote: vi.fn(), verdict: vi.fn(), follow: vi.fn() }));
vi.mock('@tender/intents', async (orig) => ({
  ...(await orig<typeof import('@tender/intents')>()),
  simulateIntents: m.simulate,
  mtBatchBalanceOf: vi.fn(async () => [5_000_000n, 0n, 0n]),
}));
vi.mock('../lib/relay', async (orig) => ({ ...(await orig<typeof import('../lib/relay')>()), relay: m.relay }));
vi.mock('../lib/oneclick', async (orig) => ({ ...(await orig<typeof import('../lib/oneclick')>()), quoteWithdraw: m.quote }));
vi.mock('../lib/bidPayload', () => ({ liveQuoteToken: vi.fn(async () => USDC) }));
vi.mock('../lib/chainClock', () => ({ useChainOffset: () => null }));
vi.mock('../lib/withdrawFlow', async (orig) => ({
  ...(await orig<typeof import('../lib/withdrawFlow')>()),
  buildWithdrawPayload: vi.fn(async () => ({ signer_id: 'x', nonce: 'bm9uY2U=', deadline: new Date(Date.now() + 600_000).toISOString() })),
  followWithdraw: m.follow,
  settleWithdraw: m.verdict,
}));
vi.mock('../components/WalletPicker', () => ({ WalletPicker: () => null }));

import { AmountField } from '../components/AmountField';
import { WalletPicker } from '../components/WalletPicker';
import { RelayError } from '../lib/relay';
import { Withdraw } from '../pages/Withdraw';
import type { IntentSigner } from '../wallets/types';

const ADDRESS = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
const signer = (id = ADDRESS): IntentSigner => ({
  kind: 'evm',
  signerId: id,
  origin: 'base',
  sign: vi.fn(async (): Promise<MultiPayload> => ({ standard: 'erc191', payload: '{}', signature: 'secp256k1:x' })),
});

const render = (): ReactElement => {
  rt.i = 0;
  return Withdraw() as ReactElement;
};
const buttons = () => [...walk(render())].filter((e) => e.type === 'button');
const button = (label: string) => buttons().find((b) => textOf(b)?.includes(label));
const has = (label: string) => button(label) !== undefined;
const click = async (label: string) => {
  const b = button(label);
  if (!b) throw new Error(`no button "${label}"; have: ${buttons().map((x) => textOf(x)).join(' | ')}`);
  await (b.props as { onClick: () => unknown }).onClick();
  await settle();
};
const connect = async (s: IntentSigner) => {
  [...walk(render())].find((e) => e.type === WalletPicker)!.props.onConnect(s);
  await settle();
};
const amountField = () => [...walk(render())].find((e) => e.type === AmountField)!.props as { disabled: boolean };

beforeEach(() => {
  rt.slots = [];
  m.simulate.mockReset().mockResolvedValue({ ok: true, report: {} });
  m.relay.mockReset().mockResolvedValue({ txHash: 'H1' });
  m.quote.mockReset().mockResolvedValue({ quote: { depositAddress: 'dep-1', amountIn: '5000000', amountOut: '4990000', minAmountOut: '4950000' } });
  m.verdict.mockReset().mockResolvedValue({ kind: 'pending', untilMs: Date.now() + 600_000 });
  m.follow.mockReset().mockResolvedValue({ status: 'SUCCESS' });
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('withdraw dead ends (QA-12)', () => {
  test('after the salt moved, "Sign again" is offered (the signed payload is dropped, not kept hidden)', async () => {
    m.simulate.mockResolvedValue({ ok: false, kind: 'invalid_salt', message: 'invalid salt' });
    await connect(signer());
    await click('Get quote');
    await click('Sign & withdraw');
    expect(has('Sign again')).toBe(true);
  });

  test('reconnecting after a signature re-enables the form instead of locking it for good', async () => {
    await connect(signer());
    await click('Get quote');
    await click('Sign & withdraw');
    expect(amountField().disabled).toBe(true); // signed: the form is locked
    await connect(signer('0x0000000000000000000000000000000000000002'));
    expect(amountField().disabled).toBe(false);
    expect(has('Get quote')).toBe(true);
  });
});

describe('a signed withdrawal is never signed or quoted again before the chain decides (DOUBLE-PLAN step 7, row 22)', () => {
  const reachUnclear = async () => {
    m.relay.mockRejectedValue(new RelayError('The relayer is not reachable.', 'unavailable'));
    await connect(signer());
    await click('Get quote');
    await click('Sign & withdraw');
  };
  test('an unreachable relayer after the signature: the chain is asked, the withdrawal may still land, no new withdrawal is offered', async () => {
    await reachUnclear();
    expect(m.verdict).toHaveBeenCalledTimes(1);
    expect(has('New withdrawal')).toBe(false);
    expect(has('Check the chain')).toBe(true);
    expect(has('Try the relayer again')).toBe(true);
    expect(has('Sign again')).toBe(false);
    expect(amountField().disabled).toBe(true);
  });
  test('the chain shows the withdrawal ran: 1Click is followed, no Sign again', async () => {
    m.verdict.mockResolvedValue({ kind: 'ran' });
    await reachUnclear();
    expect(m.follow).toHaveBeenCalledTimes(1);
    expect(has('Sign again')).toBe(false);
  });
  test('deadline_expired after a send goes to the resolver, not to "Sign again"', async () => {
    await reachUnclear();
    m.verdict.mockClear();
    m.verdict.mockResolvedValue({ kind: 'ran' });
    m.relay.mockRejectedValue(new RelayError('deadline has expired', 'deadline_expired'));
    await click('Try the relayer again');
    expect(m.verdict).toHaveBeenCalledTimes(1);
    expect(has('Sign again')).toBe(false);
  });
  test('the signature can never run any more (dead): Sign again and a new withdrawal are offered', async () => {
    m.verdict.mockResolvedValue({ kind: 'dead' });
    await reachUnclear();
    expect(has('Sign again')).toBe(true);
    expect(amountField().disabled).toBe(false);
  });
  test('a failed chain read leaves it undecided: only Check the chain and the same payload', async () => {
    m.verdict.mockResolvedValue({ kind: 'unknown' });
    await reachUnclear();
    expect(has('New withdrawal')).toBe(false);
    expect(has('Check the chain')).toBe(true);
  });
});
