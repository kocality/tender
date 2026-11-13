import { clear } from '@tender/clearing';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ExampleSale } from '../components/ExampleSale';
import { HERO_EXAMPLE, networkStatus } from '../copy';
import { RollingNumber } from '../components/RollingNumber';
import { StatTile } from '../components/StatTile';
import DecryptedText from '../fx/DecryptedText';

// The home page's example card: it is labelled EXAMPLE, its numbers clear to the price it shows, and without motion
// (no IntersectionObserver here, or reduced motion) it shows its last state at once. Sealed values never reach the page.

const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'").replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const micro = (usdc: string) => BigInt(Math.round(Number(usdc) * 1e6));

afterEach(() => vi.unstubAllGlobals());

describe('the example numbers', () => {
  test('clearing the example with @tender/clearing gives the price the card shows, Bea and the NEAR bidder win, Sam is out', () => {
    const r = clear(
      { S: BigInt(Number(HERO_EXAMPLE.supply) * 10) * 10n ** 23n, decimals: 24, lot_exp: 0, reserve: micro(HERO_EXAMPLE.reserve) },
      HERO_EXAMPLE.bids.map((b, idx) => ({ idx, B: micro(b.deposit), p: micro(b.price), q: micro(b.size), state: 'Revealed' as const })),
    );
    expect(r.P_star).toBe(micro(HERO_EXAMPLE.clearing));
    const winners = r.alloc.flatMap((a, i) => (a > 0n ? [i] : []));
    expect(winners).toEqual([...HERO_EXAMPLE.winners]);
  });

  test('the example meets the public conditions it implies (deposits and bidders)', () => {
    const total = HERO_EXAMPLE.bids.reduce((a, b) => a + Number(b.deposit), 0);
    expect(total).toBeGreaterThanOrEqual(Number(HERO_EXAMPLE.minEscrow));
    expect(HERO_EXAMPLE.bids.length).toBeGreaterThanOrEqual(HERO_EXAMPLE.minBidders);
  });
});

describe('the example card without motion', () => {
  test('ending "opened": the end state at once, labelled EXAMPLE, prices open, one price, the key released', () => {
    const t = text(renderToString(<ExampleSale />));
    expect(t).toContain('Example');
    expect(t).toContain('key released');
    expect(renderToString(<ExampleSale />)).toContain('Step 5 of 5: Settled'); // the rail's name; the visible step name steps aside
    for (const b of HERO_EXAMPLE.bids) expect(t).toContain(b.price);
    expect(t).toContain(`${HERO_EXAMPLE.clearing} USDC · one price`);
  });

  test('the column headers sit over their columns: four header cells for the four cells of a row, Price over the prices', () => {
    const html = renderToString(<ExampleSale />);
    expect(html).toMatch(/<div class="excard-cols"[^>]*><span><\/span><span><\/span><span>Deposit<\/span><span>Price<\/span><\/div>/);
    const row = /<div class="exrow[^"]*">([\s\S]*?)<\/div>/.exec(html)![1]!;
    expect(row.match(/<span class="(dep|price) mono">/g)).toEqual(['<span class="dep mono">', '<span class="price mono">']);
  });

  test('ending "cancelled": key never requested, no key glyph, prices stay sealed, no price set', () => {
    const html = renderToString(<ExampleSale ending="cancelled" />);
    const t = text(html);
    expect(t).toContain('key never requested');
    expect(t).toContain('Cancelled');
    expect(html).not.toContain('key-glyph');
    expect(t).not.toContain('one price');
    for (const b of HERO_EXAMPLE.bids) expect(t).not.toContain(b.price);
  });

  test('under reduced motion, in a browser with IntersectionObserver, it still starts at its end state', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    vi.stubGlobal('IntersectionObserver', class {});
    expect(text(renderToString(<ExampleSale />))).toContain(`${HERO_EXAMPLE.clearing} USDC · one price`);
  });

  test('with motion it starts sealed: no price on the page until it plays', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('IntersectionObserver', class {});
    const html = renderToString(<ExampleSale />);
    for (const b of HERO_EXAMPLE.bids) expect(text(html)).not.toContain(b.price);
    expect(html).toContain('aria-label="price sealed"');
  });

  test('the card describes, for a screen reader, who asks for the key and when', () => {
    expect(renderToString(<ExampleSale />)).toMatch(/aria-describedby="excard-desc"[\s\S]*id="excard-desc" hidden=""[^>]*>[^<]*The locked sale contract is the only account/);
  });
});

describe('sealed values and chain numbers', () => {
  test('a sealed value draws glyphs only: its text is nowhere in the page, not even hidden', () => {
    const html = renderToString(<DecryptedText text="3.90" revealed={false} />);
    expect(html).not.toContain('3.90');
    expect(html).not.toMatch(/[0-9]/);
    expect(renderToString(<DecryptedText text="3.90" revealed />)).toContain('3.90');
  });

  test('a rolling number renders as plain text (one word for a reader), never as digit strips at rest', () => {
    const html = renderToString(<RollingNumber value="4.00" />);
    expect(html).toContain('>4.00<');
    expect(html).not.toContain('roll-d');
  });

  test('a rounded tile says so on its face (≈); an exact one does not', () => {
    expect(text(renderToString(<StatTile value="1.80" exact="1.800001" label="seller receives" />))).toContain('≈');
    expect(text(renderToString(<StatTile value="0.50" exact="0.5" label="sold" />))).not.toContain('≈');
    expect(text(renderToString(<StatTile value="10" exact="10" label="sold" />))).not.toContain('≈');
  });

  test('the settled example shows its price as static text, never as a moving number', () => {
    const html = renderToString(<ExampleSale play={false} />);
    expect(html).toContain(`>${HERO_EXAMPLE.clearing}<`);
    expect(html).not.toContain('rolling');
  });
});

describe('the network badge', () => {
  test('mainnet claims "Live" only once the contract has answered', () => {
    expect(networkStatus('mainnet', false).badge).toBe('Live on NEAR mainnet');
    expect(networkStatus('mainnet', null).badge).not.toMatch(/live/i);
    expect(networkStatus('mainnet', true).badge).toBe('Mainnet · not live');
    expect(networkStatus('testnet').badge).toBe('Testnet · test tokens only');
  });

  test('its popover is in the page from the start: plain words on top, the testnet copy and the exact trust line in the footer badge', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_NETWORK', 'testnet');
    vi.stubEnv('VITE_INTENTS_CONTRACT_ID', 'intents-09bdfe.testnet');
    try {
      const { NetworkBadge } = await import('../components/NetworkBadge');
      const top = text(renderToString(<NetworkBadge />));
      expect(top).toContain('Testnet · test tokens only');
      expect(top).toContain('Test tokens only, no real money. No audit, and our team is the seller in every sale.');
      expect(top).toContain('11 of the computers that hold, or ever held');
      expect(top).not.toContain('intents-09bdfe.testnet'); // ids and versions sit in the footer badge, on every page
      const foot = text(renderToString(<NetworkBadge up />));
      expect(foot).toContain('NEAR Intents here is our own testnet copy, intents-09bdfe.testnet');
      expect(foot).toContain('Privacy rests on NEAR');
      expect(foot).toContain('Resharing does not revoke old shares');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
