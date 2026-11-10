import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildPayload, buildVersionedNonce, fromHex, nep413Message, transferIntent, type MultiPayload } from '@tender/intents';
import { commitmentHex } from '@tender/seal';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { rt, settle, textOf, walk } from './helpers/shallow';

// The reveal panel driven without a DOM through the shallow renderer in helpers/shallow.ts.
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>();
  const { shallowHooks } = await import('./helpers/shallow');
  return { ...actual, default: actual, ...shallowHooks };
});

const m = vi.hoisted(() => ({ simulate: vi.fn(), relay: vi.fn(), addKey: vi.fn(), revealBatch: vi.fn(), getBids: vi.fn(), pollBid: vi.fn() }));
vi.mock('@tender/intents', async (orig) => ({ ...(await orig<typeof import('@tender/intents')>()), simulateIntents: m.simulate }));
vi.mock('../lib/relay', async (orig) => ({ ...(await orig<typeof import('../lib/relay')>()), relay: m.relay, pollBid: m.pollBid }));
const buildSelfReveal = vi.hoisted(() => vi.fn(async (_o: { items: { idx: number }[] }) => ({ signer_id: 'x' })));
vi.mock('../lib/selfReveal', () => ({ buildSelfReveal }));
vi.mock('../lib/near-tx', async (orig) => ({ ...(await orig<typeof import('../lib/near-tx')>()), addIntentsKey: m.addKey, revealBatch: m.revealBatch }));
vi.mock('../lib/views', async (orig) => ({ ...(await orig<typeof import('../lib/views')>()), getAllBids: m.getBids }));
vi.mock('../wallets/near', async (orig) => ({ ...(await orig<typeof import('../wallets/near')>()), ensureNear: vi.fn(async () => {}) }));
vi.mock('../components/WalletPicker', () => ({ WalletPicker: () => null }));

import { WalletPicker } from '../components/WalletPicker';
import { RevealPanel } from '../components/RevealPanel';
import { config } from '../config';
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

let ctx = { bids, decrypted };
const render = (): ReactElement => {
  rt.i = 0;
  rt.effects = [];
  return RevealPanel({ sale, bids: ctx.bids, decrypted: ctx.decrypted, nowNs: NOW }) as ReactElement;
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
  ctx = { bids, decrypted };
  buildSelfReveal.mockClear();
  m.revealBatch.mockReset().mockResolvedValue('HR');
  m.getBids.mockReset();
  m.pollBid.mockReset().mockResolvedValue('unknown');
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

/** n sealed bids of one bidder with decrypted rows that open them. */
const manyBids = (n: number, bidder = 'bidder.near') => {
  const list = Array.from({ length: n }, (_, idx) => ({ ...bids[0]!, idx, bidder, state: 'Sealed' as const, escrow: 5_000_000n }));
  const rows = list.map((b) => ({ idx: b.idx, status: 'ok' as const, p: 3_600_000n, q: 3_000_000n, salt: '00'.repeat(16) }));
  return { bids: list, decrypted: { keyOk: true, rows } };
};

describe('Reveal my bids is chunked to 8 per signed transfer (X12-05 tabs)', () => {
  test('9 own bids are signed as two transfers of 8 and 1, and both are relayed', async () => {
    ctx = manyBids(9);
    m.simulate.mockResolvedValue({ ok: true, report: {} });
    m.pollBid.mockResolvedValue({ idx: 0 });
    const signer = signerOf('evm', 'bidder.near', { standard: 'erc191', payload: '{}', signature: 'secp256k1:x' });
    await connect(signer);
    await click('Reveal my bids (gasless) · 9');
    expect(buildSelfReveal.mock.calls.map(([o]) => o.items.length)).toEqual([8, 1]);
    expect(signer.sign).toHaveBeenCalledTimes(2);
    expect(m.relay).toHaveBeenCalledTimes(2);
    expect(buildSelfReveal.mock.calls.flatMap(([o]) => o.items.map((i) => i.idx))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
  test('when a chunk is refused the next one is not signed', async () => {
    ctx = manyBids(9);
    m.simulate.mockResolvedValue({ ok: true, report: {} });
    m.pollBid.mockResolvedValue(null); // the contract refunded chunk 1
    const signer = signerOf('evm', 'bidder.near', { standard: 'erc191', payload: '{}', signature: 'secp256k1:x' });
    await connect(signer);
    await click('Reveal my bids (gasless)');
    expect(signer.sign).toHaveBeenCalledTimes(1);
  });
});

describe('Reveal all re-reads the bids before every batch (X12-01 tabs)', () => {
  test('bids revealed elsewhere while batch 1 waited for the wallet are not sent again', async () => {
    ctx = manyBids(10);
    const all = (revealedFrom: number) => ctx.bids.map((b) => ({ ...b, state: b.idx >= revealedFrom ? ('Revealed' as const) : ('Sealed' as const) }));
    m.getBids.mockResolvedValueOnce(all(99)).mockResolvedValueOnce(all(8)); // the keeper revealed 8 and 9 meanwhile
    m.addKey.mockReset();
    await click('Reveal all (NEAR wallet, gas)');
    expect(m.revealBatch.mock.calls.map(([, items]) => items.map((i: { idx: number }) => i.idx))).toEqual([[0, 1, 2, 3, 4, 5, 6, 7]]);
    expect(textOf(render())).toContain('Batch 2 of 2: already revealed by someone else, skipped.');
  });
  test('a transaction that failed on chain stops the loop and is shown as an error, never as "sent"', async () => {
    ctx = manyBids(10);
    m.getBids.mockResolvedValue(ctx.bids);
    m.revealBatch.mockRejectedValue(new Error('The transaction failed on chain: panicked'));
    await click('Reveal all (NEAR wallet, gas)');
    expect(m.revealBatch).toHaveBeenCalledTimes(1);
    expect(alertText()).toContain('failed on chain');
    expect(textOf(render())).not.toContain('sent (');
  });
});

describe('Reveal from my bid file (X12-02 storage)', () => {
  const bidderId = 'bidder.near';
  const salt = 'ab'.repeat(16);
  const sealedBid = (idx: number, p: bigint, q: bigint) => ({ ...bids[0]!, idx, bidder: bidderId, state: 'Sealed' as const, escrow: 5_000_000n, cm: commitmentHex({ sale: BigInt(sale.id), bidder: bidderId, B: 5_000_000n, p, q, salt: fromHex(salt) }) });
  const fileFor = (idx: number, p: bigint, q: bigint) => JSON.stringify({ sale: sale.id, contract: config.tenderContractId, network: config.network, signer: bidderId, cm: sealedBid(idx, p, q).cm, p: p.toString(), q: q.toString(), salt });
  const paste = async (text: string) => {
    ([...walk(render())].find((e) => e.type === 'textarea')!.props as { onChange: (ev: { target: { value: string } }) => void }).onChange({ target: { value: text } });
    await settle();
  };

  test('a bid that cannot be decrypted is revealed from its file, with the NEAR wallet', async () => {
    ctx = { bids: [sealedBid(3, 3_600_000n, 3_000_000n)], decrypted: { keyOk: true, rows: [{ idx: 3, status: 'invalid_ct' as const }] } };
    m.getBids.mockResolvedValue(ctx.bids);
    expect(button('Reveal file bids (NEAR wallet, gas)')!.props.disabled).toBe(true);
    await paste(fileFor(3, 3_600_000n, 3_000_000n));
    expect(button('Reveal file bids (NEAR wallet, gas)')!.props.disabled).toBe(false);
    await click('Reveal file bids (NEAR wallet, gas)');
    expect(m.revealBatch).toHaveBeenCalledWith(sale.id, [{ idx: 3, p: '3600000', q: '3000000', salt }]);
  });
  test('the gasless path signs the file bids of the connected account', async () => {
    ctx = { bids: [sealedBid(3, 3_600_000n, 3_000_000n)], decrypted: { keyOk: false, rows: [] } };
    m.simulate.mockResolvedValue({ ok: true, report: {} });
    await connect(signerOf('evm', bidderId, { standard: 'erc191', payload: '{}', signature: 'secp256k1:x' }));
    await paste(fileFor(3, 3_600_000n, 3_000_000n));
    await click('Reveal file bids (gasless)');
    expect(buildSelfReveal.mock.calls[0]![0].items).toEqual([{ idx: 3, p: '3600000', q: '3000000', salt }]);
  });
  test('a file that does not open its bid shows why and offers nothing', async () => {
    ctx = { bids: [sealedBid(3, 3_600_000n, 3_000_000n)], decrypted: { keyOk: true, rows: [] } };
    await paste(fileFor(3, 3_600_001n, 3_000_000n)); // wrong p: its cm matches no bid
    expect(textOf(render())).toContain('matches no bid');
    expect(button('Reveal file bids (NEAR wallet, gas)')!.props.disabled).toBe(true);
  });
});
