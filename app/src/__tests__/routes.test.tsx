import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../App';

// First render of every route (effects do not run in a server render, so no network is touched).
function render(hash: string): string {
  vi.stubGlobal('window', { location: { hash }, addEventListener: () => {}, removeEventListener: () => {} });
  return renderToString(<App />);
}

afterEach(() => vi.unstubAllGlobals());

describe('every route mounts', () => {
  const ROUTES: [string, string][] = [
    ['#/', 'Loading sales…'],
    ['#/?rec=1', 'Loading sales…'],
    ['#/?at=live', 'Loading sales…'],
    ['#/trust', 'Who can see your bid.'],
    ['#/sales', 'Loading sales…'],
    ['#/sale/1', 'Loading sale…'],
    ['#/bid/1', 'Bid on sale #'],
    ['#/bid/1?mode=fund', 'Bid on sale #'],
    ['#/try', 'Try signing (free)'],
    ['#/keys', 'Loading key ledger…'],
    ['#/withdraw', 'Withdraw'],
  ];
  for (const [hash, text] of ROUTES) {
    test(hash, () => {
      const html = render(hash);
      expect(html).toContain(text);
      expect(html).toContain('Privacy rests on NEAR'); // the trust line is on every page
      expect(html).not.toContain('Not found');
    });
  }

  test('unknown routes and non-numeric sale ids are NotFound', () => {
    for (const hash of ['#/nope', '#/sale/abc', '#/bid/1x', '#/sale/1/extra']) {
      const html = render(hash);
      expect(html, hash).toContain('Not found');
      expect(html, hash).toContain('Back to the home page');
    }
  });
});
