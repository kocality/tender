import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { CancelledCard } from '../components/CancelledCard';
import { UNRECOVERABLE_TRANSFER } from '../copy';
import { validateBid } from '../lib/bidFlow';
import { parseBid, parseSale } from '../lib/views';
import { BidView } from '../pages/Bid';

const text = (html: string) => html.replace(/<!-- -->/g, '');
const bids = bids1.map(parseBid);
const keyed = parseSale(sale1);

describe('refund copy (SC-06)', () => {
  test('a Cancelled sale says where the refund lands, that Withdraw moves it and that 1Click fees are not refunded', () => {
    const html = text(renderToString(<CancelledCard sale={parseSale(sale0)} bids={[bids[0]!]} />));
    expect(html).toContain('Every bid is refunded in full');
    expect(html).toContain('to each bidder&#x27;s NEAR Intents account');
    expect(html).toContain('href="#/withdraw"');
    expect(html).toContain('1Click fees are not refunded');
  });

  test('the below-reserve warning says the refund comes once the bid is revealed', () => {
    const r = validateBid({ priceText: '1', sizeText: '3', escrowText: '5', sale: { state: 'Open', closeNs: 2_000n, reserve: 3_000_000n, lotExp: 0 }, nowNs: 1n });
    expect(r.ok && r.warnings[0]).toContain('refunded in full once it is revealed');
  });
});

describe('unrecoverable transfers (C-07)', () => {
  test('the bid page warns that a plain Intents transfer to the contract cannot be recovered', () => {
    const open = { ...keyed, state: 'Open' as const, key: null, bids: 1, closeNs: keyed.closeNs + 3_600_000_000_000n };
    const html = text(renderToString(<BidView id="1" data={{ id: '1', sale: open, bids }} error={null} loading={false} nowNs={keyed.closeNs} synced fundOnly={false} />));
    expect(html).toContain('cannot be recovered');
    expect(html).toContain('no admin method');
    expect(UNRECOVERABLE_TRANSFER).toContain('pnpm seal:bid');
  });
});
