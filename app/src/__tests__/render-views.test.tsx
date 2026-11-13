import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import keyLog from '../__fixtures__/views/key-log.json';
import receipts from '../__fixtures__/views/nearblocks-receipts.json';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { SaleCard } from '../components/SaleCard';
import { loadKeys, loadSaleBundle, type SaleBundle } from '../lib/loaders';
import { parseBid, parseSale } from '../lib/views';
import { KeysView } from '../pages/Keys';
import { SaleView } from '../pages/Sale';
import { HomeView } from '../pages/Home';
import { TwinView } from '../pages/Twin';

const NEVER_REQUESTED = 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';
const KEYS_LINE = 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';

const s0 = parseSale(sale0);
const s1 = parseSale(sale1);
const bundle1: SaleBundle = { id: '1', sale: s1, bids: bids1.map(parseBid) };
const bundle0: SaleBundle = { id: '0', sale: s0, bids: [parseBid(bids1[0])] };
const NOW = s1.closeNs + 60_000_000_000n;

// Page text the honest-claims rule forbids anywhere in the app.
const FORBIDDEN = /succeeds|10 of 15|10-of-15|first to|nobody, including us|sealed forever|sealed launch|JAMBO launch/i;

describe('twin view', () => {
  test('Cancelled sale with 0 key requests carries the never-requested label, the Keyed sale does not', () => {
    const html = renderToString(<TwinView bundles={[bundle1, bundle0]} nowNs={NOW} />);
    expect(html.split(NEVER_REQUESTED).length - 1).toBe(1);
    const card1 = renderToString(<SaleCard id="1" sale={s1} nowNs={NOW} />);
    expect(card1).not.toContain('never requested');
    expect(card1).toContain('Keyed');
  });

  test('closed sale below its thresholds shows the failed open conditions', () => {
    const open0 = { ...s0, state: 'Open' as const };
    const html = renderToString(<SaleCard id="0" sale={open0} nowNs={NOW} />);
    expect(html).toContain('Open conditions not met');
    expect(html).not.toContain('never requested');
  });

  test('shows 6 and 1 sealed bids with self-declared origin badges, OPEN_RULE and the verify line', () => {
    const html = renderToString(<TwinView bundles={[bundle1, bundle0]} nowNs={NOW} />);
    expect(html).toContain('via Base (self-declared)');
    expect(html).toContain('via Solana (self-declared)');
    expect(html).toContain('total escrow ≥ min_escrow and distinct bidders ≥ min_bidders');
    expect(html).toContain('pnpm verify --keys');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('the whole home page: the pinned label once, the open rule, and no forbidden words', () => {
    const html = renderToString(<HomeView data={[bundle1, bundle0]} error={null} loading={false} nowNs={NOW} />);
    expect(html.split(NEVER_REQUESTED).length - 1).toBe(1);
    expect(html).toContain('total escrow ≥ min_escrow and distinct bidders ≥ min_bidders');
    expect(html).toContain('pnpm seal:bid'); // the hosted-page exception sits next to what we cannot do
    expect(html).toContain('ever held');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('a sale that does not exist yet renders a placeholder', () => {
    const html = renderToString(<TwinView bundles={[{ id: '1', sale: null, bids: [] }, { id: '0', sale: null, bids: [] }]} nowNs={NOW} />);
    expect(html).toContain('Sale #1 · not created yet');
    expect(html).toContain('Sale #0 · not created yet');
  });

  test('one shared countdown when both close times are equal', () => {
    const html = renderToString(<TwinView bundles={[bundle1, bundle0]} nowNs={s1.closeNs - 5_000_000_000n} />);
    expect(html.split('class="countdown"').length - 1).toBe(1);
    expect(html).toContain('00:00:05');
  });

  test('sale page lists the ciphertext wall with truncated ciphertext only', () => {
    const html = renderToString(<SaleView bundle={bundle1} nowNs={NOW} />);
    expect(html.split('class="cipher ').length - 1).toBe(6);
    expect(html).not.toContain(bids1[0]!.ct); // full ciphertext is never printed
  });
});

describe('a dead key request (C-02)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const opening = { ...s1, state: 'Opening' as const, key: null, inFlight: true, keyRequests: 1, revealDeadlineNs: null };
  const sent = s1.closeNs + 10_000_000_000n;
  test('an hour after the request the sale page offers Open again; before that it only says the request is in flight', () => {
    const page = (nowNs: bigint) => renderToString(<SaleView bundle={{ id: '1', sale: opening, bids: [], keyRequestNs: sent }} nowNs={nowNs} />);
    expect(page(sent + 3_599_000_000_000n)).not.toContain('Open (anyone)');
    const late = page(sent + 3_600_000_000_000n);
    expect(late).toContain('Open (anyone)');
    expect(late).toContain('no answer within an hour');
  });
  test('the bundle of an in-flight sale carries the time of its pending key request', async () => {
    const raw = { ...sale1, state: 'Opening', key: null, in_flight: true, reveal_deadline_ns: null };
    const log = [{ i: '0', sale: '1', block: '5', ns: String(sent), outcome: 'Pending', resolved_block: null }];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const { method, params } = JSON.parse(init.body) as { method: string; params: { method_name?: string } };
      if (method === 'block') return Response.json({ jsonrpc: '2.0', id: 'tender', result: { header: { height: 7, timestamp_nanosec: '1' } } });
      const out = params.method_name === 'get_sale' ? raw : params.method_name === 'get_key_log' ? log : [];
      return Response.json({ jsonrpc: '2.0', id: 'tender', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(out))) } });
    });
    expect((await loadSaleBundle('1')).keyRequestNs).toBe(sent);
  });
});

describe('key ledger view', () => {
  afterEach(() => vi.unstubAllGlobals());

  function rpcBytes(value: unknown) {
    return { jsonrpc: '2.0', id: 'tender', result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) } };
  }

  function stubNetwork(nearblocks: Response | (() => Response)) {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).includes('nearblocks')) return typeof nearblocks === 'function' ? nearblocks() : nearblocks;
      const body = JSON.parse(String(init?.body)) as { params: { method_name: string } };
      const views: Record<string, unknown> = { version: '3.18.0', get_key_log: keyLog, get_sales: [sale0, sale1] };
      return new Response(JSON.stringify(rpcBytes(views[body.params.method_name])), { status: 200 });
    });
  }

  test('lists the ledger, the per-sale summary and the matching NearBlocks receipt', async () => {
    stubNetwork(new Response(JSON.stringify(receipts), { status: 200 }));
    const html = renderToString(<KeysView data={await loadKeys()} />);
    expect(html).toContain(KEYS_LINE);
    expect(html).toContain('1 key request · key public');
    expect(html).toContain('version <strong>3.18.0</strong>');
    expect(html).toContain('NearBlocks: 1 receipt (match)');
    expect(html).not.toContain('not indexed yet');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('an Err entry says what Err can mean, including a key the contract refused after the pairing check (X12F-01)', async () => {
    stubNetwork(new Response(JSON.stringify(receipts), { status: 200 }));
    const data = await loadKeys();
    const none = renderToString(<KeysView data={data} />);
    expect(none).not.toContain('pairing check');
    const err = { ...data, rows: data.rows.map((r) => ({ ...r, entry: { ...r.entry, outcome: 'Err' as const } })) };
    const html = renderToString(<KeysView data={err} />);
    expect(html).toContain('pairing check');
    expect(html).toContain('Nothing was stored');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('NearBlocks rate limit: warning shown, the contract ledger still renders', async () => {
    stubNetwork(new Response('rate limited', { status: 429 }));
    const html = renderToString(<KeysView data={await loadKeys()} />);
    expect(html).toContain('NearBlocks unavailable (rate limit) · state ledger shown');
    expect(html).toContain(KEYS_LINE);
    expect(html).toContain('not indexed yet');
    expect(html).toContain('NearBlocks: 0 receipts (unavailable)');
  });
});
