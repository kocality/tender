import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import sale1f from '../__fixtures__/views/sale-1-finalized.json';
import config1 from '../__fixtures__/views/config.json';
import { AmountField } from '../components/AmountField';
import { BidForm } from '../components/BidForm';
import { CopyButton } from '../components/CopyButton';
import { DepositBox, quoteLapsed, remainingText } from '../components/DepositBox';
import { Loading } from '../components/Feedback';
import { OpenPanel } from '../components/OpenPanel';
import { RevealPanel } from '../components/RevealPanel';
import { SaleCard } from '../components/SaleCard';
import { StepList } from '../components/StepList';
import { SupplyDemandChart } from '../components/SupplyDemandChart';
import { shouldReconnectOnOrigin, WalletPicker } from '../components/WalletPicker';
import { parseBid, parseConfig, parseSale } from '../lib/views';
import type { KeysData, SaleBundle } from '../lib/loaders';
import type { QuoteResponse, StatusResponse } from '../lib/oneclick';
import { withdrawMessages } from '../lib/withdrawFlow';
import { BidView } from '../pages/Bid';
import { KeysView } from '../pages/Keys';
import { SaleView } from '../pages/Sale';
import { HomeView } from '../pages/Home';
import { TwinView } from '../pages/Twin';

afterEach(() => vi.unstubAllGlobals());

const keyed = parseSale(sale1);
const cancelled = parseSale(sale0);
const bids = bids1.map(parseBid);
const cfg = parseConfig(config1);
const NOW = keyed.closeNs + 60_000_000_000n;
const open = { ...keyed, state: 'Open' as const, key: null, bids: 1, closeNs: NOW + 3_600_000_000_000n };
const bundle = (sale: typeof keyed): SaleBundle => ({ id: sale.id, sale, bids });
const h1s = (html: string) => html.split('<h1').length - 1;
/** renderToString separates adjacent text nodes with comments; tests read the text as a user does. */
const text = (html: string) => html.replace(/<!-- -->/g, '');

describe('bid page after the form (QA-03, X12-04 tabs)', () => {
  const view = (sale: typeof keyed, nowNs = NOW) => renderToString(<BidView id="1" data={bundle(sale)} error={null} loading={false} nowNs={nowNs} synced fundOnly={false} />);
  test('a Cancelled or Keyed sale hides the wizard: no wallet, seal or paste controls', () => {
    for (const sale of [cancelled, keyed]) {
      const html = view(sale);
      expect(html).toContain('no longer takes bids');
      expect(html).not.toContain('Seal here');
      expect(html).not.toContain('Paste a sealed bid');
      expect(html).not.toContain('Seal in this browser');
      expect(html).not.toContain('Sign with wallet');
    }
  });
  test('a sale past its close time that nobody opened yet shows no wallet step, and points to the sale page instead', () => {
    const closed = { ...open, closeNs: NOW - 60_000_000_000n };
    const html = text(view(closed));
    expect(html).toContain('This sale is closed; it no longer takes bids.');
    expect(html).toContain('href="#/sale/1"');
    expect(html).toContain('href="#/try"');
    expect(html).not.toContain('Seal here');
    expect(html).not.toContain('Connect your wallet');
  });
  test('an open sale shows its close time, a countdown, the reveal window and the seller', () => {
    const html = text(view(open));
    expect(html).toContain('Seal here');
    expect(html).toContain('class="countdown"');
    expect(html).toContain('closes 20');
    expect(html).toContain('at least 24 hours');
    expect(html).toContain('Seller');
  });
  test('the page has exactly one h1', () => {
    expect(h1s(view(open))).toBe(1);
  });
});

describe('seller and units on the sale card (SC-02, X12-02 numbers)', () => {
  test('the seller is shown, and a team seller is labelled as a team-funded demo sale', () => {
    const html = renderToString(<SaleCard id="1" sale={keyed} nowNs={NOW} />);
    expect(html).toContain('tenderseal.near');
    expect(html).toContain('team-funded demo sale');
    const other = renderToString(<SaleCard id="1" sale={{ ...keyed, seller: 'someone.near' }} nowNs={NOW} />);
    expect(other).toContain('someone.near');
    expect(other).not.toContain('team-funded');
  });
  test('the reserve carries its per-lot unit (sale #2 reads "per 1,000 JAMBO")', () => {
    const jambo = { ...keyed, token: 'nep141:jambo-1679.meme-cooking.near', lotExp: 3, reserve: 174_000n, decimals: 18 };
    const html = text(renderToString(<SaleCard id="2" sale={jambo} nowNs={NOW} />));
    expect(html).toMatch(/minimum price \(reserve\) 0\.174 USDC per 1,000 JAMBO/);
    expect(html).toContain('jambo-1679.meme-cooking.near'); // the full token id stays on the card
  });
  test('the twin view notes that the demo sale 0 was configured to miss its thresholds', () => {
    const html = renderToString(<TwinView bundles={[bundle(keyed), { ...bundle(cancelled), id: '0' }]} nowNs={NOW} />);
    expect(html).toContain('configured by us to miss its open thresholds');
    expect(html.split('configured by us').length - 1).toBe(1);
  });
  test('twin controls are named per sale', () => {
    const html = renderToString(
      <TwinView bundles={[bundle({ ...open, id: '1' }), bundle({ ...open, id: '0' })]} nowNs={NOW + 4_000_000_000_000n} />,
    );
    expect(html).toContain('Open sale page, sale 1');
    expect(html).toContain('Open sale page, sale 0');
  });
});

describe('every page has one h1 (X12A-07)', () => {
  test('sale, twin and key ledger pages', () => {
    expect(h1s(renderToString(<SaleView bundle={bundle(keyed)} nowNs={NOW} cfg={cfg} />))).toBe(1);
    expect(h1s(renderToString(<SaleView bundle={{ id: '9', sale: null, bids: [] }} nowNs={NOW} cfg={cfg} />))).toBe(1);
    // The twin sales are a section of the home page now; the page's one h1 is the hero's.
    expect(h1s(renderToString(<TwinView bundles={[bundle(keyed), bundle(cancelled)]} nowNs={NOW} />))).toBe(0);
    expect(h1s(renderToString(<HomeView data={[bundle(keyed), bundle(cancelled)]} error={null} loading={false} nowNs={NOW} />))).toBe(1);
    expect(h1s(renderToString(<HomeView data={null} error={null} loading nowNs={NOW} />))).toBe(1);
    const data: KeysData = { mpc: 'v1.signer', mpcVersion: '3.18.0', rows: [], receipts: [], sales: [keyed] };
    expect(h1s(renderToString(<KeysView data={data} />))).toBe(1);
  });
});

describe('step list (X12A-02, X12A-09)', () => {
  test('a refunded bid does not claim "Bid stored" for the current step', () => {
    const html = renderToString(<StepList current="done" failed />);
    expect(html).toContain('Not stored');
    expect(html).not.toContain('Bid stored');
    expect(renderToString(<StepList current="done" failed doneLabel="Not confirmed" />)).toContain('Not confirmed');
    expect(renderToString(<StepList current="done" />)).toContain('Bid stored');
  });
  test('finished steps say so in text, not by colour alone', () => {
    const html = renderToString(<StepList current="seal" />);
    expect(html.split('(done)').length - 1).toBe(3);
  });
});

describe('live regions are mounted before they speak (X12A-04)', () => {
  test('the open panel has an empty status region before any action', () => {
    const html = renderToString(<OpenPanel sale={open} nowNs={NOW} />);
    expect(html).toMatch(/<div role="status"><\/div>/);
  });
  test('the reveal panel has an empty status region, with the log written into it', () => {
    const html = renderToString(<RevealPanel sale={keyed} bids={bids} decrypted={null} nowNs={NOW} />);
    expect(html).toMatch(/<div role="status"><\/div>/);
  });
  test('copy feedback has a status span, and the loading placeholder is not aria-busy', () => {
    expect(renderToString(<CopyButton text="x" />)).toMatch(/role="status"/);
    expect(renderToString(<Loading what="sale" />)).not.toContain('aria-busy');
  });
});

describe('deposit box (QA-11, X12A-06, X12-04 numbers)', () => {
  const quote = (deadline: string, minAmountOut = '3000000'): QuoteResponse => ({
    quote: { depositAddress: 'deposit-addr-1', amountIn: '3080000', amountOut: '3030000', minAmountOut, deadline },
  });
  const pending: StatusResponse = { status: 'PENDING_DEPOSIT' };
  const noop = () => {};
  test('an expired quote with the PENDING_DEPOSIT status offers a new quote and hides the address', () => {
    const html = renderToString(<DepositBox origin="base" quote={quote(new Date(Date.now() - 1000).toISOString())} status={pending} onSubmitTx={noop} onNewQuote={noop} />);
    expect(html).toContain('Get a new quote');
    expect(html).not.toContain('deposit-addr-1');
  });
  test('a live quote keeps its address and offers no new quote', () => {
    const html = renderToString(<DepositBox origin="base" quote={quote(new Date(Date.now() + 3_600_000).toISOString())} status={pending} onSubmitTx={noop} onNewQuote={noop} />);
    expect(html).toContain('deposit-addr-1');
    expect(html).not.toContain('Get a new quote');
  });
  test('a deposit under way (PROCESSING) is not lapsed even past the deadline', () => {
    expect(quoteLapsed('expired', { status: 'PROCESSING' })).toBe(false);
    expect(quoteLapsed('expired', null)).toBe(true);
    expect(quoteLapsed('expired', pending)).toBe(true);
    expect(quoteLapsed('3h 2m', pending)).toBe(false);
  });
  test('a 72-hour window is written as days, hours and minutes, not "4319:59"', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    expect(remainingText('2026-11-16T00:00:00Z', now)).toBe('3d 0h 0m');
    expect(remainingText('2026-11-16T00:29:30Z', now)).toBe('3d 0h 29m');
    expect(remainingText('2026-11-13T03:20:00Z', now)).toBe('3h 20m');
    expect(remainingText('2026-11-13T00:12:05Z', now)).toBe('12:05');
    expect(remainingText('2026-11-12T23:59:00Z', now)).toBe('expired');
  });
  test('the tx-hash input is named by its visible label, and the label holds one control', () => {
    const html = renderToString(<DepositBox origin="base" quote={quote(new Date(Date.now() + 3_600_000).toISOString())} status={null} onSubmitTx={noop} onNewQuote={noop} />);
    expect(html).toContain('<label for="deposit-tx">Optional: paste your transaction hash to speed up detection</label>');
    expect(html).toContain('id="deposit-tx"');
    expect(html).not.toContain('aria-label="Deposit transaction hash"');
    expect(html).not.toMatch(/<label[^>]*>[^<]*<span[^>]*>[^<]*<input/);
  });
  test('a quote whose guaranteed minimum is short of what the account needs warns', () => {
    const live = new Date(Date.now() + 3_600_000).toISOString();
    const warn = renderToString(<DepositBox origin="base" quote={quote(live, '2990000')} status={null} need={3_000_001n} onSubmitTx={noop} onNewQuote={noop} />);
    expect(text(warn)).toContain('guarantees only 2.99 USDC');
    const fine = renderToString(<DepositBox origin="base" quote={quote(live, '3050000')} status={null} need={3_000_001n} onSubmitTx={noop} onNewQuote={noop} />);
    expect(fine).not.toContain('guarantees only');
  });
});

describe('amount field (X12A-06)', () => {
  test('the input is named "Amount (USDC)" and the "All" button is outside the label', () => {
    const html = renderToString(<AmountField id="amt" label="Amount (USDC)" value="" disabled={false} onChange={() => {}} onAll={() => {}} />);
    expect(html).toContain('<label for="amt">Amount (USDC)</label>');
    expect(html).not.toMatch(/<label[^>]*>[^<]*<span[^>]*>[^<]*<input/);
    expect(html).toContain('>All</button>');
  });
  test('an empty amount says what is missing', () => {
    expect(withdrawMessages({ ok: false, errors: ['Amount: Enter a number such as 3.6', 'Recipient: Enter the recipient address.'] }, '')[0]).toBe('Enter an amount to withdraw.');
    expect(withdrawMessages({ ok: false, errors: ['Amount is above your Intents balance of this token.'] }, '5')).toEqual(['Amount is above your Intents balance of this token.']);
  });
});

describe('bid form fields (X12A-05)', () => {
  test('inputs carry ids a label and an error can point at, and the escrow field says it is public', () => {
    const html = renderToString(<BidForm sale={open} nowNs={NOW} disabled={false} onSubmit={() => {}} />);
    for (const f of ['price', 'size', 'escrow']) expect(html).toContain(`id="bid-${f}"`);
    expect(html).toContain('(public; at least 1)');
    expect(html).toContain('placeholder="5"'); // escrow and size no longer both suggest 3
  });
});

describe('reveal, finalize and config retry (QA-14, QA-17)', () => {
  const closed = { ...keyed, revealDeadlineNs: NOW - 1_000_000_000n };
  const live = { ...keyed, revealDeadlineNs: NOW + 3_600_000_000_000n };
  test('after the reveal deadline the panel offers Finalize instead of "only finalize is left"', () => {
    const html = text(renderToString(<RevealPanel sale={closed} bids={bids} decrypted={null} nowNs={NOW} />));
    expect(html).toContain('Finalize (anyone)');
    expect(html).toContain('Reveal deadline');
    expect(html).toContain('passed');
    expect(html).not.toContain('Only finalize is left');
  });
  test('before the deadline it shows the deadline and the time left, and no Finalize', () => {
    const html = text(renderToString(<RevealPanel sale={live} bids={bids} decrypted={null} nowNs={NOW} />));
    expect(html).toMatch(/Reveal deadline 20\d\d-\d\d-\d\d \d\d:\d\d:\d\d UTC · \d\d:\d\d:\d\d left/);
    expect(html).not.toContain('Finalize (anyone)');
  });
  test('when every bid is revealed Finalize is offered before the deadline too', () => {
    const html = renderToString(<RevealPanel sale={{ ...live, revealed: live.bids }} bids={bids} decrypted={null} nowNs={NOW} />);
    expect(html).toContain('Finalize (anyone)');
  });
  test('a failed config read says so and offers Retry instead of a silently disabled Decrypt', () => {
    const html = renderToString(<SaleView bundle={bundle(keyed)} nowNs={NOW} cfg={null} cfgError="Failed to fetch" onRetryCfg={() => {}} />);
    expect(html).toContain('Config not loaded');
    expect(html).toContain('Retry');
  });
  test('a loaded config shows no such message', () => {
    expect(renderToString(<SaleView bundle={bundle(keyed)} nowNs={NOW} cfg={cfg} />)).not.toContain('Config not loaded');
  });
  test('a finalized sale page still renders (fixture check)', () => {
    expect(text(renderToString(<SaleView bundle={bundle(parseSale(sale1f))} nowNs={NOW} cfg={cfg} />))).toContain('Sale #1');
  });
});

describe('chart (QA-18, X12A-09)', () => {
  test('its label carries the reserve, and the demand line is named and in the legend', () => {
    const html = renderToString(<SupplyDemandChart sale={keyed} bids={bids.map((b) => ({ ...b, state: 'Revealed' as const, p: 3_600_000n, q: 3_000_000n }))} pStar={3_000_000n} />);
    expect(html).toMatch(/aria-label="[^"]*reserve [^"]*"/);
    expect(html).toContain('>demand<');
    expect(html).toContain('chart-legend');
  });
});

describe('wallet picker origin (QA-06)', () => {
  const evm = { kind: 'evm' as const, origin: 'base' as const };
  test('choosing another chain while connected through MetaMask reconnects; otherwise nothing', () => {
    expect(shouldReconnectOnOrigin(evm, 'arb')).toBe(true);
    expect(shouldReconnectOnOrigin(evm, 'base')).toBe(false);
    expect(shouldReconnectOnOrigin({ kind: 'phantom', origin: 'sol' }, 'arb')).toBe(false);
    expect(shouldReconnectOnOrigin(null, 'arb')).toBe(false);
  });
  test('the "Funds come from" choice is hidden on pages that never deposit', () => {
    expect(renderToString(<WalletPicker signer={null} onConnect={() => {}} />)).toContain('Funds come from');
    expect(renderToString(<WalletPicker signer={null} onConnect={() => {}} showOrigin={false} />)).not.toContain('Funds come from');
  });
});
