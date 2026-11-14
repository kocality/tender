import { renderToString } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

// The contract answered on mainnet: the badge may claim "live", and with it the keyless lock.
vi.mock('../lib/contractStatus', () => ({ useContractMissing: () => false }));

import { Layout } from '../components/Layout';
import { NetworkBadge } from '../components/NetworkBadge';
import { config } from '../config';
import { networkStatus } from '../copy';

const LOCK_TX = 'https://nearblocks.io/txns/9FQuPMpJFNYJgv7dm2yyWxaUmTT73U4c9TJ9xFqMXHs3';

describe('the keyless lock (mainnet defaults)', () => {
  test('config carries the birth transaction of v1.tenderseal.near', () => {
    expect(config.network).toBe('mainnet');
    expect(config.lockTx).toBe('9FQuPMpJFNYJgv7dm2yyWxaUmTT73U4c9TJ9xFqMXHs3');
  });

  test('the live pill shows the keyless claim; before the contract answers, or when it is missing, it claims nothing', () => {
    const html = renderToString(<NetworkBadge />);
    expect(html).toContain('Locked on mainnet: 0 access keys, not even ours');
    expect(html).toContain('Live on NEAR mainnet · locked'); // its phone form
    expect(html).toContain('v1.tenderseal.near has 0 access keys, not even ours');
    expect(html).toContain(`href="${LOCK_TX}"`);
    expect(html).not.toMatch(/trustless|unhackable/i);
    expect(networkStatus('mainnet', null).lock).toBeUndefined();
    expect(networkStatus('mainnet', true).lock).toBeUndefined();
    expect(networkStatus('testnet').lock).toBeUndefined();
  });

  test('"Lock tx ↗" opens the lock transaction in a new tab, in the nav and in the phone menu', () => {
    const html = renderToString(<Layout current="/">{null}</Layout>);
    const links = html.match(new RegExp(`<a href="${LOCK_TX}" target="_blank" rel="noreferrer"[^>]*>Lock tx<span aria-hidden="true"> ↗</span></a>`, 'g')) ?? [];
    // Main nav + phone menu (the footer badge's popover links it too).
    expect(links.length).toBeGreaterThanOrEqual(2);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header.split(`href="${LOCK_TX}"`).length - 1).toBe(3); // the nav, the phone menu and the top-bar pill's popover
    expect(header.indexOf('class="menu-phone"')).toBeLessThan(header.lastIndexOf(LOCK_TX));
  });
});
