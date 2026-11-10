/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { SupplyDemandChart } from '../components/SupplyDemandChart';
import { parseBid, parseSale } from '../lib/views';
import sale1 from '../__fixtures__/views/sale-1-finalized.json';

const demo = JSON.parse(readFileSync(new URL('../../../fixtures/clearing/demo-sale-1.json', import.meta.url), 'utf8')) as {
  bids: { idx: number; B: string; p: string; q: string; state: string }[];
};
const sale = parseSale(sale1);
const bids = demo.bids.map((b) =>
  parseBid({ idx: b.idx, bidder: 'x.near', escrow: b.B, ct: '', cm: '', block: '1', ns: '1', state: b.state, p: b.p, q: b.q, alloc: '0', spend: '0', penalty: '0', penalty_share: '0' }),
);

const yOf = (html: string, cls: string): number => {
  const m = new RegExp(`<line[^>]*class="${cls}"[^>]*y1="([\\d.]+)"`).exec(html) ?? new RegExp(`<line[^>]*y1="([\\d.]+)"[^>]*class="${cls}"`).exec(html);
  if (!m) throw new Error(`no ${cls} line`);
  return Number(m[1]);
};

describe('SupplyDemandChart', () => {
  const html = renderToString(<SupplyDemandChart sale={sale} bids={bids} pStar={3_600_000n} />);
  test('is an inline svg with an accessible summary of the clearing price', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('role="img"');
    expect(html).toContain('Clearing price 3.6 USDC per');
  });
  test('the P* line sits above the reserve line (smaller y)', () => {
    expect(html).toContain('data-testid="pstar"');
    expect(yOf(html, 'pstar')).toBeLessThan(yOf(html, 'reserve'));
  });
  test('no clearing price: no P* line', () => {
    const none = renderToString(<SupplyDemandChart sale={sale} bids={[]} pStar={null} />);
    expect(none).not.toContain('data-testid="pstar"');
    expect(none).toContain('no bid cleared');
  });
});
