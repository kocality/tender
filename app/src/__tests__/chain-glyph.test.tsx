import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { ChainGlyph } from '../components/ChainGlyph';

// A bid's origin is self-declared on chain, so any string reaches ChainGlyph: names of Object.prototype keys must get
// the neutral mark, not a crash. Two Solana marks on one page must not share one gradient id.

describe('ChainGlyph', () => {
  test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('origin %s renders the neutral mark with its label', (origin) => {
    const html = renderToString(<ChainGlyph chain={origin} label="origin not declared" />);
    expect(html).toContain('aria-label="origin not declared"');
    expect(html).toContain('viewBox="0 0 12 12"');
  });

  test('each Solana mark carries its own gradient id', () => {
    const html = renderToString(
      <>
        <ChainGlyph chain="sol" />
        <ChainGlyph chain="sol" />
      </>,
    );
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`fill="url(#${id})"`);
  });
});
