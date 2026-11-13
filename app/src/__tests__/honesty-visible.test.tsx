import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import bids1 from '../__fixtures__/views/bids-1.json';
import sale0 from '../__fixtures__/views/sale-0-cancelled.json';
import sale1 from '../__fixtures__/views/sale-1-keyed.json';
import { BidForm } from '../components/BidForm';
import { EYE_GRID, ROLES, twinHeading } from '../copy';
import { parseBid, parseSale } from '../lib/views';
import { BidView } from '../pages/Bid';
import { HomeView } from '../pages/Home';

// What a visitor reads without opening any fold: the exceptions to "sealed", the 10% penalty, and a twin heading that
// only describes what the sales on screen did.

const text = (html: string) =>
  html
    .replace(/<details[\s\S]*?<\/details>/g, '') // folded text does not count as visible
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
const bids = bids1.map(parseBid);
const keyed = parseSale(sale1);
const cancelled = parseSale(sale0);
const open = { ...keyed, state: 'Open' as const, key: null, bids: 1, closeNs: keyed.closeNs + 3_600_000_000_000n };

describe('the bid page states both exceptions and the penalty outside any fold', () => {
  const html = text(renderToString(<BidView id="1" data={{ id: '1', sale: open, bids }} error={null} loading={false} nowNs={keyed.closeNs} synced fundOnly={false} />));
  test('the MPC threshold, with former share holders', () => {
    expect(html).toMatch(/unless 11 of the parties that hold, or ever held, a piece of NEAR's key work together/);
  });
  test('a bad copy of this page, and the local way around it', () => {
    expect(html).toContain('this page is a bad copy that reads your price before sealing it');
    expect(html).toContain('pnpm seal:bid');
  });
  test('the deposit help names the 10% that can stay in the contract', () => {
    const form = text(renderToString(<BidForm sale={open} nowNs={keyed.closeNs} disabled={false} onSubmit={() => {}} />));
    expect(form).toContain('If your bid is never revealed, 10% of this deposit can stay in the contract');
  });
});

describe('the twin heading promises only what happened', () => {
  const NOW = keyed.closeNs + 10n ** 15n;
  test('"never asked for" needs a Cancelled sale with 0 key requests on screen', () => {
    expect(twinHeading([keyed, { ...keyed, id: '2' }], [], NOW, 'testnet').lead).not.toMatch(/never asked for/);
    expect(twinHeading([keyed], ['1'], NOW, 'testnet').lead).not.toMatch(/never asked for/);
    expect(twinHeading([keyed, { ...cancelled, keyRequests: 1 }], [], NOW, 'testnet').lead).not.toMatch(/never asked for/);
    expect(twinHeading([keyed, cancelled], [], NOW, 'testnet').lead).toContain('so its key was never asked for');
  });
  test('"we set the other to miss them" only when the missed sale is one the team configured to miss', () => {
    expect(twinHeading([keyed, cancelled], [cancelled.id], NOW, 'testnet').lead).toContain('we set the other to miss them, so its key was never asked for');
    expect(twinHeading([keyed, cancelled], [], NOW, 'testnet').lead).not.toContain('we set');
  });
  test('a planned miss is worded as a plan, only while that sale still takes bids', () => {
    const planned = { ...open, id: '0' };
    expect(twinHeading([keyed, planned], ['0'], keyed.closeNs, 'testnet').lead).toContain('set up to');
    expect(twinHeading([keyed, { ...planned, state: 'Finalized' as const }], ['0'], NOW, 'testnet').lead).not.toMatch(/never asked for/);
  });
  test('the home page renders the neutral heading for two opened sales', () => {
    const b = (s: typeof keyed, id: string) => ({ id, sale: { ...s, id }, bids: [] });
    const html = text(renderToString(<HomeView data={[b(keyed, '0'), b(keyed, '1')]} error={null} loading={false} nowNs={NOW} />));
    expect(html).toContain('Real sales, read live.');
    expect(html).not.toMatch(/its key (was|is) never asked for/);
  });
});

describe('who sees your price: the seller is us today, so it carries our exception', () => {
  test('the grid gives the seller a lock with that hint, never a plain no', () => {
    const seller = EYE_GRID.find((r) => r.who === 'The seller');
    expect(seller?.price).toBe('lock');
    expect(seller?.hint).toContain('Today the seller is us');
  });
  test('the role text says the same, full and short', () => {
    const seller = ROLES.find((r) => r.who === 'The seller');
    expect(seller?.text).toContain('Today the seller is us');
    expect(seller?.short).toContain('Today the seller is us');
  });
});
