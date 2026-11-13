/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import sale1f from '../__fixtures__/views/sale-1-finalized.json';
import config1 from '../__fixtures__/views/config.json';
import type { SaleBundle } from '../lib/loaders';
import { parseBid, parseConfig, parseResult, parseSale } from '../lib/views';
import { SaleView } from '../pages/Sale';

const NEVER_REQUESTED = 'Cancelled · 0 key requests · never requested (sealed unless the MPC threshold colludes)';
const FORBIDDEN = /succeeds|no tee|10 of 15|10-of-15|first to|nobody, including us|sealed forever|sealed launch|JAMBO launch/i;

const keyed = parseSale(sale1);
const bids = bids1.map(parseBid);
const NOW = keyed.closeNs + 60_000_000_000n;
const cfg = parseConfig(config1);

const demo = JSON.parse(readFileSync(new URL('../../../fixtures/clearing/demo-sale-1.json', import.meta.url), 'utf8')) as {
  bids: { idx: number; B: string; p: string; q: string; state: string }[];
  expected: { P_star: string; alloc: string[]; spend: string[]; penalty: string[]; penalty_share: string[]; seller_usdc: string; seller_tokens_back: string; dust: string };
};
const e = demo.expected;
const finalBids = demo.bids.map((b, i) =>
  parseBid({
    idx: b.idx, bidder: `0x00000000000000000000000000000000000${i}1111`, escrow: b.B, ct: '', cm: '', block: '1', ns: '1', state: b.state, p: b.p, q: b.q,
    alloc: e.alloc[i], spend: e.spend[i], penalty: e.penalty[i], penalty_share: e.penalty_share[i], paid: { usdc: '1', tokens: '0', ok: true },
  }),
);
const finalResult = parseResult({
  p_star: e.P_star, sold: '3000000000000000000000000', seller_usdc: e.seller_usdc, seller_tokens_back: e.seller_tokens_back, token_dust: e.dust, penalty_pool: '0', block: '2', ns: '2', cancelled: false,
})!;

const render = (bundle: SaleBundle, nowNs = NOW) => renderToString(<SaleView bundle={bundle} nowNs={nowNs} cfg={cfg} />);

describe('sale page panels', () => {
  test('Keyed sale offers decrypt and reveal, never the cancel label', () => {
    const html = render({ id: '1', sale: keyed, bids });
    expect(html).toContain('Decrypt all bids in this browser');
    expect(html).toContain('Reveal all (NEAR wallet, gas)');
    expect(html).toContain('Reveal my bid (gasless)');
    expect(html).toContain('released at block');
    expect(html).not.toContain('never requested');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('Open sale after close with the public conditions met offers Open (anyone) and no Cancel', () => {
    const open = { ...keyed, state: 'Open' as const, key: null, keyRequests: 0, escrowTotal: 60_000_000n, bidders: 4 };
    const html = render({ id: '1', sale: open, bids });
    expect(html).toContain('Open (anyone)');
    expect(html).not.toContain('Cancel (anyone)');
    expect(html).not.toContain('Decrypt all bids');
  });

  test('Open sale after close with failed conditions offers Cancel (anyone) and the reason, no Open', () => {
    const open = { ...parseSale(sale0), state: 'Open' as const, keyRequests: 0 };
    const html = render({ id: '0', sale: open, bids: [bids[0]!] }, open.closeNs + 1_000n);
    expect(html).toContain('Cancel (anyone)');
    expect(html).toContain('Open conditions not met');
    expect(html).not.toContain('Open (anyone)');
  });

  test('before close neither Open nor Cancel is offered', () => {
    const open = { ...keyed, state: 'Open' as const, key: null, keyRequests: 0 };
    const html = render({ id: '1', sale: open, bids }, open.closeNs - 1_000_000_000n);
    expect(html).not.toContain('Open (anyone)');
    expect(html).not.toContain('Cancel (anyone)');
  });

  test('Cancelled sale with 0 key requests: the label once, refunds in full, no decrypt panel', () => {
    const html = render({ id: '0', sale: parseSale(sale0), bids: [bids[0]!] });
    expect(html.split(NEVER_REQUESTED).length - 1).toBe(1);
    expect(html).toContain('Every bid is refunded in full');
    expect(html).not.toContain('Decrypt all bids');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('Finalized sale shows the result table, the recompute match and the chart', () => {
    const sale = parseSale(sale1f);
    const html = render({ id: '1', sale, bids: finalBids, result: finalResult });
    expect(html).toContain('Recomputed in your browser: match');
    expect(html).toContain('data-testid="pstar-value"');
    expect(html).toContain('3.6');
    expect(html).toContain('data-testid="pstar"');
    expect(html).toContain('marginal');
    expect(html).not.toContain('Reveal all');
    expect(html).not.toMatch(FORBIDDEN);
  });

  test('the rows at the clearing price are named in text, not only set in bold (X12A-09)', () => {
    const html = render({ id: '1', sale: parseSale(sale1f), bids: finalBids, result: finalResult });
    expect(html).toContain('class="row-pstar"');
    expect(html).toContain('bid at the clearing price P*');
  });

  test('a stored result that disagrees with the recomputation shows the difference table', () => {
    const sale = parseSale(sale1f);
    const html = render({ id: '1', sale, bids: finalBids, result: { ...finalResult, sellerUsdc: finalResult.sellerUsdc + 1n } });
    expect(html).toContain('the result differs');
    expect(html).toContain('seller_usdc');
  });
});
