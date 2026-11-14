import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-finalized.json';
import { Layout } from '../components/Layout';
import type { SaleRow } from '../lib/loaders';
import { parseResult, parseSale } from '../lib/views';
import { SalesView } from '../pages/Sales';
import { TwinView } from '../pages/Twin';

const NEVER_REQUESTED = 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';

const s0 = parseSale(sale0);
const s1 = parseSale(sale1);
const result1 = parseResult({ p_star: '3600000', sold: '3000000000000000000000000', seller_usdc: '10800001', block: '1600', ns: '1794535900000000000' });
// Oldest first, as get_sales returns them: the page puts the newest first.
const ROWS: SaleRow[] = [
  { sale: s0, result: null },
  { sale: s1, result: result1 },
];
const NOW = s1.closeNs + 60_000_000_000n;

describe('#/sales', () => {
  test('both sales render newest first, each linked to its sale page, with honest labels', () => {
    const html = renderToString(<SalesView rows={ROWS} error={null} loading={false} nowNs={NOW} />);
    expect(html).toContain('Sales on NEAR mainnet.');
    expect(html).toContain('2 sales on <span class="mono">v1.tenderseal.near</span>, newest first. All are team-funded demo sales so far.');
    const i1 = html.indexOf('>Sale #1<');
    const i0 = html.indexOf('>Sale #0<');
    expect(i1).toBeGreaterThan(-1);
    expect(i0).toBeGreaterThan(i1);
    expect(html).toContain('href="#/sale/1"');
    expect(html).toContain('href="#/sale/0"');
    // The cancelled sale carries the pinned label once; the finalized one shows its clearing price and no such label.
    expect(html.split(NEVER_REQUESTED).length - 1).toBe(1);
    expect(html.indexOf(NEVER_REQUESTED)).toBeGreaterThan(i0);
    expect(html).toContain('Finalized · sold');
    expect(html.slice(i1, i0)).toContain('clearing price');
    expect(html.slice(i1, i0)).toContain('3.60');
    expect(html.slice(i0)).not.toContain('clearing price');
  });

  test('empty, loading and RPC-error states', () => {
    expect(renderToString(<SalesView rows={[]} error={null} loading={false} nowNs={NOW} />)).toContain('No sales on NEAR mainnet yet.');
    expect(renderToString(<SalesView rows={null} error={null} loading nowNs={NOW} />)).toContain('Loading sales…');
    const err = renderToString(<SalesView rows={null} error="https://free.rpc.fastnear.com: HTTP 502" loading={false} nowNs={NOW} />);
    expect(err).toContain('RPC unavailable, retrying');
    expect(err).not.toContain('No sales on NEAR');
  });

  test('the Sales nav item points to #/sales and is current there and on a sale page', () => {
    for (const current of ['/sales', '/sale/:id']) {
      const html = renderToString(<Layout current={current}>{null}</Layout>);
      expect(html, current).toContain('href="#/sales" aria-current="page"');
    }
    expect(renderToString(<Layout current="/">{null}</Layout>)).not.toContain('aria-current="page"');
  });

  test('the home page live section links to every sale', () => {
    const html = renderToString(<TwinView bundles={[{ id: '1', sale: s1, bids: [] }, { id: '0', sale: s0, bids: [] }]} nowNs={NOW} />);
    expect(html).toContain('href="#/sales">All sales');
  });
});
