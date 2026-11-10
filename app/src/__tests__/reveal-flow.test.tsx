import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildPayload, buildVersionedNonce, nep413Message, transferIntent, type MultiPayload } from '@tender/intents';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { rt, settle, textOf, walk } from './helpers/shallow';

// The reveal panel driven without a DOM through the shallow renderer in helpers/shallow.ts.
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

const m = vi.hoisted(() => ({ simulate: vi.fn(), relay: vi.fn(), addKey: vi.fn() }));
vi.mock('@tender/intents', async (orig) => ({ ...(await orig<typeof import('@tender/intents')>()), simulateIntents: m.simulate }));
vi.mock('../lib/relay', async (orig) => ({ ...(await orig<typeof import('../lib/relay')>()), relay: m.relay, pollBid: vi.fn(async () => 'unknown') }));
vi.mock('../lib/selfReveal', () => ({ buildSelfReveal: vi.fn(async () => ({ signer_id: 'x' })) }));
vi.mock('../lib/near-tx', async (orig) => ({ ...(await orig<typeof import('../lib/near-tx')>()), addIntentsKey: m.addKey }));
vi.mock('../components/WalletPicker', () => ({ WalletPicker: () => null }));

import { WalletPicker } from '../components/WalletPicker';
import { RevealPanel } from '../components/RevealPanel';
import { parseBid, parseSale } from '../lib/views';
import type { IntentSigner } from '../wallets/types';

const NS = 1_000_000_000n;
const NOW = 1_800_000_000n * NS;
const sale = { ...parseSale(sale1), revealDeadlineNs: NOW + 3600n * NS };
const bids = bids1.map(parseBid).map((b, i) => (i === 0 ? { ...b, bidder: 'bidder.near' } : b));
const decrypted = { keyOk: true, rows: [{ idx: 0, status: 'ok' as const, p: 3_600_000n, q: 3_000_000n, salt: '00'.repeat(16) }] };

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
const signerOf = (kind: 'near' | 'evm', id: string, mp: MultiPayload): IntentSigner => ({
  kind,
  signerId: id,
  origin: kind === 'near' ? 'near' : 'base',
  sign: vi.fn(async () => mp),
});

const render = (): ReactElement => {
  rt.i = 0;
  rt.effects = [];
  return RevealPanel({ sale, bids, decrypted, nowNs: NOW }) as ReactElement;
};
const buttons = () => [...walk(render())].filter((e) => e.type === 'button');
const button = (label: string) => buttons().find((b) => textOf(b)?.includes(label));
const click = async (label: string) => {
  await (button(label)!.props as { onClick: () => unknown }).onClick();
  await settle();
};
const connect = async (s: IntentSigner) => {
  [...walk(render())].find((e) => e.type === WalletPicker)!.props.onConnect(s);
  await settle();
};
const alertText = () =>
  [...walk(render())]
    .filter((e) => (e.props as { role?: string }).role === 'alert')
    .map((e) => textOf(e))
    .join(' ');

const NOT_REGISTERED = { ok: false, kind: 'public_key_not_registered', message: "public key 'ed25519:k' doesn't exist for account 'bidder.near'" };

beforeEach(() => {
  rt.slots = [];
  m.simulate.mockReset();
  m.relay.mockReset().mockResolvedValue({ txHash: 'H1' });
  m.addKey.mockReset().mockResolvedValue('HK');
});
afterEach(() => vi.unstubAllGlobals());

describe('gasless reveal with an unregistered NEAR key (QA-16)', () => {
  test('the panel offers the Register button, and registering re-simulates and relays', async () => {
    m.simulate.mockResolvedValueOnce(NOT_REGISTERED).mockResolvedValueOnce({ ok: true, report: {} });
    await connect(signerOf('near', 'bidder.near', nep413('bidder.near')));
    await click('Reveal my bid');
    expect(button('Register this key with NEAR Intents')).toBeDefined();
    await click('Register this key with NEAR Intents');
    expect(m.addKey).toHaveBeenCalledWith('ed25519:k');
    expect(m.relay).toHaveBeenCalledTimes(1);
    expect(button('Register this key with NEAR Intents')).toBeUndefined();
  });
  test('an EVM account that hits the same panic is told a different account signed, with no Register button', async () => {
    m.simulate.mockResolvedValue(NOT_REGISTERED);
    const evm: MultiPayload = { standard: 'erc191', payload: '{}', signature: 'secp256k1:x' };
    await connect(signerOf('evm', 'bidder.near', evm));
    await click('Reveal my bid');
    expect(button('Register this key')).toBeUndefined();
    expect(alertText()).toMatch(/different account/);
  });
  test('a NEAR wallet that is not the signer of the payload cannot register the key under its own account', async () => {
    m.simulate.mockResolvedValue(NOT_REGISTERED);
    await connect(signerOf('near', 'bidder.near', nep413('someone-else.near')));
    await click('Reveal my bid');
    expect(button('Register this key')).toBeUndefined();
  });
});

describe('a reveal that cannot be confirmed (QA-08)', () => {
  test('unreadable bids do not read as "Revealed on chain"', async () => {
    m.simulate.mockResolvedValue({ ok: true, report: {} });
    await connect(signerOf('near', 'bidder.near', nep413('bidder.near')));
    await click('Reveal my bid');
    const text = textOf(render());
    expect(text).toContain('Could not confirm');
    expect(text).not.toContain('Revealed on chain');
  });
});
